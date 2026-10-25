// ── UI Sound Engine ─────────────────────────────────────────────
// Два источника звука:
//  1. Встроенные (synth.*) — генерируются через Web Audio API (OscillatorNode).
//  2. Кастомные (custom://...) — файлы mp3/wav/ogg из userData/sounds/,
//     загружаются через IPC sound:load → dataURL → HTMLAudioElement.
//
// Звуки привязаны к действиям (SoundAction) через soundAssignments.
// playActionSound(actionId) — основная точка вызова из UI.

let ctx: AudioContext | null = null
let masterGain: GainNode | null = null

function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    masterGain = ctx.createGain()
    masterGain.gain.value = _soundVolume / 100
    masterGain.connect(ctx.destination)
  }
  return ctx
}

function getMaster(): GainNode {
  getCtx()
  return masterGain!
}

function tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0) {
  try {
    const c = getCtx()
    // Возобновляем context если он был suspended (autoplay policy браузера).
    if (c.state === 'suspended') c.resume()
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.connect(gain)
    gain.connect(getMaster())
    osc.type = type
    osc.frequency.setValueAtTime(freq, c.currentTime + delay)
    gain.gain.setValueAtTime(0, c.currentTime + delay)
    gain.gain.linearRampToValueAtTime(vol, c.currentTime + delay + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + dur)
    osc.start(c.currentTime + delay)
    osc.stop(c.currentTime + delay + dur)
  } catch { /* ok */ }
}

// ── Действия, к которым можно привязать звук ──────────────────
export type SoundAction =
  | 'send' | 'aiDone' | 'toolConfirm'
  | 'toastDefault' | 'toastSuccess' | 'toastError' | 'toastInfo'
  | 'buttonClick' | 'panelOpen' | 'panelClose' | 'navigate'
  | 'error' | 'appStart' | 'appExit'

export const SOUND_ACTIONS: { id: SoundAction; label: string }[] = [
  { id: 'send',         label: 'Отправка сообщения' },
  { id: 'aiDone',       label: 'AI ответил' },
  { id: 'toolConfirm',  label: 'Подтверждение инструмента' },
  { id: 'toastDefault', label: 'Тост (обычный)' },
  { id: 'toastSuccess', label: 'Тост (успех)' },
  { id: 'toastError',   label: 'Тост (ошибка)' },
  { id: 'toastInfo',    label: 'Тост (инфо)' },
  { id: 'buttonClick',  label: 'Клик по кнопке' },
  { id: 'panelOpen',    label: 'Открытие панели' },
  { id: 'panelClose',   label: 'Закрытие панели' },
  { id: 'navigate',     label: 'Навигация по разделам' },
  { id: 'error',        label: 'Ошибка' },
  { id: 'appStart',     label: 'Запуск приложения' },
  { id: 'appExit',      label: 'Выход из приложения' },
]

// ── Реестр встроенных синтез-звуков ───────────────────────────
type SynthPlayer = () => void
interface BuiltinSound { id: string; name: string; play: SynthPlayer }

