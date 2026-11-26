// ── Code mode (execute_code) tool schema ─────────────────────────────────
//
// Один TypeScript-скрипт вместо серии отдельных вызовов: скрипт сам дёргает
// тулы через bridge и возвращает уже сжатый результат. Экономит раунды с
// моделью и токены контекста на механической многошаговой работе.
//
// Схема — обычный тул в реестре (TOOL_SCHEMAS), включается/выключается как все
// остальные через OPTIONAL_TOOL_GROUPS + disabledTools.

export const EXECUTE_CODE_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'execute_code',
    description: 'Batch multiple exposed tools in one isolated TypeScript script. Use await tools.call(name, args) and return a compact result. Each call returns {success, output, error?} and follows normal approvals. Use a direct tool call for a single operation.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'TypeScript body of an async function; use return for the final result.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
}

export const CODE_TOOL_SCHEMAS = [EXECUTE_CODE_SCHEMA] as const
