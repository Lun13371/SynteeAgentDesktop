/**
 * Fast Context — быстрый retrieval контекста проекта через tree-sitter + fast LLM.
 *
 * Workflow (3 stage, как у тулзы):
 *   1. indexing    — собрать/обновить tree-sitter индекс символов проекта (incremental по mtime+size)
 *   2. retrieving  — graph-rank top files по запросу + lexical match → compact repo-map slice
 *   3. summarizing — 1 fast LLM вызов (роль fastContext) → {files, summary}
 *
 * Архитектура вдохновлена Aider repo-map (tree-sitter + PageRank) и Devin Desktop
 * Fast Context (instant retrieval + LLM synthesis). Без embeddings — чисто
 * структурный retrieval + LLM, что покрывает 80% юзкейсов "найти релевантные
 * файлы по проекту" без RAG infrastructure.
 *
 * ВАЖНО: этот модуль исполняется в worker_threads (вызывается тулзой из Agent).
 * Worker не имеет доступа к main-процессной БД (database.ts `getDB()` вернёт
 * undefined) и к `electron` `app`. Поэтому здесь открывается собственное
 * SQLite connection к тому же файлу (WAL mode позволяет concurrent access
 * из main + worker). Путь к БД передаётся через initFastContextDb(dbPath)
 * из ai-worker.ts (workerData.dbPath).
 */
import { readdir, stat, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, extname, sep } from 'path'
import Database from 'better-sqlite3'
import type { Database as DBType } from 'better-sqlite3'
import type Store from 'electron-store'
import { AIClient } from '../ai/AIClient'
import { getEmbedder, embeddingToBuffer, bufferToEmbedding, cosineSimilarity, fileToEmbeddingText, updateTfidfIdf, setActiveProjectId, setUseNeuralEmbeddings, type Embedding } from './embeddings'
// IndexingSettings — чистые типы/константы без node-зависимостей (безопасны для renderer).
// getIndexSettings(store) — main-only, использует Store для чтения electron-store.
export {
  type IndexingSettings,
  DEFAULT_INDEXING_SETTINGS,
  DEFAULT_IGNORE_DIRS_LIST,
  getIndexSettingsFromRecord,
} from './fastContextSettings'
import { getIndexSettingsFromRecord, DEFAULT_INDEXING_SETTINGS, type IndexingSettings } from './fastContextSettings'

// ─── Worker-local SQLite connection ──────────────────────────────────────────
// Открывается lazy при первом обращении к индексу. WAL mode → безопасен
// concurrent доступ с main-процессом (который пишет через watcher).

let _db: DBType | null = null
let _dbPath: string | null = null

/** Инициализация пути к БД. Вызывается из ai-worker.ts при старте worker'а. */
export function initFastContextDb(dbPath: string): void {
  _dbPath = dbPath
}

function getDb(): DBType {
  if (_db && _db.open) return _db
  if (!_dbPath) {
    throw new Error('fastContext: dbPath not initialized. Call initFastContextDb(dbPath) from worker startup.')
  }
  _db = new Database(_dbPath, { readonly: false, timeout: 10_000 })
  _db.pragma('journal_mode = WAL')
  _db.pragma('busy_timeout = 5000')
  return _db
}

// ─── Локальные CRUD (не зависят от main-процессной database.ts) ──────────────

interface LocalFastContextEntry {
  projectId: string
  filePath: string
  lang: string | null
  symbolsJson: string | null
  mtime: number
  size: number
  rankedScore: number
  relevanceBoost: number
  embedding: Buffer | null
  updatedAt: number
}

function localGetEntries(projectId: string): LocalFastContextEntry[] {
  return getDb().prepare(`
    SELECT project_id as projectId, file_path as filePath, lang, symbols_json as symbolsJson,
           mtime, size, ranked_score as rankedScore, relevance_boost as relevanceBoost,
           embedding, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ?
    ORDER BY ranked_score DESC
  `).all(projectId) as LocalFastContextEntry[]
}

function localGetEntry(projectId: string, filePath: string): LocalFastContextEntry | null {
  return getDb().prepare(`
    SELECT project_id as projectId, file_path as filePath, lang, symbols_json as symbolsJson,
           mtime, size, ranked_score as rankedScore, relevance_boost as relevanceBoost,
           embedding, updated_at as updatedAt
    FROM fast_context_index
    WHERE project_id = ? AND file_path = ?
  `).get(projectId, filePath) as LocalFastContextEntry | null
}

function localUpsert(
  projectId: string, filePath: string, lang: string | null,
  symbolsJson: string | null, mtime: number, size: number, rankedScore = 0,
  embedding?: Buffer | null,
): void {
  getDb().prepare(`
    INSERT INTO fast_context_index (project_id, file_path, lang, symbols_json, mtime, size, ranked_score, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, file_path) DO UPDATE SET
      lang = excluded.lang,
      symbols_json = excluded.symbols_json,
      mtime = excluded.mtime,
      size = excluded.size,
      ranked_score = excluded.ranked_score,
      embedding = COALESCE(excluded.embedding, fast_context_index.embedding),
      updated_at = excluded.updated_at
  `).run(projectId, filePath, lang, symbolsJson, mtime, size, rankedScore, embedding ?? null, Date.now())
}

function localDelete(projectId: string, filePath: string): void {
  getDb().prepare(`DELETE FROM fast_context_index WHERE project_id = ? AND file_path = ?`).run(projectId, filePath)
}

function localUpdateScores(projectId: string, scores: Array<{ filePath: string; rankedScore: number }>): void {
  const db = getDb()
  const stmt = db.prepare(`UPDATE fast_context_index SET ranked_score = ? WHERE project_id = ? AND file_path = ?`)
  const tx = db.transaction((rows: Array<{ filePath: string; rankedScore: number }>) => {
    for (const r of rows) stmt.run(r.rankedScore, projectId, r.filePath)
  })
  tx(scores)
}

/** Decay relevance_boost для всех файлов проекта (затухание старых сигналов). */
function localDecayRelevance(projectId: string, factor = 0.9): void {
  getDb().prepare(`UPDATE fast_context_index SET relevance_boost = relevance_boost * ? WHERE project_id = ?`).run(factor, projectId)
}

/** Boost relevance для файла (вызывается когда AI читает файл после get_fast_context). */
export function bumpRelevanceBoost(projectId: string, filePath: string, amount = 1): void {
  try {
    getDb().prepare(`UPDATE fast_context_index SET relevance_boost = relevance_boost + ? WHERE project_id = ? AND file_path = ?`)
      .run(amount, projectId, filePath)
  } catch { /* skip — БД может быть не инициализирована */ }
}

// Используется внутри модуля (не экспортируется) — alias для совместимости с существующим кодом
type FastContextEntry = LocalFastContextEntry


// ─── web-tree-sitter lazy init ──────────────────────────────────────────────
// Загружаем .wasm через require('web-tree-sitter/.cjs') — CommonJS-совместимо.
// Парсер + грамматики кэшируются по языку (singleton per language).

type TSParser = { parse: (src: string, oldTree?: unknown) => TSNode; setLanguage: (lang: unknown) => void; delete(): void }
type TSLanguage = unknown
type TSNode = {
  type: string
  startPosition: { row: number; column: number }
  endPosition: { row: number; column: number }
  text: string
  childCount: number
  child: (i: number) => TSNode
  children: TSNode[]
  namedChildren: TSNode[]
  parent: TSNode | null
  nextSibling: TSNode | null
  prevSibling: TSNode | null
  childForFieldName?: (field: string) => TSNode | null
}

let _parserLib: { Parser: { init: (opts?: unknown) => Promise<void>; new (): TSParser }; Language: { load: (path: string) => Promise<TSLanguage> } } | null = null
let _parserInstance: TSParser | null = null
const _langCache = new Map<string, TSLanguage>()
let _wasmDir: string | null = null

