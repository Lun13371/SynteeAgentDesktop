/**
 * Schema-aware валидация аргументов tool_call ПОСЛЕ JSON.parse, но ДО
 * выполнения тула. Делает 4 вещи:
 *
 * 1. **Type coercion** — модель шлёт "timeout": "60" (строка) вместо
 *    числа. Конвертирует совместимые типы автоматически, логирует факт.
 * 2. **Enum fuzzy-fix** — tryRepairJson ловит только НЕзакавыченные enum
 *    с опечаткой. Закавыченные "mode": "aply_patch" пропускает. Здесь
 *    ловим закавыченные (уже распарсенные) значения и чиним через
 *    Levenshtein ≤ 2.
 * 3. **Unknown args stripping** — модель передаёт параметр, которого
 *    нет в schema (галлюцинация). Удаляем, чтобы не дошло до executeTool.
 * 4. **Defaults filling** — optional поля с `default` в schema
 *    заполняются автоматически, если модель их не передала.
 *
 * Возвращает исправленные args + списки fixes и errors. Errors — это
 * то, что нельзя починить автоматически (модель должна повторить вызов).
 * Fixes — то, что починили тихо, модель даже не узнаёт.
 */

import { log } from '../logger'

// JSON Schema-like тип для свойств параметра
interface PropSchema {
  type?: string
  enum?: string[]
  description?: string
  default?: unknown
  properties?: Record<string, unknown>
  items?: Record<string, unknown>
}

interface ToolSchema {
  function: {
    name: string
    parameters?: {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
    }
  }
}

export interface ValidationResult {
  args: Record<string, unknown>
  fixes: string[]
  errors: string[]
}

/**
 * Levenshtein distance — для fuzzy-коррекции опечаток в enum-значениях.
 * Тот же алгоритм что в utils.ts, но локально (не экспортируем, чтобы
 * не тащить зависимость).
 */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[] = new Array(n + 1)
  for (let j = 0; j <= n; j++) dp[j] = j
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j]
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = tmp
    }
  }
  return dp[n]
}

/**
 * Найти ближайший enum по Levenshtein. Возвращает null если расстояние > 2.
 */
function fuzzyMatchEnum(input: string, allowed: string[]): string | null {
  let bestDist = Infinity
  let bestMatch: string | null = null
  for (const candidate of allowed) {
    const dist = levenshtein(input.toLowerCase(), candidate.toLowerCase())
    if (dist < bestDist) {
      bestDist = dist
      bestMatch = candidate
    }
  }
  return bestDist <= 2 ? bestMatch : null
}

/**
 * Рекурсивно обходит properties схемы и собирает все enum-ключи.
 * Используется для pre-parse ремонта (когда JSON ещё не распарсен).
 */
export function validateAndCoerceArgs(
  name: string,
  args: Record<string, unknown>,
  schemas: ToolSchema[],
): ValidationResult {
  const schema = schemas.find(s => s.function.name === name)
  if (!schema?.function.parameters) {
    return { args, fixes: [], errors: [] }
  }

  const propsRaw = schema.function.parameters.properties ?? {}
  const props = propsRaw as Record<string, PropSchema>
  const fixes: string[] = []
  const errors: string[] = []
  const result: Record<string, unknown> = { ...args }

  for (const [key, val] of Object.entries(result)) {
    const propSchema = props[key]

    // Неизвестный параметр — нет в schema
    if (!propSchema) {
      // Не удаляем, а просто логируем — некоторые тулы принимают
      // динамические параметры (MCP, ask_user questions). Удаление
      // может сломать передачу legit данных.
      fixes.push(`unknown arg '${key}' — not in schema, keeping but may be ignored by tool`)
      continue
    }

    // null/undefined — пропускаем, findMissingRequiredArgs ловит required
    if (val === null || val === undefined) continue

    // ── Type coercion ──
    if (propSchema.type === 'number' && typeof val === 'string' && !isNaN(Number(val))) {
      result[key] = Number(val)
      fixes.push(`coerced '${key}': string → number (${val} → ${result[key]})`)
    } else if (propSchema.type === 'string' && typeof val === 'number') {
      result[key] = String(val)
      fixes.push(`coerced '${key}': number → string`)
    } else if (propSchema.type === 'boolean' && typeof val === 'string') {
      if (val === 'true' || val === '1') {
        result[key] = true
        fixes.push(`coerced '${key}': "true" → true`)
      } else if (val === 'false' || val === '0') {
        result[key] = false
        fixes.push(`coerced '${key}': "false" → false`)
      } else {
        errors.push(`'${key}': expected boolean, got string "${val}"`)
      }
    } else if (propSchema.type === 'array' && typeof val === 'string') {
      // Модель иногда передаёт массив как строку: "paths": "src/a.ts" вместо ["src/a.ts"]
      // Пробуем обернуть в массив
      result[key] = [val]
      fixes.push(`coerced '${key}': string → array (wrapped single value)`)
    }

    // ── Enum fuzzy-fix (для уже распарсенных значений) ──
    // tryRepairJson ловит только НЕзакавыченные enum. Здесь ловим
    // закавыченные с опечаткой: "mode": "aply_patch" → "mode": "apply_patch"
    if (propSchema.enum && Array.isArray(propSchema.enum)) {
      const currentVal = result[key]
      if (typeof currentVal === 'string' && !propSchema.enum.includes(currentVal)) {
        const best = fuzzyMatchEnum(currentVal, propSchema.enum)
        if (best) {
          result[key] = best
          fixes.push(`enum fix: '${key}' "${currentVal}" → "${best}"`)
        } else {
          errors.push(
            `'${key}': "${currentVal}" is not a valid enum value. ` +
            `Allowed: ${propSchema.enum.join(', ')}`,
          )
        }
      }
    }
  }

  // ── Defaults filling ──
  for (const [key, propSchema] of Object.entries(props)) {
    if (result[key] === undefined || result[key] === null) {
      const defaultVal = (propSchema as PropSchema).default
      if (defaultVal !== undefined) {
        result[key] = defaultVal
        fixes.push(`filled default: '${key}' = ${JSON.stringify(defaultVal)}`)
      }
    }
  }

  if (fixes.length > 0) {
    log('[validateArgs] fixes for %s: %s', name, fixes.join(', '))
  }
  if (errors.length > 0) {
    log('[validateArgs] errors for %s: %s', name, errors.join('; '))
  }

  return { args: result, fixes, errors }
}
