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