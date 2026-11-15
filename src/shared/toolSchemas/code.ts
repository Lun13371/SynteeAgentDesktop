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
    description: 'Run ONE TypeScript program that calls other tools internally, so N tool calls cost one model round-trip instead of N. Use it to batch a whole chain of tool calls (search → filter → read → summarize — put ALL steps in one script, never split one task into several minimal scripts), to scan/filter many files or search hits, or when intermediate results would flood the context. Do NOT use it for a single tool call — call that tool directly instead. Also not for file edits (edit_file/write_file produce reviewable diffs) or when you need a user decision mid-way. No imports, Node APIs, fs, timers or network. The body is an async function: tools.call(name,args) or tools.<tool_name>(args) resolves to {success, output, error?} where output is the raw formatted tool text; use return for the final result, console.log is appended. Nested calls use the current allowed tools and all normal permissions/approvals — a denial resolves to {success:false, error} and the program continues. Execution has a 30-second guest CPU budget and a 120-second absolute wall-clock limit including nested tools. artifacts.save(value)/load(id)/list()/delete(id) keep JSON between runs in this chat. Return compact aggregates (counts, top-N, file:line), never whole file bodies.',
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
