// Barrel-модуль: реэкспортирует публичное API fast-context.
// Внешние импортёры (Agent.ts, ai-worker.ts, fastContextWatcher.ts, chat.ipc.ts)
// импортируют отсюда — путь `.../context/fastContext` разрешается в этот index.
//
// Индексация и поиск выполняются в Rust sidecar. TypeScript-реализация
// индексатора/ретривера больше не подключена ни к одному пути исполнения —
// единственный backend это Rust, ошибки всплывают как SidecarError.
//
// Структура:
//   state.ts        — SQLite connection + общие lexical helpers
//   symbols.ts      — tree-sitter symbol extraction (для snippets/анализаторов)
//   indexer.ts      — настройки индексации (getIndexSettings) + типы прогресса
//   retriever.ts    — buildContentSnippets (чтение кода найденных файлов)
//   annotator.ts    — summarizeWithLLM (LLM-аннотация repo-map slice)
//   orchestrator.ts — runFastContext (index → search → snippets → LLM)
//   sidecarClient.ts — JSONL-клиент Rust sidecar (единственный backend)
//
// Внутренние символы (getDb, localGetEntries, stem, getParser и т.д.) экспортируются
// из своих модулей для intra-package использования, но НЕ реэкспортируются здесь —
// это internal API.

// init / state
export { initFastContextDb, initFastContextWasmDir, bumpRelevanceBoost } from './state'
// symbols
export { extractSymbols, extractSymbolsFromSource, type SymbolDef, type FileSymbols } from './symbols'
// symbolsCache (in-memory кэш распарсенных символов — avoids 5K JSON.parse per query)
export { getParsedSymbols, invalidateFile, clearSymbolsCache, getSymbolsCacheStats, type ParsedSymbols } from './symbolsCache'
// invertedIndex (инвертированный индекс token→Set<filePath> для O(1) pre-filter)
export { buildInvertedIndex, lookupFiles, clearInvertedIndex, clearAllInvertedIndexes, getInvertedIndexStats } from './invertedIndex'
// fileHash (быстрый content hash для точного детекта изменений)
export { quickHash } from './fileHash'
// indexer — оставлены только настройки и типы прогресса
export { getIndexSettings, type IndexProgress, type ProgressCallback } from './indexer'
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
