/**
 * useVoiceInput — голосовой ввод в инпут-баре ChatInput.
 *
 * Стейт-машина: idle → requesting-mic → recording → transcribing → idle.
 *
 * Поток:
 *  1. start(): navigator.mediaDevices.getUserMedia({audio:true}) → MediaRecorder
 *     (webm/opus). Копит чанки в стейт 'recording'.
 *  2. stop(): recorder.stop() → Blob → AudioContext resample в 16kHz mono
 *     Float32Array (для локального Whisper) ИЛИ ArrayBuffer webm (для Groq).
 *  3. transcribe(): IPC voice:transcribe (local) или voice:transcribeGroq.
 *  4. Возвращает { text } — рендер анимированно печатает его по словам.
 *
 * Без стриминга — только финальное распознавание после стопа (точнее, без
 * галлюцинаций от коротких interim-клипов).
 */
import { useState, useRef, useCallback, useEffect } from 'react'

export type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

export interface VoiceProgress {
  stage: string
  progress?: number
  message?: string
}

export interface UseVoiceInputResult {
  state: VoiceState
  progress: VoiceProgress | null
  error: string | null
  recordingSec: number
  /** Фоновая загрузка модели (true пока модель качается/инициализируется). */
  modelLoading: boolean
  start: () => Promise<void>
  stop: () => Promise<string>
  cancel: () => void
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
]

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return ''
}

/** Максимальное абсолютное значение амплитуды — для детекта тишины. */
function maxAbs(pcm: Float32Array): number {
  let m = 0
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i])
    if (a > m) m = a
  }
  return m
}

