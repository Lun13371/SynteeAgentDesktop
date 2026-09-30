// Захват системного звука с ВЫБРАННОГО устройства вывода (WASAPI loopback
// через vendored NativeAudioSDK) + спектральный анализ в main-процессе.
//
// Раньше захват шёл через Chromium getDisplayMedia loopback — он умеет только
// устройство Windows по умолчанию, и «выбор устройства» приходилось делать
// сменой системного дефолта (IPolicyConfig). Теперь звук берётся напрямую
// с выбранного устройства, системные настройки Windows не трогаются.
//
// Поток: PCM 16-bit -> mono mixdown -> кольцевой буфер 2048 сэмплов ->
// Hann window + radix-2 FFT -> 48 лог-полос (32 Hz..16 kHz, как в настоящих
// спектроанализаторах) -> dB-нормализация + attack/release -> IPC-кадр.
//
// Анализ v2 (починка «слабых частот»):
//  - лог-распределение полос вместо квадратичного: у квадратичного низкие
//    полосы дублировали одни и те же бины (полосы 0..5 все смотрели в бин 0..1),
//    а верхние частоты сжимались в 2-3 широкие полосы;
//  - dB-шкала (как у AnalyserNode getByteFrequencyData): у музыки спектр
//    падает ~1/f, линейные амплитуды давали «мёртвые» верха;
//  - компенсация окна Ханна (coherent gain x4/N) — раньше амплитуды были
//    занижены вдвое;
//  - раздельное сглаживание attack (быстрый подъём) / release (медленный
//    спад) вместо симметричного 0.76/0.24 — реакция стала «панчевой»;
//  - bass/mid/treble для шейдерных эффектов (огонь реагирует на бас и т.п.);
//  - safety-таймер: если поток молчит (нет чанков), кадры всё равно
//    эмитятся с затуханием — визуализатор не «замирает» на последнем кадре.
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
  bass: number
  mid: number
  treble: number
  timestamp: number
  muted: boolean
}

const FFT_SIZE = 2048
const BANDS = 64
const EMIT_INTERVAL_MS = 33 // ~30 кадров/с; рендерер интерполирует до 60
const MIN_HZ = 32
const MAX_HZ = 16000
const MIN_DB = -64
const MAX_DB = -14
const ATTACK = 0.6 // доля к цели при подъёме
const RELEASE = 0.16 // доля к цели при спаде

let controller: AudioControllerInstance | null = null
let format: NativeAudioFormat | null = null
let emitTimer: ReturnType<typeof setInterval> | null = null

const ring = new Float32Array(FFT_SIZE)
let ringPos = 0
let ringFilled = 0
const fftRe = new Float32Array(FFT_SIZE)
const fftIm = new Float32Array(FFT_SIZE)
const smoothed = new Float32Array(BANDS)
let bandEdges = new Int32Array(BANDS + 1) // бины (включительно), BANDS+1 значений
let bassRange: [number, number] = [0, 8] // индексы полос [from, to)
let midRange: [number, number] = [8, 30]
let trebleRange: [number, number] = [30, BANDS]
let lastEmitAt = 0
let lastDataAt = 0
let smoothBass = 0
let smoothMid = 0
let smoothTreble = 0
let smoothLevel = 0

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

/** Лог-полосы от MIN_HZ до MAX_HZ + диапазоны bass/mid/treble в индексах полос. */
function computeBandEdges(sampleRate: number): void {
  const nyquist = sampleRate / 2
  const binHz = sampleRate / FFT_SIZE
  const top = Math.min(MAX_HZ, nyquist * 0.95)
  const edges = new Int32Array(BANDS + 1)
  for (let i = 0; i <= BANDS; i++) {
    const hz = MIN_HZ * Math.pow(top / MIN_HZ, i / BANDS)
    edges[i] = Math.round(hz / binHz)
  }
  // строго возрастающие, минимум 1 бин на полосу
  edges[0] = Math.max(1, edges[0])
  for (let i = 1; i <= BANDS; i++) {
    if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1
    if (edges[i] > FFT_SIZE / 2 - 1) edges[i] = FFT_SIZE / 2 - 1
  }
  bandEdges = edges
  const bandHz = (i: number) => (edges[i] + edges[i + 1]) / 2 * binHz
  let bassEnd = 1
  while (bassEnd < BANDS && bandHz(bassEnd) < 250) bassEnd++
  let midEnd = bassEnd
  while (midEnd < BANDS && bandHz(midEnd) < 2000) midEnd++
  bassRange = [0, bassEnd]
  midRange = [bassEnd, midEnd]
  trebleRange = [midEnd, BANDS]
}

