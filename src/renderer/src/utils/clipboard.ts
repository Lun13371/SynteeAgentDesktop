/**
 * Единый хелпер копирования в буфер обмена.
 *
 * В production-сборке Electron грузит renderer через `file://` — это не
 * secure context, поэтому `navigator.clipboard.writeText()` молча реджектит
 * промис. Раньше call-sites не await'или его и сразу показывали «Скопировано»
 * → ложный успех, буфер пуст.
 *
 * Стратегия (3 уровня фолбэка):
 * 1. IPC → electron.clipboard (main-процесс) — надёжный, работает на file://.
 * 2. navigator.clipboard — Web API (работает в dev / secure context).
 * 3. document.execCommand('copy') — deprecated, последний фолбэк.
 *
 * Возвращает `true` только если текст реально попал в буфер.
 */

export async function copyToClipboard(text: string): Promise<boolean> {
  // 1. Нативный IPC-канал (надёжный, работает на file://)
  try {
    const ok = await window.syntee.clipboard.writeText(text)
    if (ok) return true
  } catch {
    /* fallthrough */
  }

  // 2. Фолбэк: Web API (dev / secure context)
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    /* fallthrough */
  }

  // 3. Последний фолбэк: execCommand с временной textarea
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * Чтение из буфера обмена (для Spotlight «Вставить из буфера»).
 * Та же стратегия: IPC → navigator.clipboard → пустая строка.
 */
export async function readClipboard(): Promise<string> {
  try {
    return await window.syntee.clipboard.readText()
  } catch {
    /* fallthrough */
  }
  try {
    return await navigator.clipboard.readText()
  } catch {
    /* fallthrough */
  }
  return ''
}