/** Инициализация пути к .wasm файлам. Вызывается из ai-worker.ts (workerData.wasmDir). */
export function initFastContextWasmDir(dir: string): void {
  _wasmDir = dir
}

/** Директория с .wasm файлами. В worker — задаётся через initFastContextWasmDir,
 *  в main (watcher) — авто-детект через process.resourcesPath / app.getAppPath. */
function getWasmDir(): string {
  if (_wasmDir) return _wasmDir
  // В main-процессе (watcher) — авто-детект. Worker получает путь через initFastContextWasmDir.
  // Порядок кандидатов важен: в dev режиме app.getAppPath() = out/main (не проект root),
  // поэтому process.cwd() проверяем ПЕРВЫМ. В prod (packaged) — process.resourcesPath.
  const candidates: string[] = [
    join(process.cwd(), 'resources', 'tree-sitter'),
  ]
  try {
    // electron app доступен только в main — пробуем через require чтобы не падать в worker
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron')
    if (electron?.app?.getAppPath) {
      // В dev app.getAppPath() = out/main — НЕ подходит. Но в некоторых pack-сценариях
      // может указывать на проект root — оставляем как fallback.
      const appPath = electron.app.getAppPath()
      // Если appPath заканчивается на out/main или out\main — поднимаемся на 2 уровня
      if (typeof appPath === 'string' && /[\\/]out[\\/]main$/.test(appPath)) {
        candidates.push(join(appPath, '..', '..', 'resources', 'tree-sitter'))
      } else {
        candidates.push(join(appPath, 'resources', 'tree-sitter'))
      }
    }
  } catch { /* worker — нет electron */ }
  // Prod (packaged): resources распакованы в process.resourcesPath
  candidates.push(join(process.resourcesPath ?? '', 'tree-sitter'))
  candidates.push(join(process.resourcesPath ?? '', 'resources', 'tree-sitter'))

  for (const c of candidates) {
    // 0.25.x: tree-sitter.wasm; 0.26.x: web-tree-sitter.wasm — проверяем оба
    if (existsSync(join(c, 'tree-sitter.wasm')) || existsSync(join(c, 'web-tree-sitter.wasm'))) {
      _wasmDir = c
      return c
    }
  }
  // Fallback — первый кандидат, даже если не существует (будет понятная ошибка)
  _wasmDir = candidates[0]
  return _wasmDir
}

async function getParserLib(): Promise<NonNullable<typeof _parserLib>> {
  if (_parserLib) return _parserLib
  // web-tree-sitter — Emscripten module. В Electron worker_threads require()
  // может вернуть Emscripten runtime object вместо Parser функции.
  // Решение: загружаем файл напрямую через vm.runInThisContext с ручным
  // созданием module/exports, чтобы обойти проблему module resolution.
  let Parser: unknown = null
  try {
    // Способ 1: обычный require (работает в main process и plain Node.js)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('web-tree-sitter')
    Parser = mod.Parser ?? (typeof mod === 'function' ? mod : mod.default)
  } catch { /* fallback ниже */ }
  if (!Parser || typeof Parser !== 'function') {
    // Способ 2: прямая загрузка файла через vm (обходит module resolution)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pathMod = require('path')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vm = require('vm')
      const candidates = [
        pathMod.join(process.cwd(), 'node_modules', 'web-tree-sitter', 'tree-sitter.js'),
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        pathMod.join(require.resolve('web-tree-sitter').replace(/[\\/][^\\/]+$/, ''), 'tree-sitter.js'),
      ]
      let code = ''
      for (const p of candidates) {
        try { code = fs.readFileSync(p, 'utf-8'); break } catch { /* try next */ }
      }
      if (!code) throw new Error('tree-sitter.js not found')
      const moduleObj = { exports: {} as unknown }
      const sandbox = { module: moduleObj, exports: moduleObj.exports, require, process, console, globalThis }
      vm.runInNewContext(code, sandbox)
      Parser = moduleObj.exports
    } catch (e) {
      throw new Error(`web-tree-sitter: both require and vm fallback failed: ${e}`)
    }
  }
  if (!Parser || typeof Parser !== 'function') {
    throw new Error('web-tree-sitter: Parser not found after all strategies')
  }
  const wasmDir = getWasmDir()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (Parser as any).init({ locateFile: (name: string) => join(wasmDir, name) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Language = (Parser as any).Language
  if (!Language) throw new Error('web-tree-sitter: Language not found after init')
  _parserLib = { Parser: Parser as { init: (opts?: unknown) => Promise<void>; new (): TSParser }, Language: Language as { load: (path: string) => Promise<TSLanguage> } }
  return _parserLib
}

async function getParser(): Promise<TSParser> {
  if (_parserInstance) return _parserInstance
  const lib = await getParserLib()
  if (!lib) throw new Error('web-tree-sitter library not initialized')
  _parserInstance = new lib.Parser()
  return _parserInstance
}

async function loadLanguage(langId: string): Promise<TSLanguage | null> {
  if (_langCache.has(langId)) return _langCache.get(langId)!
  const lib = await getParserLib()
  if (!lib) return null
  // Имена файлов в tree-sitter-wasms/out: tree-sitter-javascript.wasm, tree-sitter-c_sharp.wasm, tree-sitter-tsx.wasm
  const wasmPath = join(getWasmDir(), `tree-sitter-${langId}.wasm`)
  if (!existsSync(wasmPath)) {
    console.warn(`[fastContext] WASM not found: ${wasmPath} (lang=${langId}, wasmDir=${getWasmDir()})`)
    return null
  }
  try {
    const lang = await lib.Language.load(wasmPath)
    _langCache.set(langId, lang)
    return lang
  } catch (e) {
    console.warn(`[fastContext] failed to load language ${langId}:`, e)
    return null
  }
}

// ─── Extension → tree-sitter language id mapping ───────────────────────────
// Только языки с определениями (functions/classes/interfaces). Config-форматы
// (json/toml/css/html) убраны — они парсятся, но дают 0 definitions и удаляются
// из индекса, создавая бесполезную нагрузку.
const EXT_TO_LANG: Record<string, string> = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp',
  '.java': 'java',
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.lua': 'lua',
  '.bash': 'bash', '.sh': 'bash',
  '.dart': 'dart',
  '.elixir': 'elixir',
}

