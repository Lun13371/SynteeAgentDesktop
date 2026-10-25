// Barrel-модуль: реэкспортирует публичное API fast-context.
// Внешние импортёры (toolDispatcher, ai-worker.ts, fastContextWatcher.ts, chat.ipc.ts)
// импортируют отсюда — путь `.../context/fastContext` разрешается в этот index.
//
// Вся работа с индексом — обход, парсинг, поиск, watcher — выполняется в Rust
// sidecar. TypeScript-индексатора, ретривера, WASM-грамматик и кэшей символов
// больше нет: единственный backend это Rust, ошибки всплывают как SidecarError.
//
// Структура:
//   settings.ts      — настройки индексации + типы прогресса
//   lexical.ts       — stem / splitNameParts для ранжирования сниппетов
//   types.ts         — SymbolDef / FileSymbols (общая форма для потребителей)
//   retriever.ts     — buildContentSnippets (чтение кода найденных файлов)
//   annotator.ts     — summarizeWithLLM (LLM-аннотация repo-map slice)
//   orchestrator.ts  — runFastContext (index → search → snippets → LLM)
//   sidecarClient.ts — JSONL-клиент Rust sidecar (единственный backend)

// settings
export { getIndexSettings, type IndexProgress, type ProgressCallback } from './settings'
// shared symbol shapes
export type { SymbolDef, FileSymbols } from './types'
// retriever
export { buildContentSnippets } from './retriever'
// annotator
export { summarizeWithLLM, type FastContextFile, type FastContextResult } from './annotator'
// orchestrator
export { runFastContext } from './orchestrator'
// settings (re-export из fastContextSettings — pure types/constants, renderer-safe)
export {
  type IndexingSettings,
  DEFAULT_INDEXING_SETTINGS,
  DEFAULT_IGNORE_DIRS_LIST,
  getIndexSettingsFromRecord,
} from '../fastContextSettings'