export const BUILTIN_SOUNDS: BuiltinSound[] = [
  { id: 'synth.send',     name: 'Отправка (восходящие)',     play: () => { tone(520, 0.07, 0.06, 'sine', 0); tone(820, 0.10, 0.04, 'sine', 0.04) } },
  { id: 'synth.done',     name: 'Готово (аккорд)',           play: () => { tone(880, 0.18, 0.045, 'sine', 0); tone(660, 0.22, 0.030, 'sine', 0.06); tone(440, 0.28, 0.020, 'sine', 0.14) } },
  { id: 'synth.confirm',  name: 'Подтверждение (алерт)',     play: () => { tone(600, 0.08, 0.05, 'sine', 0); tone(900, 0.12, 0.06, 'sine', 0.09) } },
  { id: 'synth.toast',    name: 'Тост (мягкий)',             play: () => { tone(500, 0.12, 0.035, 'sine', 0) } },
  { id: 'synth.success',  name: 'Успех (восходящий)',        play: () => { tone(660, 0.10, 0.04, 'sine', 0); tone(880, 0.14, 0.035, 'sine', 0.07) } },
  { id: 'synth.error',    name: 'Ошибка (низкий)',           play: () => { tone(280, 0.14, 0.05, 'sawtooth', 0); tone(220, 0.18, 0.04, 'sawtooth', 0.08) } },
  { id: 'synth.info',     name: 'Инфо (нейтральный)',        play: () => { tone(580, 0.10, 0.035, 'sine', 0); tone(760, 0.12, 0.03, 'sine', 0.06) } },
  { id: 'synth.click',    name: 'Клик (тик)',                play: () => { tone(400, 0.04, 0.03, 'square', 0) } },
  { id: 'synth.open',     name: 'Открытие',                  play: () => { tone(440, 0.06, 0.035, 'sine', 0); tone(660, 0.08, 0.03, 'sine', 0.04) } },
  { id: 'synth.close',    name: 'Закрытие',                  play: () => { tone(660, 0.06, 0.035, 'sine', 0); tone(440, 0.08, 0.03, 'sine', 0.04) } },
  { id: 'synth.navigate', name: 'Навигация',                 play: () => { tone(600, 0.05, 0.025, 'triangle', 0) } },
  { id: 'synth.start',    name: 'Запуск (торжественный)',    play: () => { tone(523, 0.10, 0.04, 'sine', 0); tone(659, 0.10, 0.04, 'sine', 0.08); tone(784, 0.16, 0.035, 'sine', 0.16) } },
  { id: 'synth.exit',     name: 'Выход (нисходящий)',        play: () => { tone(784, 0.10, 0.04, 'sine', 0); tone(659, 0.10, 0.04, 'sine', 0.08); tone(523, 0.16, 0.035, 'sine', 0.16) } },
  { id: 'synth.none',     name: '— Без звука —',             play: () => {} },
]

const BUILTIN_MAP = new Map(BUILTIN_SOUNDS.map(s => [s.id, s]))

// Дефолтные назначения: действие → soundId
export const DEFAULT_SOUND_ASSIGNMENTS: Record<SoundAction, string> = {
  send:         'synth.send',
  aiDone:       'synth.done',
  toolConfirm:  'synth.confirm',
  toastDefault: 'synth.toast',
  toastSuccess: 'synth.success',
  toastError:   'synth.error',
  toastInfo:    'synth.info',
  buttonClick:  'synth.click',
  panelOpen:    'synth.open',
  panelClose:   'synth.close',
  navigate:     'synth.navigate',
  error:        'synth.error',
  appStart:     'synth.start',
  appExit:      'synth.exit',
}

// ── Module-level state (без zustand чтобы избежать circular deps) ──
let _uiSoundsEnabled = true
let _soundVolume = 70
let _soundAssignments: Record<string, string | null> = {}

export function setUiSoundsFlag(v: boolean) { _uiSoundsEnabled = v }
export function setSoundVolume(v: number) {
  _soundVolume = Math.max(0, Math.min(100, v))
  if (masterGain) masterGain.gain.value = _soundVolume / 100
}
export function setSoundAssignmentsFlag(v: Record<string, string | null>) { _soundAssignments = v }

// ── Кеш dataURL для кастомных звуков (чтобы не грузить повторно) ──
const customCache = new Map<string, string>()
// ── Кеш AudioBuffer (декодирование дорого, кешируем результат) ──
const customBufferCache = new Map<string, AudioBuffer>()

async function loadCustomDataUrl(id: string): Promise<string | null> {
  const cached = customCache.get(id)
  if (cached) return cached
  try {
    const url = await window.syntee.sound.load(id)
    if (url) {
      customCache.set(id, url)
      return url
    }
  } catch { /* ok */ }
  return null
}

// Конвертирует data: URL в ArrayBuffer без fetch (CSP-safe — не использует
// connect-src, работает полностью в памяти через atob).
function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.split(',')[1] || ''
  const binaryStr = atob(base64)
  const len = binaryStr.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i)
  return bytes.buffer
}

// Конвертирует data: URL в blob: URL (CSP-safe — blob: считается same-origin).
function dataUrlToBlobUrl(dataUrl: string): string {
  const base64 = dataUrl.split(',')[1] || ''
  const binaryStr = atob(base64)
  const len = binaryStr.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i)
  const mimeMatch = dataUrl.match(/^data:([^;]+)/)
  const mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg'
  const blob = new Blob([bytes], { type: mime })
  return URL.createObjectURL(blob)
}