function getLangForFile(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

// ─── Symbol extraction ──────────────────────────────────────────────────────
// Унифицированный список типов узлов tree-sitter, представляющих определения.
// Разные грамматики используют разные имена — покрываем все встреченные.

const DEFINITION_NODE_TYPES = new Set([
  // functions / methods
  'function_declaration', 'function_definition', 'function_item',
  'method_definition', 'method_declaration', 'function_declarator',
  'arrow_function', 'function_expression',
  // classes / structs / interfaces / traits
  'class_declaration', 'class_definition', 'class_specifier',
  'interface_declaration', 'interface_declaration_first',
  'trait_item', 'impl_item', 'impl_block',
  'struct_declaration', 'struct_specifier', 'struct_item',
  'enum_declaration', 'enum_specifier', 'enum_item',
  'union_specifier', 'union_declaration',
  'type_declaration', 'type_alias_declaration', 'type_definition',
  'type_specifier',
  // module / namespace / package
  'module_declaration', 'module_definition', 'namespace_declaration',
  'package_declaration', 'package_clause',
  // variables (top-level / exports)
  'variable_declaration', 'lexical_declaration',
  'const_declaration', 'const_item', 'static_variable_declaration',
  // misc
  'constructor_declaration', 'destructor_declaration',
  'decorator', 'decorator_definition', 'attribute_item',
  'macro_definition', 'macro_rules',
  'protocol_declaration', 'protocol_', // swift/erlang
])

// Контейнерные типы — в них рекурсивно ищем методы/поля (class→method, interface→method)
const CONTAINER_NODE_TYPES = new Set([
  'class_declaration', 'class_definition', 'class_specifier',
  'interface_declaration', 'interface_declaration_first',
  'trait_item', 'impl_item', 'impl_block',
  'struct_declaration', 'struct_specifier', 'struct_item',
  'enum_declaration', 'enum_specifier', 'enum_item',
  'union_specifier', 'union_declaration',
  'module_declaration', 'module_definition', 'namespace_declaration',
  'package_declaration', 'package_clause',
])

// Типы узлов для ссылок (imports / requires / from-imports)
const IMPORT_NODE_TYPES = new Set([
  'import_statement', 'import_declaration', 'import_from_statement',
  'import_specifier', 'import_clause', 'use_declaration', 'use_statement',
  'package_clause', 'extern_crate_declaration', 'mod_item',
  'include_directive', 'preproc_include',
  'require_statement', 'require_expression',
  'from_import_statement',
])

export interface SymbolDef {
  name: string
  kind: string  // 'function' | 'class' | 'method' | 'variable' | ...
  lineStart: number
  lineEnd: number
  signature: string  // первая строка определения (для repo-map)
  parentName?: string  // имя родительского класса/интерфейса (для иерархии)
}

export interface FileSymbols {
  definitions: SymbolDef[]
  imports: string[]  // имена импортируемых модулей/файлов (raw строка)
  references: string[]  // уникальные идентификаторы из исходника (для call-site graph edges)
}

/** Извлекает имя определения из узла (ищет именованное поле name/declarator, затем первый identifier). */
function extractName(node: TSNode): string {
  // 1. Именованные поля (web-tree-sitter API: childForFieldName)
  if (node.childForFieldName) {
    for (const field of ['name', 'declarator', 'type', 'key']) {
      const child = node.childForFieldName(field)
      if (child && child.text) return child.text
    }
  }
  // 2. Fallback — первый named child с типом identifier
  for (const c of node.namedChildren) {
    if (c.type === 'identifier' || c.type === 'type_identifier' ||
        c.type === 'property_identifier' || c.type === 'field_identifier' ||
        c.type === 'constructor') {
      return c.text
    }
  }
  return ''
}

/** Краткая сигнатура: первая строка определения, обрезанная до 100 символов. */
function extractSignature(node: TSNode): string {
  const text = node.text || ''
  const firstLine = text.split('\n')[0]?.trim() || ''
  return firstLine.slice(0, 100)
}

/** Категория kind из типа узла. */
function kindFromNodeType(type: string): string {
  if (type.includes('function') || type.includes('method')) return 'function'
  if (type.includes('class')) return 'class'
  if (type.includes('interface') || type.includes('protocol')) return 'interface'
  if (type.includes('struct')) return 'struct'
  if (type.includes('enum')) return 'enum'
  if (type.includes('trait') || type.includes('impl')) return 'impl'
  if (type.includes('type')) return 'type'
  if (type.includes('module') || type.includes('namespace') || type.includes('package')) return 'module'
  if (type.includes('const') || type.includes('variable')) return 'variable'
  if (type.includes('constructor')) return 'constructor'
  if (type.includes('macro')) return 'macro'
  return 'definition'
}

/** Walk AST и собирает definitions + imports. Рекурсивно входит в классы/интерфейсы
 *  для извлечения методов с parentName (иерархия Class→method). */
function walkAndExtract(root: TSNode): FileSymbols {
  const definitions: SymbolDef[] = []
  const imports: string[] = []

  // Стек хранит узел + имя родительского контейнера (для методов внутри классов)
  const stack: Array<{ node: TSNode; parentName: string | null }> = [{ node: root, parentName: null }]
  const visited = new Set<TSNode>()
  let nodeCount = 0
  const MAX_NODES = 50000

  while (stack.length > 0 && nodeCount < MAX_NODES) {
    const { node, parentName } = stack.pop()!
    if (visited.has(node)) continue
    visited.add(node)
    nodeCount++

    if (DEFINITION_NODE_TYPES.has(node.type)) {
      const name = extractName(node)
      if (name) {
        definitions.push({
          name,
          kind: kindFromNodeType(node.type),
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          signature: extractSignature(node),
          parentName: parentName ?? undefined,
        })
      }
      // Контейнерные типы — рекурсивно ищем методы/поля внутри
      if (CONTAINER_NODE_TYPES.has(node.type) && name) {
        if (node.children && node.children.length > 0) {
          for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push({ node: node.children[i], parentName: name })
          }
        }
      }
      continue
    }

    if (IMPORT_NODE_TYPES.has(node.type)) {
      const text = node.text?.split('\n')[0]?.trim() || ''
      if (text) imports.push(text.slice(0, 120))
      continue
    }

    if (node.children && node.children.length > 0) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i], parentName })
      }
    }
  }

  return { definitions, imports, references: [] }
}

/** Парсит файл и извлекает символы. null = не удалось (нет грамматики / ошибка).
 *  maxFileSizeBytes — лимит размера файла (default 1.5MB). */
export async function extractSymbols(
  filePath: string,
  opts: { maxFileSizeBytes?: number } = {},
): Promise<FileSymbols | null> {
  const maxBytes = opts.maxFileSizeBytes ?? 1_500_000
  const langId = getLangForFile(filePath)
  if (!langId) return null

  const lang = await loadLanguage(langId)
  if (!lang) return null

  let source: string
  try {
    source = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
  if (!source || source.length > maxBytes) return null

  try {
    const parser = await getParser()
    parser.setLanguage(lang)
    const tree = parser.parse(source)
    if (!tree) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const root = (tree as any).rootNode as TSNode
    if (!root) return null
    const result = walkAndExtract(root)
    // Лёгкий regex-скан исходника для call-site references (имена функций/типов
    // которые используются в файле). Быстрее AST-обхода тел функций и даёт
    // сигнал для graph ranking: файл A вызывает функцию из файла B → edge A→B.
    const refSet = new Set<string>()
    const idMatches = source.matchAll(/[a-zA-Z_$][\w$]{2,}/g)
    const localDefNames = new Set(result.definitions.map(d => d.name))
    for (const m of idMatches) {
      const name = m[0]
      if (refSet.has(name)) continue
      // Не включаем собственные определения файла — нас интересуют внешние ссылки
      if (localDefNames.has(name)) continue
      refSet.add(name)
      if (refSet.size >= 200) break
    }
    result.references = Array.from(refSet)
    return result
  } catch (e) {
    console.warn(`[fastContext] parse error for ${filePath}:`, e)
    return null
  }
}

// ─── Project file walking ────────────────────────────────────────────────────

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'out', '.git', '__pycache__', '.venv', 'build',
  '.next', 'coverage', '.cache', '.turbo', '.parcel-cache', 'target',
  '.gradle', '.idea', '.vscode', '.hermes', '.mimocode', '.playwright-mcp',
  '.planning', 'logs', 'tmp', 'tmp_out', '.opencode',
])

/** Читает IndexingSettings из electron-store с мерджем дефолтов. Main-only (Store). */
export function getIndexSettings(store?: Store): IndexingSettings {
  const defaults = DEFAULT_INDEXING_SETTINGS
  if (!store) return defaults
  try {
    const all = (store as unknown as { store: Record<string, unknown> }).store
    return getIndexSettingsFromRecord(all)
  } catch {
    return defaults
  }
}

const MAX_FILES_PER_WALK = 5000  // safety limit
const IGNORED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.lib',
  '.obj', '.bin', '.dat', '.db', '.sqlite', '.db-shm', '.db-wal',
  '.o', '.a', '.class', '.jar', '.war',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.psd', '.ai', '.sketch',
  '.lock', '.log',
])

/** Walk проекта и возвращает список файлов с поддерживаемыми расширениями.
 *  Параллельный обход директорий для скорости.
 *  ignoreDirs/maxFiles необязательные — по умолчанию глобальные константы. */
