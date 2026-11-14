import { BrowserWindow } from 'electron'
import type Store from 'electron-store'
import { DEFAULT_CHAT_TITLE, getDB, renameChat } from '../../core/db'
import { AIClient } from '../../core/ai/AIClient'
import { log } from '../../core/logger'

/** Титул чата всё ещё дефолтный (название не сгенерировано)? */
export function isChatTitleDefault(chatId: string): boolean {
  try {
    const row = getDB().prepare('SELECT title FROM chats WHERE id = ?').get(chatId) as { title: string } | undefined
    return row?.title === DEFAULT_CHAT_TITLE
  } catch {
    return false
  }
}

// Защита от параллельных запусков autoNameChat для одного чата: ретрай на
// 2-м сообщении может прийти, пока 1-я попытка ещё в полёте (ретраи 429/сети).
const autoNameInFlight = new Set<string>()

/** Чистит ответ модели: префикс «Название:», обрамляющие кавычки, длина. */
function cleanAutoTitle(raw: string): string {
  let t = raw.trim()
  t = t.replace(/^(?:название|chat title|title)\s*[:\-–—]\s*/i, '')
  t = t.replace(/^["'«“]+/, '').replace(/["'»”]+$/, '')
  return t.trim().slice(0, 60)
}

/** Локальный фолбэк без LLM: первые слова сообщения пользователя. */
function localAutoTitle(message: string): string {
  const t = message.trim().replace(/\s+/g, ' ')
  // Slash-команды и слишком короткие сообщения — не название.
  if (!t || t.startsWith('/') || t.length < 3) return ''
  return t.slice(0, 40)
}

/**
 * Генерация названия чата по первому сообщению. Цепочка фолбэков:
 *   1. fast-модель (дефолт — бесплатная opencode-free, бывает лежит/429)
 *   2. main-модель чата
 *   3. локальный фолбэк — первые слова сообщения (без LLM)
 * Ошибки логируются (раньше — тихий catch, падение было невидимо).
 */
export async function autoNameChat(chatId: string, firstMessage: string, store: Store, win?: BrowserWindow | null): Promise<void> {
  if (autoNameInFlight.has(chatId)) return
  autoNameInFlight.add(chatId)
  try {
    const prompt = `Придумай короткое название (3-5 слов) для чата, который начинается с этого сообщения: "${firstMessage.slice(0, 200)}". Ответь только названием без кавычек и лишних слов.`
    const client = new AIClient(store)
    const messages = [{ role: 'user' as const, content: prompt }]

    // 1. fast-модель
    let title = ''
    try {
      title = cleanAutoTitle(await client.complete(messages, 'fast'))
    } catch (e) {
      log('[autoNameChat] fast model failed chatId=%s: %s', chatId, (e as Error).message)
    }

    // 2. Фолбэк на основную модель чата (один маленький запрос ~100 токенов)
    if (!title) {
      try {
        title = cleanAutoTitle(await client.complete(messages, 'main'))
        if (title) log('[autoNameChat] used main-model fallback chatId=%s', chatId)
      } catch (e) {
        log('[autoNameChat] main model failed chatId=%s: %s', chatId, (e as Error).message)
      }
    }

    // 3. Локальный фолбэк без LLM
    if (!title) {
      title = localAutoTitle(firstMessage)
      if (title) log('[autoNameChat] used local fallback chatId=%s', chatId)
    }

    if (title) {
      renameChat(chatId, title)
      win?.webContents.send('chat:renamed', { chatId, title })
    }
  } catch (e) {
    log('[autoNameChat] unexpected error chatId=%s: %s', chatId, (e as Error).message)
  } finally {
    autoNameInFlight.delete(chatId)
  }
}
