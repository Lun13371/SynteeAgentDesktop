/**
 * Настройки индексации — чистые типы и константы без node-зависимостей.
 * Безопасно импортируется из renderer (browser). fastContext.ts реэкспортит отсюда.
 */

/** Дефолтный список ignore-директорий как массив (для UI настроек). */
export const DEFAULT_IGNORE_DIRS_LIST: string[] = [
  'node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build',
  '.next', 'coverage', '.cache', '.turbo', '.parcel-cache', 'target',
  '.gradle', '.idea', '.vscode', '.hermes', '.mimocode', '.playwright-mcp',
  '.planning', 'logs', 'tmp', 'tmp_out', '.opencode',
]

export interface IndexingSettings {
  /** Мастер-переключатель. Если false — watcher не стартует, get_fast_context не индексирует. */
  enabled: boolean
  /** Neural embeddings (ONNX/MiniLM ~22MB). OFF по умолчанию — ONNX грузит CPU в простое. */
  neuralEmbeddings: boolean
  /** Лимит файлов на проект (safety limit). */
  maxFilesPerProject: number
  /** Файлы крупнее не индексируются (в KB). */
  maxFileSizeKb: number
  /** Debounce watcher: как быстро реагировать на изменения файлов (ms). */
  watcherDebounceMs: number
  /** Pre-warm индекс при открытии проекта (если пуст). */
  prewarmOnStart: boolean
  /** Игнорируемые директории (basename match). */
  ignoreDirs: string[]
}

export const DEFAULT_INDEXING_SETTINGS: IndexingSettings = {
  enabled: true,
  neuralEmbeddings: false,
  maxFilesPerProject: 5000,
  maxFileSizeKb: 1500,
  watcherDebounceMs: 1000,
  prewarmOnStart: true,
  ignoreDirs: DEFAULT_IGNORE_DIRS_LIST,
}

/** Читает IndexingSettings из Record (renderer-safe, без Store зависимости). */
export function getIndexSettingsFromRecord(rec: Record<string, unknown> | undefined): IndexingSettings {
  if (!rec) return DEFAULT_INDEXING_SETTINGS
  const saved = (rec['indexingSettings'] ?? {}) as Partial<IndexingSettings>
  return { ...DEFAULT_INDEXING_SETTINGS, ...saved }
}