export async function walkProjectFiles(
  workdir: string,
  opts: { ignoreDirs?: Set<string>; maxFiles?: number } = {},
): Promise<Array<{ path: string; mtime: number; size: number; lang: string }>> {
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE_DIRS
  const maxFiles = opts.maxFiles ?? MAX_FILES_PER_WALK
  const result: Array<{ path: string; mtime: number; size: number; lang: string }> = []
  const seen = new Set<string>()

  async function walk(dir: string, depth: number): Promise<void> {
    if (result.length >= maxFiles || depth > 8) return
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    // Фильтруем игнорируемые — сразу
    const filtered = entries.filter(name => !ignoreDirs.has(name) && !name.startsWith('.git'))
    // Параллельно stat для всех entries в директории
    const stats = await Promise.allSettled(
      filtered.map(name => {
        const full = join(dir, name)
        return stat(full).then(s => ({ name, full, s }))
      }),
    )
    // Рекурсивно обходим поддиректории параллельно
    const subdirs: Promise<void>[] = []
    for (const r of stats) {
      if (r.status !== 'fulfilled') continue
      const { name, full, s } = r.value
      if (result.length >= maxFiles) break
      if (seen.has(full)) continue
      seen.add(full)
      if (s.isDirectory()) {
        subdirs.push(walk(full, depth + 1))
      } else if (s.isFile()) {
        const ext = extname(name).toLowerCase()
        if (IGNORED_EXTS.has(ext)) continue
        const lang = getLangForFile(name)
        if (!lang) continue
        result.push({ path: full, mtime: s.mtimeMs, size: s.size, lang })
      }
    }
    await Promise.all(subdirs)
  }

  await walk(workdir, 0)
  return result
}

// ─── Indexing (incremental) ─────────────────────────────────────────────────

export interface IndexProgress {
  stage: 'indexing' | 'retrieving' | 'summarizing' | 'done'
  detail?: string
  filesProcessed?: number
  filesTotal?: number
  filesFound?: Array<{ path: string; score: number; why: string }>
}

export type ProgressCallback = (p: IndexProgress) => void

/**
 * Строит/обновляет индекс символов проекта. Incremental: для каждого файла
 * проверяет mtime+size, пере-парсит только изменившиеся. Возвращает общее
 * количество файлов в индексе.
 */
export async function buildOrUpdateIndex(
  projectId: string,
  workdir: string,
  changedPaths?: string[],
  onProgress?: ProgressCallback,
  opts: { skipEmbeddings?: boolean; settings?: IndexingSettings } = {},
): Promise<number> {
  if (!existsSync(workdir)) return 0

  let filesReIndexed = 0
  const skipEmb = opts.skipEmbeddings ?? false
  // Настройки индексации (с fallback на дефолты). Передаются из runFastContext
  // (через store) и из watcher (через IPC). Module-level константы — fallback.
  const s = opts.settings ?? DEFAULT_INDEXING_SETTINGS
  const maxBytes = s.maxFileSizeKb * 1024
  const ignoreDirs = new Set(s.ignoreDirs)

  // Если передали конкретные изменившиеся файлы — обрабатываем только их
  // (вызывается из watcher). Иначе — full scan.
  if (changedPaths && changedPaths.length > 0) {
    for (const p of changedPaths) {
      try {
        const sFile = await stat(p)
        if (!sFile.isFile()) continue
        const existing = localGetEntry(projectId, p)
        if (existing && existing.mtime === sFile.mtimeMs && existing.size === sFile.size) continue
        const lang = getLangForFile(p)
        if (!lang) {
          // файл больше не поддерживается — удаляем из индекса
          localDelete(projectId, p)
          continue
        }
        const symbols = await extractSymbols(p, { maxFileSizeBytes: maxBytes })
        if (!symbols || symbols.definitions.length === 0) {
          // файл пропал или нет определений — удаляем
          localDelete(projectId, p)
          continue
        }
        localUpsert(
          projectId, p, lang,
          JSON.stringify({ d: symbols.definitions.slice(0, 200), i: symbols.imports.slice(0, 50), r: symbols.references.slice(0, 200) }),
          sFile.mtimeMs, sFile.size,
        )
        filesReIndexed++
      } catch {
        // Файл удалён — убираем из индекса
        localDelete(projectId, p)
      }
    }
  } else {
    // Full scan
    const files = await walkProjectFiles(workdir, { ignoreDirs, maxFiles: s.maxFilesPerProject })
    if (files.length === 0) {
      console.warn(`[fastContext] walkProjectFiles returned 0 files for workdir=${workdir}`)
    }
    const existingEntries = new Map(localGetEntries(projectId).map(e => [e.filePath, e]))
    const seenPaths = new Set<string>()

    // Фильтруем только изменившиеся файлы — неизменные пропускаем сразу
    const toIndex: Array<typeof files[0]> = []
    for (const f of files) {
      seenPaths.add(f.path)
      const existing = existingEntries.get(f.path)
      if (existing && existing.mtime === f.mtime && existing.size === f.size) continue
      toIndex.push(f)
    }

    let processed = files.length - toIndex.length
    onProgress?.({
      stage: 'indexing',
      filesProcessed: processed,
      filesTotal: files.length,
      detail: toIndex.length === 0 ? 'Индекс актуален' : `Обновление ${toIndex.length} файлов`,
    })

    // Параллельный batch processing — по 8 файлов одновременно.
    // Между батчами — setImmediate чтобы не блокировать event loop (CPU friendly).
    const BATCH_SIZE = 8
    for (let i = 0; i < toIndex.length; i += BATCH_SIZE) {
      const batch = toIndex.slice(i, i + BATCH_SIZE)
      const results = await Promise.allSettled(
        batch.map(f => extractSymbols(f.path, { maxFileSizeBytes: maxBytes }).then(symbols => ({ f, symbols }))),
      )
      for (let bi = 0; bi < results.length; bi++) {
        const r = results[bi]
        processed++
        if (r.status !== 'fulfilled') continue
        const { f, symbols } = r.value
        if (!symbols || symbols.definitions.length === 0) continue
        try {
          localUpsert(
            projectId, f.path, f.lang,
            JSON.stringify({ d: symbols.definitions.slice(0, 200), i: symbols.imports.slice(0, 50), r: symbols.references.slice(0, 200) }),
            f.mtime, f.size,
          )
          filesReIndexed++
        } catch { /* skip */ }
      }
      onProgress?.({
        stage: 'indexing',
        filesProcessed: processed,
        filesTotal: files.length,
        detail: `${processed}/${files.length}`,
      })
      // Уступаем event loop между батчами — снижает CPU load на больших репо
      await new Promise<void>(r => setImmediate(r))
    }

    // Удаляем записи для файлов, которых больше нет в проекте
    for (const [path] of existingEntries) {
      if (!seenPaths.has(path)) localDelete(projectId, path)
    }
  }

  // ── Embeddings: генерируем только при full scan (не incremental watcher ticks).
  // Cap: max 200 файлов за раз — avoids CPU spike на больших репо.
  // Neural mode: ~50ms/file. TF-IDF: мгновенно.
  // skipEmb=true: pre-warm watcher не трогает ONNX (грузит CPU в простое).
  // Embeddings генерируются только при первом get_fast_context (когда нужно).
  const isFullScan = !changedPaths
  if (isFullScan && !skipEmb) {
    try {
      const allEntries = localGetEntries(projectId)
      const needEmbedding = allEntries.filter(e => !e.embedding).slice(0, 100)
      if (needEmbedding.length > 0) {
        const embedder = await getEmbedder()

        // TF-IDF: обновляем IDF cache для этого проекта
        if (embedder.mode === 'tfidf') {
          const allTexts = allEntries.map(e => {
            try {
              const parsed = JSON.parse(e.symbolsJson || '{}') as { d?: SymbolDef[]; i?: string[] }
              return fileToEmbeddingText(parsed.d ?? [], parsed.i ?? [], e.filePath)
            } catch { return '' }
          })
          updateTfidfIdf(projectId, allTexts)
        }

        // Генерируем embeddings батчами (не более 32 за раз)
        const EMBED_BATCH = 32
        for (let i = 0; i < needEmbedding.length; i += EMBED_BATCH) {
          const batch = needEmbedding.slice(i, i + EMBED_BATCH)
          await Promise.allSettled(batch.map(async e => {
            try {
              const parsed = JSON.parse(e.symbolsJson || '{}') as { d?: SymbolDef[]; i?: string[] }
              const text = fileToEmbeddingText(parsed.d ?? [], parsed.i ?? [], e.filePath)
              const emb = await embedder.embed(text)
              const db = getDb()
              db.prepare(`UPDATE fast_context_index SET embedding = ? WHERE project_id = ? AND file_path = ?`)
                .run(embeddingToBuffer(emb), projectId, e.filePath)
            } catch { /* skip */ }
          }))
        }
      }
    } catch { /* embeddings optional */ }
  }

  // Пересчёт graph ranking scores.
  // Пропускаем для incremental watcher-обновлений с малым числом изменений —
  // структурная важность файлов меняется редко, а PageRank — O(N) операция.
  // Полный пересчёт делаем на full scan или если изменилось > 5 файлов.
  // Также применяем decay к relevance_boost — старые сигналы затухают.
  const entries = localGetEntries(projectId)
  const hasZeroScores = entries.length > 0 && entries.every(e => e.rankedScore === 0)
  const shouldRecomputeRank = filesReIndexed > 5 || hasZeroScores || !changedPaths
  if (shouldRecomputeRank && entries.length > 0) {
    localDecayRelevance(projectId, 0.9)
    const scores = computeGraphRank(entries)
    localUpdateScores(projectId, scores)
  }

  return localGetEntries(projectId).length
}