// Загружает и декодирует кастомный звук в AudioBuffer через Web Audio API.
// Результат кешируется в customBufferCache.
// CSP-safe: декодирует base64 напрямую без fetch(data:) (который блокируется
// connect-src 'self').
async function loadCustomBuffer(id: string): Promise<AudioBuffer | null> {
  const cached = customBufferCache.get(id)
  if (cached) return cached
  const dataUrl = await loadCustomDataUrl(id)
  if (!dataUrl) return null
  try {
    const c = getCtx()
    if (c.state === 'suspended') c.resume()
    const buf = dataUrlToArrayBuffer(dataUrl)
    const audioBuf = await c.decodeAudioData(buf)
    customBufferCache.set(id, audioBuf)
    return audioBuf
  } catch { /* decode failed — fallback to HTMLAudioElement */ }
  return null
}

// Очистка кеша при удалении кастомного звука
export function clearCustomSoundCache(id: string) {
  customCache.delete(id)
  customBufferCache.delete(id)
}

// ── Проигрывание по soundId ───────────────────────────────────
export async function playSoundById(id: string | null): Promise<void> {
  if (!id || id === 'synth.none') return

  if (id.startsWith('synth.')) {
    const sound = BUILTIN_MAP.get(id)
    if (sound) sound.play()
    return
  }

  if (id.startsWith('custom://')) {
    try {
      const audioBuf = await loadCustomBuffer(id)
      if (audioBuf) {
        const c = getCtx()
        if (c.state === 'suspended') c.resume()
        const src = c.createBufferSource()
        src.buffer = audioBuf
        src.connect(getMaster())
        src.start()
        return
      }
      // Fallback: HTMLAudioElement если decodeAudioData не справился.
      // Используем blob: URL вместо data: URL — CSP-safe (blob: same-origin).
      const dataUrl = await loadCustomDataUrl(id)
      if (dataUrl) {
        const blobUrl = dataUrlToBlobUrl(dataUrl)
        const audio = new Audio(blobUrl)
        audio.volume = _soundVolume / 100
        audio.play().catch(() => { /* autoplay policy — ignore */ })
        // Освобождаем blob URL после воспроизведения
        audio.addEventListener('ended', () => URL.revokeObjectURL(blobUrl))
      }
    } catch { /* ok */ }
    return
  }
}

// ── Проигрывание по действию ──────────────────────────────────
export function playActionSound(action: SoundAction): void {
  if (!_uiSoundsEnabled) return
  const assigned = _soundAssignments[action] ?? DEFAULT_SOUND_ASSIGNMENTS[action] ?? null
  playSoundById(assigned)
}

// ── Backward-compat обёртки (для постепенной миграции) ────────
// ВАЖНО: эти функции учитывают назначения — если юзер переназначил
// send на кастомный звук, playSendSound проиграет именно его.
export function playSendSound() { playActionSound('send') }
export function playDoneSound() { playActionSound('aiDone') }
export function playConfirmSound() { playActionSound('toolConfirm') }
export function playToastSound(type: 'default' | 'success' | 'error' | 'info' = 'default') {
  const cap = type.charAt(0).toUpperCase() + type.slice(1)
  playActionSound(`toast${cap}` as SoundAction)
}
export function playClickSound() { playActionSound('buttonClick') }
/**
 * §steer — реплика внедрена в контекст работающего агента (long-press на
 * кнопке отправки). Отдельный сигнал от обычного send: пользователь должен
 * слышать, что сообщение ушло ВНУТРЬ рана, а не встало в очередь.
 */
export function playSteerSound() { playActionSound('toolConfirm') }
export function playNavigateSound() { playActionSound('navigate') }
export function playPanelOpenSound() { playActionSound('panelOpen') }
export function playPanelCloseSound() { playActionSound('panelClose') }
export function playErrorSound() { playActionSound('error') }
export function playAppExitSound() { playActionSound('appExit') }

// ── Просмотрка любого звука (для UI настроек) ─────────────────
// Не зависит от master-флага — всегда играет (юзер тестирует).
export async function previewSound(id: string): Promise<void> {
  const wasEnabled = _uiSoundsEnabled
  _uiSoundsEnabled = true
  // Возобновляем AudioContext — preview вызывается по клику (user gesture),
  // так что resume разрешён политикой autoplay.
  const c = getCtx()
  if (c.state === 'suspended') c.resume()
  await playSoundById(id)
  _uiSoundsEnabled = wasEnabled
}