function resetAnalysis(): void {
  ring.fill(0)
  ringPos = 0
  ringFilled = 0
  smoothed.fill(0)
  smoothBass = 0
  smoothMid = 0
  smoothTreble = 0
  smoothLevel = 0
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

  let rms = 0
  for (let i = 0; i < FFT_SIZE; i++) rms += ring[i] * ring[i]
  rms = Math.sqrt(rms / FFT_SIZE)

  const bands = new Array<number>(BANDS)
  for (let i = 0; i < BANDS; i++) {
    // максимум магнитуды по бинам полосы (peak-hold внутри полосы)
    let peak = 0
    for (let j = bandEdges[i]; j < bandEdges[i + 1]; j++) {
      // x4/N — компенсация coherent gain окна Ханна: синус амплитудой 1
      // даёт mag = 1 (0 dB)
      const mag = (4 * Math.hypot(fftRe[j], fftIm[j])) / FFT_SIZE
      if (mag > peak) peak = mag
    }
    // dB-шкала как у AnalyserNode: линейные амплитуды «хоронят» верха
    const db = 20 * Math.log10(peak + 1e-9)
    const target = Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB)))
    // attack/release: быстрый подъём, плавный спад
    const k = target > smoothed[i] ? ATTACK : RELEASE
    smoothed[i] += (target - smoothed[i]) * k
    bands[i] = smoothed[i]
  }

  const avg = (from: number, to: number) => {
    let sum = 0
    for (let i = from; i < to; i++) sum += bands[i]
    return sum / Math.max(1, to - from)
  }
  const bassT = avg(bassRange[0], bassRange[1])
  const midT = avg(midRange[0], midRange[1])
  const trebleT = avg(trebleRange[0], trebleRange[1])
  smoothBass += (bassT - smoothBass) * (bassT > smoothBass ? 0.6 : 0.2)
  smoothMid += (midT - smoothMid) * (midT > smoothMid ? 0.5 : 0.18)
  smoothTreble += (trebleT - smoothTreble) * (trebleT > smoothTreble ? 0.5 : 0.18)

  // RMS ловит тихий/тональный звук, взвешенный спектр — широкий
  const spectrumLevel = smoothBass * 0.9 + smoothMid * 0.55 + smoothTreble * 0.3
  const levelTarget = Math.min(1, Math.max(rms * 5.5, spectrumLevel * 1.15))
  smoothLevel += (levelTarget - smoothLevel) * (levelTarget > smoothLevel ? 0.5 : 0.14)

  const muted = Date.now() - lastDataAt > 400
  sendToWindow(mainWindow, 'audioVisualizer:frame', {
    level: smoothLevel,
    bands,
    bass: smoothBass,
    mid: smoothMid,
    treble: smoothTreble,
    timestamp: Date.now(),
    muted
  } satisfies VisualizerFramePayload)
}

/** Кадр затухания: поток молчит — плавно гасим значения, а не замираем. */
function emitDecayFrame(mainWindow: MainWindow): void {
  if (!controller) return
  for (let i = 0; i < BANDS; i++) smoothed[i] *= 0.82
  smoothBass *= 0.82
  smoothMid *= 0.82
  smoothTreble *= 0.82
  smoothLevel *= 0.82
  sendToWindow(mainWindow, 'audioVisualizer:frame', {
    level: smoothLevel,
    bands: Array.from(smoothed),
    bass: smoothBass,
    mid: smoothMid,
    treble: smoothTreble,
    timestamp: Date.now(),
    muted: true
  } satisfies VisualizerFramePayload)
}

function stopCapture(mainWindow?: MainWindow): void {
  const instance = controller
  controller = null
  format = null
  if (emitTimer) { clearInterval(emitTimer); emitTimer = null }
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
    computeBandEdges(format.sampleRate)
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
    // Safety: если WASAPI перестал слать чанки (тишина/пауза), продолжаем
    // эмитить кадры с затуханием, чтобы визуализатор плавно гас, а не зависал.
    emitTimer = setInterval(() => {
      if (controller && Date.now() - lastDataAt > EMIT_INTERVAL_MS * 2) {
        emitDecayFrame(mainWindow)
      }
    }, EMIT_INTERVAL_MS)
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