// ─── Graph ranking (PageRank-style как в Aider) ─────────────────────────────

/**
 * Строит граф файлов (edges из imports + call-site references) и считает
 * PageRank-style importance. Файлы которые импортируются/используются многими
 * другими — получают больший score.
 *
 * Два типа edges:
 *   1. Import edges: file A imports from file B → edge A→B
 *      Резолвинг: path alias (@/x → src/x), relative (./x), basename fallback
 *   2. Reference edges: file A использует имя функции/типа определённое в B → edge A→B
 *      Резолвинг: точное match имени символа
 */
function computeGraphRank(entries: FastContextEntry[]): Array<{ filePath: string; rankedScore: number }> {
  if (entries.length === 0) return []

  const N = entries.length

  // Build name → [defining file indices] map (для reference edges)
  const nameToDefIdx = new Map<string, number[]>()
  // Build path-suffix → [indices] map (для alias resolution)
  const pathSuffixToIdx = new Map<string, number[]>()
  // Build basename → [indices] map (fallback)
  const basenameToIdx = new Map<string, number[]>()

  // Распарсиваем symbolsJson один раз для каждого entry
  const parsedSymbols: Array<{ d: SymbolDef[]; i: string[]; r: string[] }> = []
  for (let i = 0; i < N; i++) {
    const e = entries[i]
    let d: SymbolDef[] = []
    let imps: string[] = []
    let refs: string[] = []
    try {
      const parsed = JSON.parse(e.symbolsJson || '{}') as { d?: SymbolDef[]; i?: string[]; r?: string[] }
      d = parsed.d ?? []
      imps = parsed.i ?? []
      refs = parsed.r ?? []
    } catch { /* skip */ }
    parsedSymbols.push({ d, i: imps, r: refs })

    // name → defining file index
    for (const def of d) {
      const lower = def.name.toLowerCase()
      const arr = nameToDefIdx.get(lower) ?? []
      arr.push(i)
      nameToDefIdx.set(lower, arr)
    }

    // basename → index
    const base = e.filePath.split(sep).pop()!.replace(/\.[^.]+$/, '')
    if (base) {
      const arr = basenameToIdx.get(base) ?? []
      arr.push(i)
      basenameToIdx.set(base, arr)
    }

    // path-suffix → index (для alias resolution: 'lib/utils' → file 'src/lib/utils.ts')
    // Сохраняем 2-3 последних компонента пути без расширения
    const parts = e.filePath.replace(/\\/g, '/').split('/')
    for (let depth = 2; depth <= 3 && depth <= parts.length; depth++) {
      const suffix = parts.slice(-depth, -1).join('/') + '/' + parts[parts.length - 1].replace(/\.[^.]+$/, '')
      const arr = pathSuffixToIdx.get(suffix) ?? []
      arr.push(i)
      pathSuffixToIdx.set(suffix, arr)
    }
  }

  // 5. Build adjacency lists
  const inLinks: number[][] = entries.map(() => [])
  const outLinksCount: number[] = entries.map(() => 0)

  const addEdge = (src: number, dst: number) => {
    if (src === dst) return
    inLinks[dst].push(src)
    outLinksCount[src]++
  }

  for (let i = 0; i < N; i++) {
    const { i: imps, r: refs } = parsedSymbols[i]

    // ── Import edges с path alias resolution ──
    for (const imp of imps) {
      const match = imp.match(/['"]([^'"]+)['"]/)
      if (!match) continue
      const importPath = match[1]

      // Стратегия 1: path alias resolution (@/x → src/x, ~/x → x)
      // Берём ВСЕ candidates, не только [0] — иначе теряются edges при коллизии basename
      const aliasMatch = importPath.replace(/^[@~]/, '').replace(/^\//, '')
      const resolvedAll = new Set<number>()
      if (aliasMatch && aliasMatch !== importPath) {
        const candidates = pathSuffixToIdx.get(aliasMatch)
        if (candidates) for (const c of candidates) resolvedAll.add(c)
      }

      // Стратегия 2: basename match (fallback) — все candidates
      const base = importPath.split('/').pop()!.replace(/\.[^.]+$/, '')
      if (base && base !== '.' && base !== '..') {
        const candidates = basenameToIdx.get(base)
        if (candidates) for (const c of candidates) resolvedAll.add(c)
      }

      for (const resolved of resolvedAll) {
        if (resolved !== i) addEdge(i, resolved)
      }
    }

    // ── Reference edges (call-site → definition) ──
    // Для каждого reference name проверяем, определён ли он в другом файле
    for (const ref of refs) {
      const lower = ref.toLowerCase()
      const defIndices = nameToDefIdx.get(lower)
      if (!defIndices) continue
      for (const defIdx of defIndices) {
        if (defIdx !== i) addEdge(i, defIdx)
      }
    }
  }

  // 6. PageRank итерации
  const DAMPING = 0.85
  const ITERATIONS = 30
  let scores = new Array(N).fill(1 / N)
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const newScores = new Array(N).fill((1 - DAMPING) / N)
    for (let i = 0; i < N; i++) {
      if (outLinksCount[i] === 0) {
        // Dangling node — распределяем score равномерно
        for (let j = 0; j < N; j++) newScores[j] += DAMPING * scores[i] / N
        continue
      }
      for (const dst of inLinks[i]) {
        newScores[dst] += DAMPING * scores[i] / outLinksCount[i]
      }
    }
    scores = newScores
  }

  // 7. Нормализуем в 0..1
  const maxScore = Math.max(...scores, 1e-9)
  return entries.map((e, i) => ({
    filePath: e.filePath,
    rankedScore: scores[i] / maxScore,
  }))
}

// ─── Smart lexical match helpers ────────────────────────────────────────────

/** Разбивает camelCase / snake_case / kebab-case имя на компоненты.
 *  getUserById → ['get', 'user', 'by', 'id']
 *  parse_http_request → ['parse', 'http', 'request'] */
function splitNameParts(name: string): string[] {
  // camelCase: вставляем пробел перед заглавными В ОРИГИНАЛЬНОЙ строке
  // (не lowercased — иначе [A-Z] никогда не match!)
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(p => p.length >= 2)
  return parts
}

