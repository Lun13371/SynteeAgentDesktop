// Генерация UI звуков через Web Audio API (нет внешних файлов)
let ctx: AudioContext | null = null

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  return ctx
}

function tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine') {
  const c = getCtx()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.connect(gain)
  gain.connect(c.destination)
  osc.type = type
  osc.frequency.setValueAtTime(freq, c.currentTime)
  gain.gain.setValueAtTime(0, c.currentTime)
  gain.gain.linearRampToValueAtTime(vol, c.currentTime + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur)
  osc.start(c.currentTime)
  osc.stop(c.currentTime + dur)
}

export function playSendSound() {
  try {
    // Два быстрых тона — "whoosh up"
    tone(520, 0.07, 0.06, 'sine')
    setTimeout(() => tone(820, 0.1, 0.04, 'sine'), 40)
  } catch { /* ok */ }
}

export function playReceiveSound() {
  try {
    // Мягкий нотный аккорд — "ding"
    tone(880, 0.18, 0.04, 'sine')
    setTimeout(() => tone(1100, 0.14, 0.025, 'sine'), 30)
  } catch { /* ok */ }
}

export function playClickSound() {
  try {
    tone(400, 0.04, 0.03, 'square')
  } catch { /* ok */ }
}
