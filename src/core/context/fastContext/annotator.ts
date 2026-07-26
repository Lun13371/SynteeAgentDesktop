import type Store from 'electron-store'
import { AIClient } from '../../ai/AIClient'

// ─── LLM Summarization ──────────────────────────────────────────────────────

export interface FastContextFile {
  path: string
  lineRanges: string  // "10-45, 100-130"
  why: string  // 1-строка — почему этот файл релевантен
}

export interface FastContextResult {
  files: FastContextFile[]
  summary: string
  ms: number
  indexedFilesCount: number
}

const SUMMARY_SYSTEM_PROMPT = `Ты — экспертный анализатор кодовой базы. Твоя задача — по repo-map (структура файлов с сигнатурами, зависимостями и call graph) и запросу пользователя выбрать релевантные файлы и указать точные line ranges.

Repo-map содержит:
- Сигнатуры символов с номерами строк (L<номер>)
- Иерархию: методы с отступом под классами
- imports / imported by / called by — связи между файлами
- [entry] / [hub] — точки входа и архитектурно важные файлы
- Content snippets — реальный код top файлов

Ответ — только JSON, без markdown:
{"files":[{"path":"точный путь из repo-map","lineRanges":"10-45","why":"какие символы релевантны"}],"summary":"2-3 предложения: что найдено и как связано с запросом"}

Правила:
- Выбери 5-30 файлов из repo-map (больше если релевантны)
- path — ТОЧНО из repo-map, не выдумывай пути
- lineRanges — диапазоны строк из L-номеров: "10-45" или "10-45, 100-130"
- why — 1 строка: какие символы/зависимости делают файл релевантным
- Выбирай файлы по РЕЛЕВАНТНОСТИ К ЗАПРОСУ, а не по структурной важности
- [entry]/[hub] и imported by — справочная информация, НЕ приоритет
- summary: архитектура решения, какие файлы за что отвечают`

/**
 * Надёжное извлечение JSON из ответа LLM. Сначала убирает markdown-fences,
 * затем ищет сбалансированный {...} блок (не жадный regex, который ломается
 * на prose с фигурными скобками).
 */
export function extractJsonFromLlmResponse(raw: string): { files?: unknown[]; summary?: string; facts?: unknown[] } | null {
  let text = raw.trim()

  // 1. Убираем markdown code fences (```json ... ``` или ``` ... ```)
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) {
    text = fenceMatch[1].trim()
  }

  // 2. Ищем сбалансированный {...} блок
  const startIdx = text.indexOf('{')
  if (startIdx === -1) return null

  let depth = 0
  let endIdx = -1
  let inString = false
  let escape = false
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { endIdx = i; break }
    }
  }

  if (endIdx === -1) return null
  const jsonStr = text.slice(startIdx, endIdx + 1)

  try {
    return JSON.parse(jsonStr) as { files?: unknown[]; summary?: string }
  } catch {
    // Fallback: пробуем старый жадный regex (на случай если balanced parse ошибся)
    const greedyMatch = raw.match(/\{[\s\S]*\}/)
    if (greedyMatch) {
      try {
        return JSON.parse(greedyMatch[0]) as { files?: unknown[]; summary?: string }
      } catch { /* skip */ }
    }
    return null
  }
}

export async function summarizeWithLLM(
  store: Store,
  query: string,
  repoMapSlice: string,
  signal?: AbortSignal,
): Promise<{ files: FastContextFile[]; summary: string } | null> {
  const aiClient = new AIClient(store)
  let raw = ''
  await aiClient.streamChat(
    [{
      role: 'user',
      content: `Запрос: ${query}\n\nRepo-map (top files с символами):\n\n${repoMapSlice}`,
    }],
    {
      onToken: (t) => { raw += t },
      onDone: () => {},
      onError: () => {},
    },
    'fastContext',
    SUMMARY_SYSTEM_PROMPT,
    signal,
    0.1, // low temperature for deterministic file selection
  )

  const parsed = extractJsonFromLlmResponse(raw)
  if (!parsed) {
    return { files: [], summary: raw.slice(0, 300) || 'Не удалось получить summary.' }
  }

  const files: FastContextFile[] = []
  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files.slice(0, 50)) {
      if (typeof f !== 'object' || f === null) continue
      const obj = f as Record<string, unknown>
      const path = typeof obj.path === 'string' ? obj.path : ''
      const lineRanges = typeof obj.lineRanges === 'string' ? obj.lineRanges : ''
      const why = typeof obj.why === 'string' ? obj.why : ''
      if (path) files.push({ path, lineRanges, why })
    }
  }

  return {
    files,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : '',
  }
}