/** Lightweight stemmer: plural + common suffixes.
 *  users → user, authentication → auth, configuration → config */
const STEMMED_CACHE = new Map<string, string>()
function stem(word: string): string {
  const cached = STEMMED_CACHE.get(word)
  if (cached !== undefined) return cached
  let s = word
  // Plurals
  if (s.length > 4 && s.endsWith('ies')) s = s.slice(0, -3) + 'y'
  else if (s.length > 3 && s.endsWith('es')) s = s.slice(0, -2)
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1)
  // Common suffixes → abbreviation
  if (s.length > 6 && s.endsWith('tion')) s = s.slice(0, -4)
  else if (s.length > 5 && s.endsWith('ment')) s = s.slice(0, -4)
  else if (s.length > 4 && s.endsWith('ing')) s = s.slice(0, -3)
  else if (s.length > 4 && s.endsWith('er') && !s.endsWith('eer')) s = s.slice(0, -2)
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2)
  STEMMED_CACHE.set(word, s)
  return s
}

/** Levenshtein distance (для fuzzy match). Оптимизирована для коротких строк. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const m = a.length, n = b.length
  let prev = new Array(n + 1)
  let curr = new Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** Fuzzy match: token vs name с допуском 1 опечатки (для токенов ≥4 символов). */
function fuzzyMatch(token: string, name: string): boolean {
  if (token.length < 4) return false
  if (Math.abs(token.length - name.length) > 2) return false
  return levenshtein(token, name) <= 1
}

// ─── Retrieval: build repo-map slice ────────────────────────────────────────

/**
 * Выбирает top-N файлов по запросу и строит compact repo-map slice.
 * Алгоритм:
 *   1. Lexical match: токены запроса vs symbol names + filename + path
 *   2. Boost от rankedScore (PageRank importance)
 *   3. Top-N по combo score → в slice
 *
 * Возвращает строку ~maxTokens токенов для подачи в LLM.
 */
