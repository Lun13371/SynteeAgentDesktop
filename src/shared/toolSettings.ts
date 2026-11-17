// Shared, renderer-safe builtin tool preferences. External tools retain their own controls.
//
// Списки для настроек ВЫВОДЯТСЯ ИЗ СХЕМ (единственный источник истины —
// toolSchemas/*.ts): новый тул, добавленный в схемы, автоматически появляется
// во вкладке «Инструменты» — править настройки руками не нужно. Нужны только
// точечные переопределения: группа (если домен схем ≠ смысловой группе UI) и
// лейбл (если человекочитаемое имя ≠ лейблу из toolMeta).
import { TOOL_META } from './toolMeta'
import { READ_TOOL_SCHEMAS } from './toolSchemas/read'
import { EDIT_TOOL_SCHEMAS } from './toolSchemas/edit'
import { COMMAND_TOOL_SCHEMAS } from './toolSchemas/command'
import { CODE_TOOL_SCHEMAS } from './toolSchemas/code'
import { SEARCH_TOOL_SCHEMAS } from './toolSchemas/search'
import { AGENT_TOOL_SCHEMAS } from './toolSchemas/agent'
import { PLAN_TOOL_SCHEMAS } from './toolSchemas/plan'
import { MEMORY_TOOL_SCHEMAS } from './toolSchemas/memory'
import { EXTENSIONS_TOOL_SCHEMAS } from './toolSchemas/extensions'
import { VISION_TOOL_SCHEMAS } from './toolSchemas/vision'
import { MEDIA_TOOL_SCHEMAS } from './toolSchemas/media'
import { DOTS_TOOL_SCHEMAS } from './toolSchemas/dots'
import { CHAT_TOOL_SCHEMAS } from './toolSchemas/chats'
import { BROWSER_TOOL_SCHEMAS } from './toolSchemas/browser'

export interface ToolSettings {
  customToolsEnabled: boolean
  disabledTools: string[]
}
export const DEFAULT_TOOL_SETTINGS: ToolSettings = { customToolsEnabled: false, disabledTools: [] }

/**
 * Основные инструменты — защищены от отключения (продуктовое решение: без них
 * агент не работает). Явный список, не выводится автоматически.
 */
export const PROTECTED_CORE_TOOLS = [
  'read_file', 'read_files', 'find_files', 'search_code', 'project_map', 'list_directory',
  'edit_file', 'write_file', 'run_command', 'get_diagnostics',
  'update_todo', 'update_working_memory', 'ask_user', 'request_access',
  'recall_context',
] as const
const coreTools = new Set<string>(PROTECTED_CORE_TOOLS)

// ── Автовывод опциональных групп из схем ─────────────────────────────────────

/** Домены схем → смысловые группы UI. Порядок = порядок групп в настройках. */
const DOMAIN_GROUPS: Array<{ label: string; schemas: ReadonlyArray<{ function: { name: string } }> }> = [
  { label: 'Оркестрация', schemas: CODE_TOOL_SCHEMAS },
  { label: 'Интернет', schemas: SEARCH_TOOL_SCHEMAS },
  { label: 'Память', schemas: MEMORY_TOOL_SCHEMAS },
  { label: 'Агенты и чаты', schemas: [...AGENT_TOOL_SCHEMAS, ...CHAT_TOOL_SCHEMAS, ...DOTS_TOOL_SCHEMAS] },
  { label: 'Расширения', schemas: EXTENSIONS_TOOL_SCHEMAS },
  { label: 'Медиа', schemas: [...VISION_TOOL_SCHEMAS, ...MEDIA_TOOL_SCHEMAS] },
  { label: 'Браузер', schemas: BROWSER_TOOL_SCHEMAS },
  { label: 'Файлы и команды', schemas: [...READ_TOOL_SCHEMAS, ...EDIT_TOOL_SCHEMAS, ...COMMAND_TOOL_SCHEMAS] },
  { label: 'Исследование', schemas: PLAN_TOOL_SCHEMAS },
]

/** Тул живёт не в «своей» доменной группе — например, generate_image лежит
 *  в edit.ts, а проектная карта — в search.ts рядом с веб-поиском. */
const GROUP_OVERRIDES: Record<string, string> = {
  generate_image: 'Медиа',
  project_map: 'Карта кода',
}

/** Лейбл насыщеннее, чем в toolMeta (там — короткие подписи для цепочек тулов). */
const LABEL_OVERRIDES: Record<string, string> = {
  execute_code: 'Скрипт вместо серии вызовов (Code Mode)',
  manage_dots: 'Фоновые агенты Dots',
}

export interface ToolEntry { name: string; label: string }
export interface ToolGroup { label: string; tools: ToolEntry[] }

/**
 * Опциональные тулы = все тулы из схем минус защищённые, сгруппированные по
 * домену (+ переопределения). Новые доменные тулы появляются здесь сами.
 */
function deriveOptionalGroups(): ToolGroup[] {
  const byGroup = new Map<string, ToolEntry[]>()
  for (const { label, schemas } of DOMAIN_GROUPS) {
    for (const schema of schemas) {
      const name = schema.function.name
      if (coreTools.has(name)) continue
      const group = GROUP_OVERRIDES[name] ?? label
      const list = byGroup.get(group) ?? []
      list.push({ name, label: LABEL_OVERRIDES[name] ?? TOOL_META[name]?.label ?? name })
      byGroup.set(group, list)
    }
  }
  return [...byGroup.entries()]
    .map(([label, tools]) => ({ label, tools }))
    .filter(group => group.tools.length > 0)
}

export const OPTIONAL_TOOL_GROUPS: ToolGroup[] = deriveOptionalGroups()

export function normalizeDisabledTools(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((name): name is string =>
    typeof name === 'string' && name.length > 0 && !coreTools.has(name)
      && !name.startsWith('mcp__') && !name.startsWith('plugin__')))] : []
}
export function getToolSettings(store: { get(key: string, fallback?: unknown): unknown }): ToolSettings {
  return {
    customToolsEnabled: store.get('customToolsEnabled', false) === true,
    disabledTools: normalizeDisabledTools(store.get('disabledTools', [])),
  }
}
export function isToolDisabled(name: string, settings: ToolSettings): boolean {
  return settings.customToolsEnabled && !coreTools.has(name)
    && !name.startsWith('mcp__') && !name.startsWith('plugin__')
    && settings.disabledTools.includes(name)
}
export function filterToolSchemas<T extends { function: { name: string } }>(schemas: T[], settings: ToolSettings): T[] {
  return schemas.filter(schema => !isToolDisabled(schema.function.name, settings))
}
