// Захват системного звука с ВЫБРАННОГО устройства вывода (WASAPI loopback
// через vendored NativeAudioSDK) + спектральный анализ в main-процессе.
//
// Раньше захват шёл через Chromium getDisplayMedia loopback — он умеет только
// устройство Windows по умолчанию, и «выбор устройства» приходилось делать
// сменой системного дефолта (IPolicyConfig). Теперь звук берётся напрямую
// с выбранного устройства, системные настройки Windows не трогаются.
//
// Поток: PCM 16-bit -> mono mixdown -> кольцевой буфер 1024 сэмплов ->
// Hann window + radix-2 FFT -> 48 полос (квадратичное распределение, как в
// прежнем AnalyserNode-варианте) -> IPC 'audioVisualizer:frame' (~22 раза/с).
import { ipcMain } from 'electron'
import type { MainWindow } from '../windows/MainWindow'
import {
  loadNativeAudio,
  type AudioControllerInstance,
  type NativeAudioFormat
} from '../audio/nativeAudio'

export interface VisualizerFramePayload {
  level: number
  bands: number[]
  timestamp: number
  muted: boolean
}

const FFT_SIZE = 1024
const BANDS = 48
const EMIT_INTERVAL_MS = 45

let controller: AudioControllerInstance | null = null
let format: NativeAudioFormat | null = null

const ring = new Float32Array(FFT_SIZE)
let ringPos = 0
let ringFilled = 0
const fftRe = new Float32Array(FFT_SIZE)
const fftIm = new Float32Array(FFT_SIZE)
const smoothed = new Float32Array(FFT_SIZE / 2)
let lastEmitAt = 0
let lastDataAt = 0

function sendToWindow(mainWindow: MainWindow, channel: string, payload: unknown): void {
  try { mainWindow.getWindow()?.webContents.send(channel, payload) } catch { /* window may be closing */ }
}

/** Итеративный radix-2 FFT (in-place, без внешних зависимостей). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr
      const ti = im[i]; im[i] = im[j]; im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    const halfLen = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < halfLen; k++) {
        const ar = re[i + k]
        const ai = im[i + k]
        const br = re[i + k + halfLen] * cr - im[i + k + halfLen] * ci
        const bi = re[i + k + halfLen] * ci + im[i + k + halfLen] * cr
        re[i + k] = ar + br
        im[i + k] = ai + bi
        re[i + k + halfLen] = ar - br
        im[i + k + halfLen] = ai - bi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

function resetAnalysis(): void {
  ring.fill(0)
  ringPos = 0
  ringFilled = 0
  smoothed.fill(0)
  lastEmitAt = 0
  lastDataAt = 0
}

function handlePcmChunk(mainWindow: MainWindow, chunk: Buffer): void {
  lastDataAt = Date.now()
  const channels = Math.max(1, format?.channels ?? 2)
  const frameCount = Math.floor(chunk.length / (2 * channels))
  for (let f = 0; f < frameCount; f++) {
    // mono mixdown всех каналов (7.1 -> 1)
    let sum = 0
    for (let c = 0; c < channels; c++) sum += chunk.readInt16LE((f * channels + c) * 2)
    ring[ringPos] = sum / channels / 32768
    ringPos = (ringPos + 1) % FFT_SIZE
    if (ringFilled < FFT_SIZE) ringFilled++
  }
  const now = Date.now()
  if (now - lastEmitAt >= EMIT_INTERVAL_MS) {
    lastEmitAt = now
    emitFrame(mainWindow)
  }
}

function emitFrame(mainWindow: MainWindow): void {
  if (ringFilled < FFT_SIZE / 2) return // ещё не набрали достаточно сэмплов
  // Упорядочиваем кольцевой буфер + окно Ханна
  for (let i = 0; i < FFT_SIZE; i++) {
    fftRe[i] = ring[(ringPos + i) % FFT_SIZE] * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1))))
  }
  fftIm.fill(0)
  fft(fftRe, fftIm)

  const half = FFT_SIZE / 2
  let rms = 0
  for (let i = 0; i < FFT_SIZE; i++) rms += ring[i] * ring[i]
  rms = Math.sqrt(rms / FFT_SIZE)

  const bands = new Array<number>(BANDS)
  let spectrum = 0
  for (let i = 0; i < BANDS; i++) {
    // Квадратичное распределение бинов по полосам — как в прежнем
    // AnalyserNode-варианте (низкие частоты детальнее).
    const from = Math.floor((i / BANDS) ** 2 * half)
    const to = Math.max(from + 1, Math.floor(((i + 1) / BANDS) ** 2 * half))
    let peak = 0
    for (let j = from; j < to; j++) {
      const mag = Math.hypot(fftRe[j], fftIm[j]) / half
      // сглаживание как smoothingTimeConstant = 0.76
      smoothed[j] = smoothed[j] * 0.76 + mag * 0.24
      if (smoothed[j] > peak) peak = smoothed[j]
    }
    bands[i] = Math.min(1, peak * 3)
    if (i < 28) spectrum += bands[i]
  }
  spectrum /= 28
  // RMS ловит тихий/тональный звук, спектр — широкий; формула прежняя.
  const level = Math.min(1, Math.max(rms * 5, spectrum * 2))
  const muted = Date.now() - lastDataAt > 400
  sendToWindow(mainWindow, 'audioVisualizer:frame', {
    level,
    bands,
    timestamp: Date.now(),
    muted
  } satisfies VisualizerFramePayload)
}

function stopCapture(mainWindow?: MainWindow): void {
  const instance = controller
  controller = null
  format = null
  if (instance) {
    try { instance.stop() } catch { /* уже остановлен */ }
  }
  resetAnalysis()
  if (mainWindow) sendToWindow(mainWindow, 'audioVisualizer:stopped', undefined)
}

export function registerAudioVisualizerIPC(mainWindow: MainWindow): void {
  ipcMain.handle('audioVisualizer:start', (_event, deviceId: unknown) => {
    const wanted = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim() : null
    const AudioController = loadNativeAudio()
    const outputs = AudioController.getDevices().filter(d => d.type === 'output')
    if (outputs.length === 0) throw new Error('Аудиоустройства вывода не найдены')
    const target =
      (wanted ? outputs.find(d => d.id === wanted) : undefined) ||
      outputs.find(d => d.isDefault) ||
      outputs[0]

    // Останавливаем предыдущий захват (native stop синхронный и мгновенный).
    stopCapture()

    format = AudioController.getDeviceFormat(target.id)
    const instance = new AudioController()
    try {
      instance.start({ deviceType: 'output', deviceId: target.id }, (error, data) => {
        if (error) {
          console.error('[audio-visualizer] capture error:', error.message || error)
          if (controller === instance) stopCapture(mainWindow)
          return
        }
        if (data && controller === instance) handlePcmChunk(mainWindow, data)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Не удалось начать захват с «${target.name}»: ${message}`)
    }
    controller = instance
    return {
      deviceId: target.id,
      name: target.name,
      sampleRate: format.sampleRate,
      channels: format.channels
    }
  })

  ipcMain.handle('audioVisualizer:stop', () => {
    stopCapture(mainWindow)
    return true
  })
}

export function stopAudioVisualizerIPC(): void {
  stopCapture()
}