export function buildRepoMapSlice(
  projectId: string,
  query: string,
  maxFiles = 25,
  maxTokens = 4000,
  queryEmbedding?: Embedding | null,
): { slice: string; topFiles: Array<{ path: string; score: number; definitions: SymbolDef[] }> } {
  const entries = localGetEntries(projectId)
  if (entries.length === 0) return { slice: '', topFiles: [] }

  // Токены запроса (lowercase, без стоп-слов) + stemming
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'not', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'how', 'what', 'where', 'why', 'when', 'who', 'which', 'do', 'does', 'did', 'find', 'show', 'get', 'give', 'me', 'please', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those', 'my', 'your', 'его', 'её', 'их', 'где', 'что', 'как', 'какой', 'какая', 'найти', 'покажи', 'дай', 'сделай', 'сделать', 'для', 'из', 'на', 'в', 'не', 'и', 'или', 'но'])
  const queryTokens = query.toLowerCase()
    .split(/[^a-zа-я0-9_]+/i)
    .filter(t => t.length >= 2 && !stopWords.has(t))
  // Stemmed tokens для matching (user/users, auth/authentication, config/configuration)
  const queryStems = queryTokens.map(t => stem(t))
  const querySet = new Set(queryTokens)

  // Скоринг каждого файла (парсим symbolsJson ОДИН раз на файл)
  const scored: Array<{ entry: FastContextEntry; definitions: SymbolDef[]; imports: string[]; lexical: number; combo: number }> = []
  for (const e of entries) {
    let definitions: SymbolDef[] = []
    let imports: string[] = []
    try {
      const parsed = JSON.parse(e.symbolsJson || '{}') as { d?: SymbolDef[]; i?: string[]; r?: string[] }
      definitions = parsed.d ?? []
      imports = parsed.i ?? []
    } catch { /* skip */ }

    const relPath = e.filePath
    const pathLower = relPath.toLowerCase()
    const baseName = relPath.split(sep).pop()!.toLowerCase()

    let lexical = 0
    // Match в имени файла (весомее)
    for (let ti = 0; ti < queryTokens.length; ti++) {
      const t = queryTokens[ti]
      const ts = queryStems[ti]
      if (baseName.includes(t) || (ts !== t && baseName.includes(ts))) lexical += 3
      else if (pathLower.includes(t) || (ts !== t && pathLower.includes(ts))) lexical += 1
    }
    // Match в import строках (+2 за совпадение)
    const importsLower = imports.map(imp => imp.toLowerCase())
    for (let ti = 0; ti < queryTokens.length; ti++) {
      const t = queryTokens[ti]
      const ts = queryStems[ti]
      for (const imp of importsLower) {
        if (imp.includes(t) || (ts !== t && imp.includes(ts))) { lexical += 2; break }
      }
    }
    // Match в именах символов — умный: exact > component > substring > stem > fuzzy
    for (const d of definitions) {
      const nameLower = d.name.toLowerCase()
      const parts = splitNameParts(d.name)
      const nameStem = stem(nameLower)
      const partStems = parts.map(p => stem(p))
      let matchedTokens = 0
      for (let ti = 0; ti < queryTokens.length; ti++) {
        const t = queryTokens[ti]
        const ts = queryStems[ti]
        if (nameLower === t) { lexical += 5; matchedTokens++; continue }
        if (parts.includes(t)) { lexical += 3; matchedTokens++; continue }
        if (nameLower.includes(t)) { lexical += 2; matchedTokens++; continue }
        // Stem match: users → user, authentication → auth
        if (ts !== t && (nameStem === ts || partStems.includes(ts))) { lexical += 3; matchedTokens++; continue }
        // camelCase component fuzzy (опечатки в компонентах имени)
        if (parts.some(p => p.length >= 4 && fuzzyMatch(t, p))) { lexical += 1; matchedTokens++; continue }
        // Full name fuzzy (опечатки в полном имени)
        if (fuzzyMatch(t, nameLower)) { lexical += 1; matchedTokens++; continue }
      }
      // Multi-word phrase bonus: ≥2 токенов запроса совпали в одном символе
      if (matchedTokens >= 2) lexical += 2
    }
    // Soft match: query tokens anywhere in all symbol names
    if (lexical === 0 && definitions.length > 0) {
      const allNames = definitions.map(d => d.name).join(' ').toLowerCase()
      let softHits = 0
      for (const t of querySet) {
        if (allNames.includes(t)) softHits++
      }
      lexical = softHits * 0.5
    }

    // Combo: normalized lexical + rankedScore + relevance + semantic
    // Lexical нормализуем через sigmoid: lexical / (lexical + 10) → [0, 1)
    // Иначе файл с 30 символов набирает 60+ баллов и доминирует
    let semanticScore = 0
    if (queryEmbedding && e.embedding) {
      try {
        const fileEmb = bufferToEmbedding(e.embedding)
        semanticScore = cosineSimilarity(queryEmbedding, fileEmb)
      } catch { /* skip */ }
    }
    const lexicalNorm = lexical / (lexical + 10)
    const relevanceCapped = Math.min(e.relevanceBoost || 0, 5)
    const combo = lexicalNorm * 10 + e.rankedScore * 1.0 + relevanceCapped * 1.5 + semanticScore * 2.0
    if (combo <= 0) continue
    scored.push({ entry: e, definitions, imports, lexical, combo })
  }

  scored.sort((a, b) => b.combo - a.combo)
  const top = scored.slice(0, maxFiles)

  // ── Предвычисляем графы зависимостей для top файлов ──
  // importedBy: кто импортирует этот файл (dependency graph)
  // calledBy: кто вызывает символы из этого файла (call graph)
  const topPaths = new Set(top.map(s => s.entry.filePath))

  // basename → filePath для резолвинга imports
  const basenameToPath = new Map<string, string>()
  for (const e of entries) {
    const base = e.filePath.split(sep).pop()!.replace(/\.[^.]+$/, '')
    if (!basenameToPath.has(base)) basenameToPath.set(base, e.filePath)
  }

  // name → filePath для резолвинга references (call graph)
  const nameToPath = new Map<string, string>()
  for (const e of entries) {
    let defs: SymbolDef[] = []
    try { defs = (JSON.parse(e.symbolsJson || '{}') as { d?: SymbolDef[] }).d ?? [] } catch { /* skip */ }
    for (const d of defs) {
      if (!nameToPath.has(d.name.toLowerCase())) nameToPath.set(d.name.toLowerCase(), e.filePath)
    }
  }

  // Строим importedBy и calledBy для top файлов
  const importedBy = new Map<string, string[]>()
  const calledBy = new Map<string, string[]>()
  for (const s of top) { importedBy.set(s.entry.filePath, []); calledBy.set(s.entry.filePath, []) }

  for (const e of entries) {
    let imps: string[] = []
    let refs: string[] = []
    try {
      const parsed = JSON.parse(e.symbolsJson || '{}') as { i?: string[]; r?: string[] }
      imps = parsed.i ?? []; refs = parsed.r ?? []
    } catch { /* skip */ }

    // importedBy: если e импортирует файл из top
    for (const imp of imps) {
      const match = imp.match(/['"]([^'"]+)['"]/)
      if (!match) continue
      const base = match[1].split('/').pop()!.replace(/\.[^.]+$/, '')
      const target = basenameToPath.get(base)
      if (target && topPaths.has(target) && target !== e.filePath) {
        importedBy.get(target)!.push(e.filePath)
      }
    }

    // calledBy: если e ссылается на символ из top файла
    for (const ref of refs) {
      const target = nameToPath.get(ref.toLowerCase())
      if (target && topPaths.has(target) && target !== e.filePath) {
        calledBy.get(target)!.push(e.filePath)
      }
    }
  }

  // ── Детект архитектурных хабов ──
  const ENTRY_PATTERNS = /^(index|main|app|server|cli|entry|bootstrap)\.[a-z]+$/i
  const isEntryPoint = (path: string) => ENTRY_PATTERNS.test(path.split(sep).pop() || '')

  // ── Строим slice (compact outline): file → signatures + graph ──
  const lines: string[] = []
  let tokens = 0
  const topFiles: Array<{ path: string; score: number; definitions: SymbolDef[] }> = []

  for (const s of top) {
    const relPath = s.entry.filePath
    topFiles.push({ path: relPath, score: s.combo, definitions: s.definitions })

    // Заголовок файла + маркер хаба
    const hub = isEntryPoint(relPath) ? ' [entry]' : s.entry.rankedScore > 0.7 ? ' [hub]' : ''
    const header = `${relPath}:${hub}`
    lines.push(header)
    tokens += Math.ceil(header.length / 4)

    // Сигнатуры — с иерархией: methods под своим class (indent)
    const priority: Array<{ d: SymbolDef; w: number }> = s.definitions.map(d => ({
      d,
      w: d.kind === 'class' ? 5 : d.kind === 'interface' ? 4 : d.kind === 'function' ? 3 : d.kind === 'method' ? 2 : 1,
    }))
    priority.sort((a, b) => b.w - a.w)

    // Группируем: сначала контейнеры (class/interface), потом их методы, потом остальные
    const containerFirst = priority.filter(p => p.d.parentName === undefined && (p.d.kind === 'class' || p.d.kind === 'interface' || p.d.kind === 'struct' || p.d.kind === 'impl'))
    const standalone = priority.filter(p => p.d.parentName === undefined && !(p.d.kind === 'class' || p.d.kind === 'interface' || p.d.kind === 'struct' || p.d.kind === 'impl'))
    const methods = priority.filter(p => p.d.parentName !== undefined)

    const parentNameToMethods = new Map<string, SymbolDef[]>()
    for (const m of methods) {
      const arr = parentNameToMethods.get(m.d.parentName!) ?? []
      arr.push(m.d)
      parentNameToMethods.set(m.d.parentName!, arr)
    }

    let shownCount = 0
    const emitSymbol = (d: SymbolDef, indent: number) => {
      if (shownCount >= 12) return
      const pad = ' '.repeat(indent)
      const line = `${pad}L${d.lineStart} ${d.kind} ${d.signature}`
      lines.push(line)
      tokens += Math.ceil(line.length / 4)
      shownCount++
    }

    // Контейнеры с их методами (иерархия)
    for (const { d } of containerFirst) {
      if (shownCount >= 12) break
      emitSymbol(d, 2)
      const childMethods = parentNameToMethods.get(d.name) ?? []
      for (const m of childMethods) {
        if (shownCount >= 12) break
        emitSymbol(m, 4)
      }
    }
    // Standalone functions/variables
    for (const { d } of standalone) {
      if (shownCount >= 12) break
      emitSymbol(d, 2)
    }
    if (tokens > maxTokens) break

    // Imports — зависимости файла
    if (s.imports.length > 0) {
      const impLine = `  imports: ${s.imports.slice(0, 5).join(', ')}`
      lines.push(impLine)
      tokens += Math.ceil(impLine.length / 4)
    }

    // Imported by — кто зависит от этого файла
    const ib = importedBy.get(relPath) ?? []
    if (ib.length > 0) {
      const shortIb = ib.slice(0, 3).map(p => p.split(sep).pop()).join(', ')
      const ibLine = `  imported by: ${shortIb}${ib.length > 3 ? ` +${ib.length - 3}` : ''}`
      lines.push(ibLine)
      tokens += Math.ceil(ibLine.length / 4)
    }

    // Called by — кто вызывает символы из этого файла
    const cb = calledBy.get(relPath) ?? []
    if (cb.length > 0) {
      const shortCb = cb.slice(0, 3).map(p => p.split(sep).pop()).join(', ')
      const cbLine = `  called by: ${shortCb}${cb.length > 3 ? ` +${cb.length - 3}` : ''}`
      lines.push(cbLine)
      tokens += Math.ceil(cbLine.length / 4)
    }

    lines.push('')
    if (tokens > maxTokens) break
  }

  return { slice: lines.join('\n'), topFiles }
}

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
function extractJsonFromLlmResponse(raw: string): { files?: unknown[]; summary?: string } | null {
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

async function summarizeWithLLM(
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

// ─── Content snippets (читаем куски кода top файлов для LLM) ─────────────────

/**
 * Multi-symbol snippets: для top-N файлов берёт до 3 query-relevant символов,
 * 30 строк вокруг каждого. Даёт LLM реальный код для более точного выбора.
 * Символы сортируются по query-relevance (lexical match), не по порядку в файле.
 */
async function buildContentSnippets(
  topFiles: Array<{ path: string; definitions: SymbolDef[]; score?: number }>,
  maxFiles = 5,
  maxSymbolsPerFile = 3,
  linesPerSnippet = 30,
  queryTokens: string[] = [],
): Promise<string> {
  const snippets: string[] = []
  const filesToRead = topFiles.slice(0, maxFiles)
  const queryStemsLocal = queryTokens.map(t => stem(t))

  const results = await Promise.allSettled(
    filesToRead.map(async f => {
      let source: string
      try { source = await readFile(f.path, 'utf-8') } catch { return null }
      if (!source || source.length > 500_000) return null

      const lines = source.split('\n')
      // Sort definitions by query-relevance: exact > component > substring > stem
      const scoredDefs = f.definitions
        .filter(d => d.lineStart > 0 && d.lineStart <= lines.length)
        .map(d => {
          const nameLower = d.name.toLowerCase()
          const parts = splitNameParts(d.name)
          const nameStem = stem(nameLower)
          let ds = 0
          for (let ti = 0; ti < queryTokens.length; ti++) {
            const t = queryTokens[ti]
            const ts = queryStemsLocal[ti]
            if (nameLower === t) ds += 5
            else if (parts.includes(t)) ds += 3
            else if (nameLower.includes(t)) ds += 2
            else if (ts !== t && (nameStem === ts || parts.some(p => stem(p) === ts))) ds += 3
          }
          return { def: d, ds }
        })
        .sort((a, b) => b.ds - a.ds)
        .slice(0, maxSymbolsPerFile)

      if (scoredDefs.length === 0) return null

      const parts: string[] = []
      const usedRanges: Array<[number, number]> = []
      for (const { def } of scoredDefs) {
        const center = def.lineStart - 1
        const half = Math.floor(linesPerSnippet / 2)
        const start = Math.max(0, center - half)
        const end = Math.min(lines.length, center + half)
        // Dedup overlapping ranges
        if (usedRanges.some(([s, e]) => start < e && end > s)) continue
        usedRanges.push([start, end])
        const snippet = lines.slice(start, end)
          .map((line, i) => `${start + i + 1}: ${line}`)
          .join('\n')
        parts.push(`  L${def.lineStart} ${def.kind} ${def.name}:\n${snippet}`)
      }

      return parts.length > 0 ? `--- ${f.path} ---\n${parts.join('\n\n')}` : null
    }),
  )

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) snippets.push(r.value)
  }

  return snippets.length > 0 ? '\n\n--- Content snippets ---\n\n' + snippets.join('\n\n') : ''
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Главная точка входа — вызывается тулзой get_fast_context.
 * Шлёт progress callbacks для 3-stage UI (indexing → retrieving → summarizing).
 */
export async function runFastContext(
  projectId: string,
  workdir: string,
  query: string,
  store: Store,
  opts: { maxFiles?: number; maxTokens?: number; signal?: AbortSignal } = {},
  onProgress?: ProgressCallback,
): Promise<FastContextResult> {
  const startedAt = Date.now()
  const maxFiles = opts.maxFiles ?? 50
  const maxTokens = opts.maxTokens ?? 8000

  // Читаем настройки индексации из store и применяем neural-режим.
  // setUseNeuralEmbeddings переключает embedder: ONNX/MiniLM vs TF-IDF.
  const idxSettings = getIndexSettings(store)
  setUseNeuralEmbeddings(idxSettings.neuralEmbeddings)

  // Устанавливаем active project для TF-IDF (per-project IDF cache)
  setActiveProjectId(projectId)

  // Stage 1: indexing (incremental, обычно мгновенно если индекс уже тёплый)
  onProgress?.({ stage: 'indexing', detail: 'Сканирование файлов', filesProcessed: 0, filesTotal: 0 })
  const indexedCount = await buildOrUpdateIndex(projectId, workdir, undefined, onProgress, { settings: idxSettings })

  // Stage 2: retrieving
  onProgress?.({ stage: 'retrieving', detail: `Поиск по ${indexedCount} файлам`, filesProcessed: 0, filesTotal: 0 })
  // Semantic: embed query для cosine similarity vs file embeddings
  let queryEmb: Embedding | null = null
  try {
    const embedder = await getEmbedder()
    queryEmb = await embedder.embed(query)
  } catch { /* embeddings опциональны — lexical-only fallback */ }
  const { slice, topFiles } = buildRepoMapSlice(projectId, query, maxFiles, maxTokens, queryEmb)

  if (topFiles.length === 0) {
    onProgress?.({ stage: 'done', detail: 'Ничего не найдено' })
    return {
      files: [],
      summary: 'Не найдено релевантных файлов по запросу. Возможно индекс пуст или запрос не matches ни одному символу.',
      ms: Date.now() - startedAt,
      indexedFilesCount: indexedCount,
    }
  }

  // Emit найденных файлов для live-UI (chips появляются по мере "нахождения")
  onProgress?.({
    stage: 'retrieving',
    detail: `Найдено ${topFiles.length} файлов`,
    filesFound: topFiles.map(f => ({
      path: f.path,
      score: f.score,
      why: `${f.definitions.length} symbols, score ${f.score.toFixed(2)}`,
    })),
  })

  // Content snippets: читаем top-5 файлов (50 строк вокруг релевантного символа).
  // Даёт LLM реальный код для более точного выбора файлов и line ranges.
  onProgress?.({ stage: 'retrieving', detail: 'Чтение content snippets', filesProcessed: 0, filesTotal: 0 })
  // Токенизируем query для query-relevant snippets (внешний scope, т.к. buildRepoMapSlice — отдельная функция)
  const stopWordsOuter = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'not', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'how', 'what', 'where', 'why', 'when', 'who', 'which', 'do', 'does', 'did', 'find', 'show', 'get', 'give', 'me', 'please', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'this', 'that', 'these', 'those', 'my', 'your', 'его', 'её', 'их', 'где', 'что', 'как', 'какой', 'какая', 'найти', 'покажи', 'дай', 'сделай', 'сделать', 'для', 'из', 'на', 'в', 'не', 'и', 'или', 'но'])
  const outerQueryTokens = query.toLowerCase()
    .split(/[^a-zа-я0-9_]+/i)
    .filter(t => t.length >= 2 && !stopWordsOuter.has(t))
  const snippets = await buildContentSnippets(topFiles, 5, 3, 30, outerQueryTokens)
  const fullSlice = snippets ? slice + snippets : slice

  // Stage 3: summarizing (LLM вызов)
  onProgress?.({ stage: 'summarizing', detail: `LLM анализ ${topFiles.length} файлов`, filesProcessed: 0, filesTotal: 0 })
  const llmResult = await summarizeWithLLM(store, query, fullSlice, opts.signal)

  onProgress?.({ stage: 'done', detail: `${llmResult?.files.length ?? 0} файлов найдено` })

  // Валидация путей LLM: оставляем только файлы из topFiles (drop hallucinations).
  // Если LLM вернул неточный путь — пытаемся сопоставить по basename.
  const validPaths = new Set(topFiles.map(f => f.path))
  const basenameMap = new Map<string, string>()
  for (const f of topFiles) {
    const base = f.path.split(sep).pop()!.toLowerCase()
    if (!basenameMap.has(base)) basenameMap.set(base, f.path)
  }

  const validatedFiles: FastContextFile[] = []
  if (llmResult?.files && llmResult.files.length > 0) {
    for (const f of llmResult.files) {
      if (validPaths.has(f.path)) {
        validatedFiles.push(f)
        continue
      }
      // Fuzzy: match by basename
      const base = f.path.split('/').pop()!.split('\\').pop()!.toLowerCase()
      const matched = basenameMap.get(base)
      if (matched) {
        validatedFiles.push({ ...f, path: matched })
      }
      // Полностью несопоставленные пути отбрасываем (hallucinations)
    }
  }

  // Если LLM не вернул валидных files — fallback: topFiles из retrieval
  const files = validatedFiles.length > 0
    ? validatedFiles
    : topFiles.slice(0, maxFiles).map(f => ({
        path: f.path,
        lineRanges: f.definitions.length > 0 ? `${f.definitions[0].lineStart}-${f.definitions[0].lineEnd}` : '',
        why: `Top match (score: ${f.score.toFixed(2)}, ${f.definitions.length} symbols)`,
      }))

  return {
    files,
    summary: llmResult?.summary || `Найдено ${files.length} релевантных файлов по запросу.`,
    ms: Date.now() - startedAt,
    indexedFilesCount: indexedCount,
  }
}

/** Принудительно очищает индекс проекта (для /reindex или удаления проекта). */
export function resetFastContextIndex(projectId: string): void {
  getDb().prepare(`DELETE FROM fast_context_index WHERE project_id = ?`).run(projectId)
}

/** Возвращает статистику индекса (для UI badge). */
export function getFastContextStats(projectId: string): { fileCount: number; lastUpdated: number | null } {
  const entries = localGetEntries(projectId)
  const lastUpdated = entries.reduce((max, e) => Math.max(max, e.updatedAt), 0)
  return { fileCount: entries.length, lastUpdated: lastUpdated || null }
}
