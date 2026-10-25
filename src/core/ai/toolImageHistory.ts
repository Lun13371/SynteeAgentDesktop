import { readFileSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import {
  DEFAULT_IMAGE_REQUEST_LIMITS, ImageRequestBudget,
  MAX_HISTORY_IMAGE_BYTES, MAX_IMAGES_IN_HISTORY, MAX_IMAGE_FILE_BYTES,
  formatBytes, imageRejectionReason, inspectImage,
} from '../../shared/imageFormat'
import type { ToolImagePart } from '../tools/_shared'

export type HydratedToolContent = string | Array<ToolImagePart | { type: 'text'; text: string }>

/**
 * Бюджет пикселей одного запроса: и восстановление истории, и текущий раунд
 * тулов считают одни и те же лимиты, потому что провайдер считает их на весь
 * запрос целиком (Anthropic: ≤2000 px на картинку, если их несколько;
 * ≤5 МБ base64 на картинку; ≤32 МБ на тело запроса).
 */
export type ImageHydrationBudget = ImageRequestBudget

/** Бюджет только для истории: свои более узкие лимиты по числу картинок. */
export function createImageHydrationBudget(
  overrides: { maxImages?: number; maxBytes?: number } = {},
): ImageHydrationBudget {
  return new ImageRequestBudget({
    ...DEFAULT_IMAGE_REQUEST_LIMITS,
    maxImages: overrides.maxImages ?? MAX_IMAGES_IN_HISTORY,
    maxBytes: overrides.maxBytes ?? MAX_HISTORY_IMAGE_BYTES,
  })
}

function unavailableNote(path: string, reason: string): string {
  return `[History: image unavailable: ${path} (${reason}). No pixels were attached for this file; ask for a new attachment if required.]`
}

function omittedNote(path: string, reason: string): string {
  return `[History: image pixels omitted for ${path} — ${reason}. The file is still on disk; call analyze_image if the pixels are needed.]`
}

/**
 * Восстанавливает пиксели tool-результата из сохранённых путей.
 *
 * Проверки те же, что в analyze_image: абсолютный путь, регулярный файл,
 * реальные magic bytes (расширение ничего не доказывает), реальные размеры
 * в пикселях и лимит на файл. Без них файл с именем `*.png`, но с бинарём
 * внутри, попадал в контекст как base64 и ломал запрос.
 *
 * `cap` — дополнительный потолок по числу картинок для этого прохода
 * (история отдаёт бюджет раньше текущего раунда, но не больше своего лимита).
 */
export function hydrateToolImageContent(
  message: { content: string; imagePaths?: string[] },
  supportsVision: boolean,
  budget: ImageRequestBudget = createImageHydrationBudget(),
  cap?: number,
): HydratedToolContent {
  if (!message.imagePaths?.length) return message.content
  if (!supportsVision) {
    return `${message.content}\n[History: image pixels are not attached to this text-only model. Use analyze_image with the saved path if visual analysis is needed: ${message.imagePaths.join(', ')}]`
  }
  const images: ToolImagePart[] = []
  const notes: string[] = []
  for (const path of message.imagePaths) {
    try {
      if (!isAbsolute(path)) throw new Error('not an absolute path')
      if (budget.seen.has(path)) {
        notes.push(omittedNote(path, 'already attached in this request'))
        continue
      }
      const stat = statSync(path)
      if (!stat.isFile()) throw new Error('not a regular file')
      if (stat.size > MAX_IMAGE_FILE_BYTES) {
        throw new Error(`too large (${formatBytes(stat.size)}, limit ${formatBytes(MAX_IMAGE_FILE_BYTES)})`)
      }
      const data = readFileSync(path)
      const info = inspectImage(data)
      const rejection = imageRejectionReason(info)
      if (rejection) throw new Error(rejection)
      const base64 = data.toString('base64')
      const payload = { base64Bytes: base64.length, width: info.width, height: info.height }
      const reason = budget.reject(payload, cap)
      if (reason) {
        notes.push(omittedNote(path, reason))
        continue
      }
      budget.accept(payload)
      budget.seen.add(path)
      images.push({ type: 'image_url', image_url: { url: `data:${info.mime};base64,${base64}`, detail: 'high' } })
    } catch (e) {
      notes.push(unavailableNote(path, e instanceof Error ? e.message : String(e)))
    }
  }
  const text = [message.content, ...notes].join('\n')
  return images.length ? [...images, { type: 'text', text }] : text
}

/**
 * Гидрация всей истории с одним бюджетом.
 *
 * Бюджет расходуется С КОНЦА (сначала самые свежие результаты — модель почти
 * всегда работает с ними), а возвращается массив в исходном порядке.
 */
export function hydrateHistoryContents<T extends { role: string; content: string; imagePaths?: string[] }>(
  history: T[],
  supportsVision: boolean,
  budget: ImageRequestBudget = createImageHydrationBudget(),
  cap: number = MAX_IMAGES_IN_HISTORY,
): HydratedToolContent[] {
  const contents = new Array<HydratedToolContent>(history.length)
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]
    contents[i] = message.role === 'tool'
      ? hydrateToolImageContent(message, supportsVision, budget, cap)
      : message.content
  }
  return contents
}