export function useVoiceInput(opts?: {
  provider?: 'local' | 'groq'
  modelSize?: 'tiny' | 'base'
}): UseVoiceInputResult {
  const provider = opts?.provider ?? 'local'
  const modelSize = opts?.modelSize ?? 'tiny'

  const [state, setState] = useState<VoiceState>('idle')
  const [progress, setProgress] = useState<VoiceProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [recordingSec, setRecordingSec] = useState(0)
  const [modelLoading, setModelLoading] = useState(false)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTsRef = useRef<number>(0)
  const progressUnsubRef = useRef<(() => void) | null>(null)

  // Подписка на прогресс инференса из main (для local Whisper). Срабатывает
  // и при фоновом преварме модели.
  useEffect(() => {
    if (provider !== 'local') return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (window as any).syntee
    if (!api?.voice?.onProgress) return
    progressUnsubRef.current = api.voice.onProgress((info: VoiceProgress) => {
      setProgress(info)
      if (info.stage === 'loading-model') {
        setModelLoading(true)
        if (info.progress === 100) setModelLoading(false)
      } else if (info.stage === 'transcribing' || info.stage === 'done') {
        setModelLoading(false)
      } else if (info.stage === 'error') {
        setModelLoading(false)
        setTimeout(() => setProgress(null), 800)
      }
    })
    return () => { progressUnsubRef.current?.() }
  }, [provider])

  const stopTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    recorderRef.current = null
    chunksRef.current = []
  }, [])

  // Декодирует webm Blob → 16kHz mono Float32Array через AudioContext.
  const decodeToPcm16k = useCallback(async (blob: Blob): Promise<Float32Array> => {
    const arrayBuf = await blob.arrayBuffer()
    const AC: typeof AudioContext = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new AC({ sampleRate: 16000 })
    audioCtxRef.current = ctx
    try {
      const audioBuf = await ctx.decodeAudioData(arrayBuf)
      const ch0 = audioBuf.getChannelData(0)
      return new Float32Array(ch0)
    } finally {
      try { ctx.close() } catch { /* ignore */ }
      audioCtxRef.current = null
    }
  }, [])

  const start = useCallback(async () => {
    if (state !== 'idle' && state !== 'error') return
    setError(null)
    setProgress(null)
    setState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      streamRef.current = stream
      const mime = pickMime()
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
      recorderRef.current = rec
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.start(100)
      startTsRef.current = Date.now()
      setRecordingSec(0)
      stopTimer()
      timerRef.current = setInterval(() => {
        setRecordingSec(Math.floor((Date.now() - startTsRef.current) / 1000))
      }, 500)
      setState('recording')
      console.log('[useVoiceInput] recording started, mime=%s tracks=%d', mime || rec.mimeType, stream.getAudioTracks().length)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Не удалось получить доступ к микрофону'
      console.error('[useVoiceInput] getUserMedia FAILED:', e)
      setError(msg)
      setState('error')
      cleanupStream()
    }
  }, [state, cleanupStream, stopTimer])

  const stop = useCallback(async (): Promise<string> => {
    if (state !== 'recording') return ''
    stopTimer()
    const rec = recorderRef.current
    if (!rec) { cleanupStream(); setState('idle'); return '' }

    setState('transcribing')
    setProgress({ stage: 'transcribing', message: 'Распознавание...' })

    const stopped: Promise<Blob> = new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        resolve(blob)
      }
    })
    try {
      rec.stop()
    } catch { /* already stopped */ }
    const blob = await stopped
    cleanupStream()
    console.log('[useVoiceInput] stopped: blob size=%d, chunks=%d', blob.size, chunksRef.current.length)

    try {
      if (provider === 'groq') {
        const ab = await blob.arrayBuffer()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).syntee
        const text = (await api.voice.transcribeGroq(ab)) as string
        console.log('[useVoiceInput] groq result: %j (%d chars)', text, text.length)
        setProgress({ stage: 'done' })
        setTimeout(() => setProgress(null), 600)
        setState('idle')
        return text
      } else {
        const pcm = await decodeToPcm16k(blob)
        console.log('[useVoiceInput] pcm ready: %d samples (%.2fs), max abs=%.4f', pcm.length, pcm.length / 16000, maxAbs(pcm))
        if (pcm.length < 1600) {
          throw new Error('Запись слишком короткая (<0.1с) — говорите дольше')
        }
        if (maxAbs(pcm) < 0.01) {
          throw new Error('Аудио тишина — проверьте микрофон / уровень громкости')
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api = (window as any).syntee
        const text = (await api.voice.transcribe(pcm, { modelSize })) as string
        console.log('[useVoiceInput] whisper result: %j (%d chars)', text, text.length)
        setProgress({ stage: 'done' })
        setTimeout(() => setProgress(null), 600)
        setState('idle')
        return text
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка распознавания'
      console.error('[useVoiceInput] transcribe FAILED:', e)
      setError(msg)
      setProgress({ stage: 'error', message: msg })
      setTimeout(() => setProgress(null), 2500)
      setState('error')
      return ''
    }
  }, [state, cleanupStream, provider, modelSize, stopTimer, decodeToPcm16k])

  const cancel = useCallback(() => {
    stopTimer()
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try { recorderRef.current.stop() } catch { /* ignore */ }
    }
    cleanupStream()
    setProgress(null)
    setError(null)
    setRecordingSec(0)
    setState('idle')
  }, [cleanupStream, stopTimer])

  // Cleanup при unmount.
  useEffect(() => {
    return () => {
      stopTimer()
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop() } catch { /* ignore */ }
      }
      cleanupStream()
      if (audioCtxRef.current) { try { audioCtxRef.current.close() } catch { /* ignore */ } }
      progressUnsubRef.current?.()
    }
  }, [cleanupStream, stopTimer])

  // Авто-сброс error → idle через 3.5с (чтобы бейдж ошибки не висел вечно).
  useEffect(() => {
    if (state !== 'error') return
    const t = setTimeout(() => {
      setError(null)
      setProgress(null)
      setState('idle')
    }, 3500)
    return () => clearTimeout(t)
  }, [state])

  return { state, progress, error, recordingSec, modelLoading, start, stop, cancel }
}
