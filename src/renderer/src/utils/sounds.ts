// Генерация UI звуков через Web Audio API (нет внешних файлов)
let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

function tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0) {
  try {
    const c = getCtx()
    const osc = c.createOscillator()
    const gain = c.createGain()
    osc.connect(gain)
    gain.connect(c.destination)
    osc.type = type
    osc.frequency.setValueAtTime(freq, c.currentTime + delay)
    gain.gain.setValueAtTime(0, c.currentTime + delay)
    gain.gain.linearRampToValueAtTime(vol, c.currentTime + delay + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + dur)
    osc.start(c.currentTime + delay)
    osc.stop(c.currentTime + delay + dur)
  } catch { /* ok */ }
}

// Глобальный флаг — выставляется из App.tsx при загрузке настроек
// Избегаем импорта zustand чтобы не создавать circular deps
let _uiSoundsEnabled = true
export function setUiSoundsFlag(v: boolean) { _uiSoundsEnabled = v }

function soundsEnabled(): boolean { return _uiSoundsEnabled }

// Отправка сообщения — два восходящих тона
export function playSendSound() {
  if (!soundsEnabled()) return
  tone(520, 0.07, 0.06, 'sine', 0)
  tone(820, 0.10, 0.04, 'sine', 0.04)
}

// Завершение генерации AI — мягкий нисходящий аккорд
export function playDoneSound() {
  if (!soundsEnabled()) return
  tone(880, 0.18, 0.045, 'sine', 0)
  tone(660, 0.22, 0.030, 'sine', 0.06)
  tone(440, 0.28, 0.020, 'sine', 0.14)
}

// Запрос подтверждения тула — два коротких тона вверх (Alert)
export function playConfirmSound() {
  if (!soundsEnabled()) return
  tone(600, 0.08, 0.05, 'sine', 0)
  tone(900, 0.12, 0.06, 'sine', 0.09)
}

// Тост уведомление — один мягкий тон
export function playToastSound(type: 'default' | 'success' | 'error' | 'info' = 'default') {
  if (!soundsEnabled()) return
  if (type === 'error') {
    tone(280, 0.14, 0.05, 'sawtooth', 0)
    tone(220, 0.18, 0.04, 'sawtooth', 0.08)
  } else if (type === 'success') {
    tone(660, 0.10, 0.04, 'sine', 0)
    tone(880, 0.14, 0.035, 'sine', 0.07)
  } else {
    tone(500, 0.12, 0.035, 'sine', 0)
  }
}

// Клик — короткий тик (для кнопок)
export function playClickSound() {
  if (!soundsEnabled()) return
  tone(400, 0.04, 0.03, 'square', 0)
}
