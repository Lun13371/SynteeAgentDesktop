/**
 * mapResolver — превращает сырой разбор sidecar в рёбра графа.
 *
 * Два канала:
 *  - imports → файл проекта (resolved) или внешний пакет (external);
 *  - calls   → определение: своя область → импортированное имя → уникальное
 *              совпадение по проекту (heuristic) → несколько кандидатов (ambiguous).
 *
 * Резолвинг импортов покрыт по всем языкам sidecar (TS/JS, Python, Rust, Go,
 * C/C++, Java, C#, Ruby, PHP, Bash). Там, где точное сопоставление невозможно
 * без типов, ребро помечается heuristic/ambiguous — карта честна о неуверенности.
 */
import * as path from 'path'
import type { SidecarImportDetail, SidecarCallSite, SidecarDefinition } from '../sidecar/sidecarClient'
import type { CodeMapNode, CodeMapEdge, CodeEdgePrecision } from '../../shared/projectMap'
import { fileNodeId, symbolNodeId, packageNodeId, edgeId, ensurePackageNode } from './mapStore'

const posix = path.posix

/** Индекс проекта для резолвинга: все файлы + определения по имени/файлу. */
export class ProjectIndex {
  projectId: string
  workdir: string
  files = new Set<string>()
  defsByName = new Map<string, CodeMapNode[]>()
  defsByFile = new Map<string, CodeMapNode[]>()
  /** tsconfig paths aliases: "@/x" → "src/x". */
  aliases = new Map<string, string>()

  constructor(projectId: string, workdir: string) {
    this.projectId = projectId
    this.workdir = workdir
  }

  addFileNodes(filePath: string, nodes: CodeMapNode[]): void {
    this.files.add(filePath)
    this.defsByFile.set(filePath, nodes)
    for (const n of nodes) {
      if (n.kind === 'file' || n.kind === 'package') continue
      const list = this.defsByName.get(n.name) ?? []
      list.push(n)
      this.defsByName.set(n.name, list)
    }
  }

  removeFile(filePath: string): void {
    this.files.delete(filePath)
    const old = this.defsByFile.get(filePath) ?? []
    this.defsByFile.delete(filePath)
    for (const n of old) {
      const list = this.defsByName.get(n.name)
      if (!list) continue
      const next = list.filter(x => x.filePath !== filePath)
      if (next.length === 0) this.defsByName.delete(n.name)
      else this.defsByName.set(n.name, next)
    }
  }
}

// ─── Импорт → файл / пакет ───────────────────────────────────────────────────

export type ImportTarget =
  | { kind: 'file'; path: string }
  | { kind: 'package'; name: string }
  | { kind: 'unresolved' }

const TS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']
const PY_EXTS = ['.py', '.pyi']

/** Попробовать найти файл в индексе по набору кандидатов. */
function lookupFile(index: ProjectIndex, candidates: string[]): string | null {
  for (const c of candidates) {
    const norm = posix.normalize(c)
    if (index.files.has(norm)) return norm
  }
  return null
}

/** Кандидаты для модуля без расширения: сам путь + расширения + /index.*. */
function moduleCandidates(base: string, exts: string[]): string[] {
  const out = [base]
  for (const ext of exts) out.push(base + ext)
  for (const ext of exts) out.push(posix.join(base, 'index' + ext))
  return out
}

export function resolveImportSource(
  index: ProjectIndex,
  fromFile: string,
  source: string,
  language: string | null,
): ImportTarget {
  const src = source.trim()
  if (!src) return { kind: 'unresolved' }
  const dir = posix.dirname(fromFile)
  const lang = language ?? ''

  // ── TS / JS / TSX ──
  if (lang === 'typescript' || lang === 'javascript' || lang === 'tsx') {
    if (src.startsWith('.')) {
      const base = posix.join(dir, src)
      const found = lookupFile(index, moduleCandidates(base, TS_EXTS))
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' }
    }
    // tsconfig aliases
    for (const [alias, target] of index.aliases) {
      const prefix = alias.endsWith('*') ? alias.slice(0, -1) : alias
      if (src === alias || src.startsWith(prefix)) {
        const rest = src.slice(prefix.length)
        const base = posix.join(target, rest)
        const found = lookupFile(index, moduleCandidates(base, TS_EXTS))
        if (found) return { kind: 'file', path: found }
      }
    }
    // baseUrl-style non-relative (src/...) — попробуем как файл от корня
    const rootCandidate = lookupFile(index, moduleCandidates(src, TS_EXTS))
    if (rootCandidate) return { kind: 'file', path: rootCandidate }
    return { kind: 'package', name: packageName(src) }
  }

  // ── Python ──
  if (lang === 'python') {
    if (src.startsWith('.')) {
      const dots = src.match(/^\.+/)?.[0].length ?? 1
      const up = dots - 1
      let baseDir = dir
      for (let i = 0; i < up; i++) baseDir = posix.dirname(baseDir)
      const rest = src.slice(dots).replace(/\./g, '/')
      const base = rest ? posix.join(baseDir, rest) : baseDir
      const found = lookupFile(index, moduleCandidates(base, PY_EXTS))
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' }
    }
    const rel = src.replace(/\./g, '/')
    const found = lookupFile(index, [
      ...moduleCandidates(rel, PY_EXTS),
      ...moduleCandidates(posix.join('src', rel), PY_EXTS),
      ...moduleCandidates(posix.join(dir, rel), PY_EXTS),
    ])
    return found ? { kind: 'file', path: found } : { kind: 'package', name: packageName(src) }
  }

  // ── Rust ──
  if (lang === 'rust') {
    let base: string | null = null
    if (src.startsWith('crate::') || src.startsWith('crate')) {
      base = posix.join('src', src.replace(/^crate::?/, '').replace(/::/g, '/'))
    } else if (src.startsWith('super::')) {
      base = posix.join(posix.dirname(dir), src.replace(/^super::/, '').replace(/::/g, '/'))
    } else if (src.startsWith('self::')) {
      base = posix.join(dir, src.replace(/^self::/, '').replace(/::/g, '/'))
    } else if (!src.includes('::') && !src.startsWith('std')) {
      // `mod foo;` — локальный модуль
      base = posix.join(dir, src)
    }
    if (base) {
      const found = lookupFile(index, [base + '.rs', posix.join(base, 'mod.rs'), base])
      if (found) return { kind: 'file', path: found }
    }
    return { kind: 'package', name: packageName(src.split('::')[0]) }
  }

  // ── Go ──
  if (lang === 'go') {
    if (src.startsWith('.')) {
      const base = posix.join(dir, src)
      const found = lookupFile(index, [base, base + '.go'])
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' }
    }
    // Локальный пакет модуля: попробуем суффикс пути как папку от корня
    const segments = src.split('/')
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(i).join('/')
      if (index.files.has(suffix) || [...index.files].some(f => f.startsWith(suffix + '/'))) {
        return { kind: 'file', path: suffix }
      }
    }
    return { kind: 'package', name: src }
  }

  // ── C / C++ ──
  if (lang === 'c' || lang === 'cpp') {
    if (src.startsWith('"') || !src.includes('/')) {
      const clean = src.replace(/^["<]|[" >]$/g, '')
      const found = lookupFile(index, [posix.join(dir, clean), clean, posix.join('src', clean), posix.join('include', clean)])
      if (found) return { kind: 'file', path: found }
    }
    return { kind: 'package', name: src.replace(/[<>"]/g, '') }
  }

  // ── Java ──
  if (lang === 'java') {
    const rel = src.replace(/\./g, '/')
    const found = lookupFile(index, [
      rel + '.java',
      posix.join('src/main/java', rel) + '.java',
      posix.join('src', rel) + '.java',
    ])
    return found ? { kind: 'file', path: found } : { kind: 'package', name: packageName(src) }
  }

  // ── C# ──
  if (lang === 'c_sharp') {
    const last = src.split('.').pop() ?? src
    const matches = [...index.files].filter(f => f.endsWith('/' + last + '.cs') || f === last + '.cs')
    if (matches.length === 1) return { kind: 'file', path: matches[0] }
    return { kind: 'package', name: src }
  }

  // ── Ruby ──
  if (lang === 'ruby') {
    if (src.startsWith('.')) {
      const base = posix.join(dir, src)
      const found = lookupFile(index, [base, base + '.rb'])
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' }
    }
    const found = lookupFile(index, moduleCandidates(src, ['.rb']))
    return found ? { kind: 'file', path: found } : { kind: 'package', name: packageName(src) }
  }

  // ── PHP ──
  if (lang === 'php') {
    if (src.startsWith('.') || src.endsWith('.php')) {
      const base = posix.join(dir, src)
      const found = lookupFile(index, [base, base + '.php'])
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' }
    }
    const last = src.split('\\').pop() ?? src
    const matches = [...index.files].filter(f => f.endsWith('/' + last + '.php') || f === last + '.php')
    if (matches.length === 1) return { kind: 'file', path: matches[0] }
    return { kind: 'package', name: src }
  }

  // ── Bash ──
  if (lang === 'bash') {
    const base = src.startsWith('.') ? posix.join(dir, src) : src
    const found = lookupFile(index, [base, base + '.sh'])
    return found ? { kind: 'file', path: found } : { kind: 'unresolved' }
  }

  // ── Swift ──
  if (lang === 'swift') {
    // `import Foundation` — модуль (system или SwiftPM-таргет); `import class A.B`.
    const mod = src.replace(/^@testable\s+/, '').replace(/^(?:class|struct|enum|protocol|func|var|let|typealias)\s+/, '').split('.')[0].trim()
    if (!mod) return { kind: 'unresolved' }
    const matches = [...index.files].filter(f =>
      f === mod + '.swift' || f.endsWith('/' + mod + '.swift') || f.startsWith(mod + '/') || f.includes('/' + mod + '/'))
    if (matches.length === 1) return { kind: 'file', path: matches[0] }
    return { kind: 'package', name: mod }
  }

  // ── Kotlin / Scala (JVM: package-путь → файл) ──
  if (lang === 'kotlin' || lang === 'scala') {
    const ext = lang === 'kotlin' ? '.kt' : '.scala'
    const rel = src.replace(/\.(kt|kts|scala)$/, '').replace(/\./g, '/')
    const last = rel.split('/').pop() ?? rel
    const found = lookupFile(index, [
      rel + ext,
      posix.join('src/main/kotlin', rel) + ext,
      posix.join('src/main/scala', rel) + ext,
      posix.join('src', rel) + ext,
    ])
    if (found) return { kind: 'file', path: found }
    // Верхнеуровневые функции/объекты живут в одноимённых файлах.
    const matches = [...index.files].filter(f => f.endsWith('/' + last + ext) || f === last + ext)
    if (matches.length === 1) return { kind: 'file', path: matches[0] }
    return { kind: 'package', name: src.split('.').slice(0, 2).join('.') }
  }

  // ── Dart ──
  if (lang === 'dart') {
    const clean = src.replace(/^["']|["']$/g, '')
    if (clean.startsWith('package:') || clean.startsWith('dart:')) {
      const pkgPath = clean.replace(/^package:/, '')
      const local = lookupFile(index, [posix.join('lib', pkgPath), pkgPath, posix.join('lib/src', pkgPath)])
      if (local) return { kind: 'file', path: local }
      return { kind: 'package', name: clean.replace(/^package:/, '').split('/')[0] }
    }
    if (clean.startsWith('.')) {
      const base = posix.join(dir, clean)
      const found = lookupFile(index, [base, base + '.dart'])
      return found ? { kind: 'file', path: found } : { kind: 'unresolved' }
    }
    return { kind: 'package', name: clean.split('/')[0] }
  }

  // ── Elixir ──
  if (lang === 'elixir') {
    const mod = src.split('.').pop() ?? src
    const snake = mod.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
    const matches = [...index.files].filter(f =>
      f.endsWith('/' + snake + '.ex') || f.endsWith('/' + snake + '.exs') ||
      f.endsWith('/' + mod + '.ex') || f === snake + '.ex')
    if (matches.length === 1) return { kind: 'file', path: matches[0] }
    return { kind: 'package', name: src.split('.').slice(0, 2).join('.') }
  }

  // ── Lua ──
  if (lang === 'lua') {
    const clean = src.replace(/^["']|["']$/g, '').replace(/\./g, '/')
    const found = lookupFile(index, [clean + '.lua', posix.join(dir, clean) + '.lua', clean])
    if (found) return { kind: 'file', path: found }
    return { kind: 'package', name: clean.split('/')[0] }
  }

  // ── Прочее (json/yaml/lexical) ──
  const generic = lookupFile(index, [posix.join(dir, src), src])
  return generic ? { kind: 'file', path: generic } : { kind: 'package', name: packageName(src) }
}

/** Имя внешнего пакета из спецификатора (@scope/name → @scope/name, name/x → name). */
function packageName(src: string): string {
  const clean = src.replace(/^["'<]|["'>]$/g, '')
  if (clean.startsWith('@')) {
    const parts = clean.split('/')
    return parts.slice(0, 2).join('/')
  }
  return clean.split('/')[0].split('::')[0].split('.')[0]
}

// ─── Рёбра импортов файла ────────────────────────────────────────────────────

export function resolveFileImports(
  index: ProjectIndex,
  fromFile: string,
  imports: SidecarImportDetail[],
  language: string | null,
): { edges: CodeMapEdge[]; packages: string[] } {
  const edges: CodeMapEdge[] = []
  const packages = new Set<string>()
  const fromId = fileNodeId(fromFile)
  const seen = new Set<string>()

  for (const imp of imports) {
    const target = resolveImportSource(index, fromFile, imp.source, language)
    let toId: string
    let precision: CodeEdgePrecision
    if (target.kind === 'file') {
      toId = fileNodeId(target.path)
      precision = 'resolved'
    } else if (target.kind === 'package') {
      toId = packageNodeId(target.name)
      packages.add(target.name)
      precision = 'external'
    } else {
      continue
    }
    const key = `${toId}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      id: edgeId(fromId, 'imports', toId, imp.line),
      projectId: index.projectId,
      fromNode: fromId,
      toNode: toId,
      type: 'imports',
      precision,
      filePath: fromFile,
      line: imp.line,
    })
  }
  return { edges, packages: [...packages] }
}

// ─── Рёбра вызовов файла ─────────────────────────────────────────────────────

const BUILTIN_CALLS = new Set([
  'require', 'import', 'console', 'log', 'warn', 'error', 'info', 'debug',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseInt',
  'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Promise',
  'JSON', 'Math', 'Map', 'Set', 'Date', 'RegExp', 'Error', 'fetch', 'print',
  'println', 'printf', 'len', 'range', 'enumerate', 'isinstance', 'super',
])

interface CallContext {
  index: ProjectIndex
  fromFile: string
  fileDefs: CodeMapNode[]
  /** Имя импортированной привязки → путь файла-источника. */
  importedBindings: Map<string, string>
}

function buildImportBindings(
  index: ProjectIndex,
  fromFile: string,
  imports: SidecarImportDetail[],
  language: string | null,
): Map<string, string> {
  const bindings = new Map<string, string>()
  for (const imp of imports) {
    const target = resolveImportSource(index, fromFile, imp.source, language)
    if (target.kind !== 'file') continue
    for (const name of imp.names) bindings.set(name, target.path)
    // import * as ns / default — привязываем и последнее сегмент источника
    const last = imp.source.split('/').pop()?.replace(/\.[^.]+$/, '')
    if (last) bindings.set(last, target.path)
  }
  return bindings
}

function findDefInFile(index: ProjectIndex, filePath: string, name: string): CodeMapNode | null {
  const defs = index.defsByFile.get(filePath) ?? []
  return defs.find(d => d.name === name && d.kind !== 'file') ?? null
}

/**
 * Языковые семьи по расширению: heuristic-совпадение имени не должно
 * перелетать границы (tsx-компонент «вызывает» python-функцию backend'а —
 * почти всегда коллизия имён, как AdminLogin.tsx → backend login).
 */
const EXT_FAMILY: Record<string, string> = {}
for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.d.ts']) EXT_FAMILY[ext] = 'web'
for (const ext of ['.py', '.pyi']) EXT_FAMILY[ext] = 'python'
for (const ext of ['.rs']) EXT_FAMILY[ext] = 'rust'
for (const ext of ['.go']) EXT_FAMILY[ext] = 'go'
for (const ext of ['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx']) EXT_FAMILY[ext] = 'c'
for (const ext of ['.java']) EXT_FAMILY[ext] = 'java'
for (const ext of ['.cs']) EXT_FAMILY[ext] = 'csharp'
for (const ext of ['.rb']) EXT_FAMILY[ext] = 'ruby'
for (const ext of ['.php']) EXT_FAMILY[ext] = 'php'
for (const ext of ['.sh', '.bash']) EXT_FAMILY[ext] = 'bash'
for (const ext of ['.swift']) EXT_FAMILY[ext] = 'swift'
for (const ext of ['.kt', '.kts', '.scala']) EXT_FAMILY[ext] = 'jvm'
for (const ext of ['.dart']) EXT_FAMILY[ext] = 'dart'
for (const ext of ['.ex', '.exs']) EXT_FAMILY[ext] = 'elixir'
for (const ext of ['.lua']) EXT_FAMILY[ext] = 'lua'

function sameLanguageFamily(a: string, b: string): boolean {
  const fa = EXT_FAMILY[a.toLowerCase()]
  const fb = EXT_FAMILY[b.toLowerCase()]
  if (!fa || !fb) return true // неизвестное расширение — не фильтруем
  return fa === fb
}

function resolveCall(ctx: CallContext, call: SidecarCallSite): { toId: string; precision: CodeEdgePrecision } | null {
  const { index, fromFile, fileDefs, importedBindings } = ctx
  const name = call.name
  if (BUILTIN_CALLS.has(name)) return null

  // 1) Вызов с receiver: ищем метод в файле, откуда receiver импортирован.
  if (call.receiver) {
    const receiverFile = importedBindings.get(call.receiver)
    if (receiverFile) {
      const def = findDefInFile(index, receiverFile, name)
      if (def) return { toId: def.id, precision: 'resolved' }
    }
    // receiver — класс в проекте (статический вызов Store.load())
    const receiverDefs = index.defsByName.get(call.receiver) ?? []
    const cls = receiverDefs.find(d => d.kind === 'class' || d.kind === 'struct')
    if (cls) {
      const method = (index.defsByFile.get(cls.filePath) ?? []).find(d => d.name === name && d.parentName === cls.name)
      if (method) return { toId: method.id, precision: 'heuristic' }
    }
  }

  // 2) Локальное определение в том же файле.
  const local = fileDefs.find(d => d.name === name)
  if (local) return { toId: local.id, precision: 'resolved' }

  // 3) Импортированная привязка.
  const importedFile = importedBindings.get(name)
  if (importedFile) {
    const def = findDefInFile(index, importedFile, name)
    if (def) return { toId: def.id, precision: 'resolved' }
    return { toId: fileNodeId(importedFile), precision: 'heuristic' }
  }

  // 4) Глобальное совпадение по имени — только в той же языковой семье.
  const all = (index.defsByName.get(name) ?? []).filter(d => d.kind !== 'file' && d.kind !== 'package')
  if (all.length === 0) return null
  const candidates = all.filter(d => sameLanguageFamily(fromFile, d.filePath))
  if (candidates.length === 0) return null // коллизия через границу языков — ребро не даём
  if (candidates.length === 1) return { toId: candidates[0].id, precision: 'heuristic' }

  // Несколько кандидатов: предпочитаем тот же каталог, иначе ambiguous (до 3).
  const dir = posix.dirname(fromFile)
  const sameDir = candidates.filter(d => posix.dirname(d.filePath) === dir)
  if (sameDir.length === 1) return { toId: sameDir[0].id, precision: 'heuristic' }
  return { toId: candidates[0].id, precision: 'ambiguous' }
}

export function resolveFileCalls(
  index: ProjectIndex,
  fromFile: string,
  calls: SidecarCallSite[],
  imports: SidecarImportDetail[],
  language: string | null,
): CodeMapEdge[] {
  const fileDefs = index.defsByFile.get(fromFile) ?? []
  const importedBindings = buildImportBindings(index, fromFile, imports, language)
  const ctx: CallContext = { index, fromFile, fileDefs, importedBindings }
  const edges: CodeMapEdge[] = []
  const seen = new Set<string>()

  for (const call of calls) {
    const resolved = resolveCall(ctx, call)
    if (!resolved) continue
    // from — enclosing определение (функция/метод), иначе сам файл.
    const fromId = call.parentName
      ? symbolNodeId(fromFile, call.parentName, findParentQualifier(fileDefs, call.parentName))
      : fileNodeId(fromFile)
    const key = `${fromId}|${resolved.toId}|${call.line}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({
      id: edgeId(fromId, 'calls', resolved.toId, call.line),
      projectId: index.projectId,
      fromNode: fromId,
      toNode: resolved.toId,
      type: 'calls',
      precision: resolved.precision,
      filePath: fromFile,
      line: call.line,
    })
  }
  return edges
}

/** parentName из sidecar — простое имя; находим qualified родителя для id. */
function findParentQualifier(fileDefs: CodeMapNode[], parentName: string): string | null {
  const parent = fileDefs.find(d => d.name === parentName)
  return parent?.parentName ?? null
}

// ─── Сборка узлов файла из определений ───────────────────────────────────────

export function definitionsToNodes(
  projectId: string,
  filePath: string,
  definitions: SidecarDefinition[],
): CodeMapNode[] {
  const nodes: CodeMapNode[] = []
  const seen = new Set<string>()
  for (const d of definitions) {
    const kind = normalizeKind(d.kind)
    const id = symbolNodeId(filePath, d.name, d.parentName)
    if (seen.has(id)) continue
    seen.add(id)
    nodes.push({
      id,
      projectId,
      filePath,
      name: d.name,
      kind,
      parentName: d.parentName ?? null,
      lineStart: d.lineStart,
      lineEnd: d.lineEnd,
      signature: d.signature,
      exported: /^export\b/.test(d.signature),
      doc: d.doc ?? null,
    })
  }
  return nodes
}

function normalizeKind(kind: string): CodeMapNode['kind'] {
  const known: CodeMapNode['kind'][] = [
    'function', 'class', 'method', 'variable', 'field', 'interface', 'enum',
    'struct', 'type', 'module', 'impl', 'constructor', 'macro', 'definition',
  ]
  return (known.includes(kind as CodeMapNode['kind']) ? kind : 'definition') as CodeMapNode['kind']
}

/**
 * Префикс объявления, означающий «наружу»: export (TS/JS), pub (Rust),
 * public/protected (C#/Java/Kotlin/Scala), final/abstract/static перед объявлением
 * с модификатором доступа проверяются окном строк ниже.
 */
const EXPORT_PREFIX_RE = /^\s*(?:export\b|pub\b|public\b|protected\b)/

/**
 * Языки, где отсутствие модификатора доступа = публичный (Kotlin, Swift, Scala,
 * Dart, Ruby, Elixir, Lua, PHP). Для них проверяем НЕ префикс публичности, а
 * префикс приватности. Иначе все символы считались приватными: у Android-карты
 * выходило tier>0 = 0 при 655 документов, и семантике было нечего эмбеддить.
 */
const DEFAULT_PUBLIC_LANGS = new Set(['kotlin', 'scala', 'swift', 'dart', 'ruby', 'elixir', 'lua', 'php'])

/** Приватность «по префиксу строки» для языков с публичностью по умолчанию. */
const PRIVATE_PREFIX_BY_LANG: Record<string, RegExp> = {
  kotlin: /^\s*(?:private|internal|protected)\b/,
  scala: /^\s*(?:private|protected)\b/,
  swift: /^\s*(?:private|fileprivate|internal)\b/,
  ruby: /^\s*(?:private|protected)\b/,
  elixir: /^\s*defp\b/,
  lua: /^\s*local\b/,
  dart: /^\s*_/,
  php: /^\s*(?:private|protected)\b/,
}

/**
 * Проставить `exported` по исходнику. Signature из sidecar приходит БЕЗ
 * модификатора (`function foo() {`), поэтому `^export` по сигнатуре не работал
 * никогда — все узлы были private, ломая tier-1 семантики и список экспортов
 * файла. Смотрим 3 строки вверх от объявления (декораторы, `export default`
 * отдельной строкой) + языковые правила:
 *  - Go — заглавная буква;
 *  - Python — не `_` и не вложенный;
 *  - Kotlin/Scala/Swift/Dart/Ruby/Elixir/Lua/PHP — публичные по умолчанию,
 *    приватность только через явный модификатор.
 */
export function markExported(nodes: CodeMapNode[], content: string, language: string | null): void {
  if (nodes.length === 0) return
  const lines = content.split('\n')
  const lang = language ?? ''
  const privateRe = PRIVATE_PREFIX_BY_LANG[lang]
  const defaultPublic = DEFAULT_PUBLIC_LANGS.has(lang)
  for (const n of nodes) {
    if (n.kind === 'file' || n.kind === 'package' || n.kind === 'section') continue
    const start = Math.max(0, (n.lineStart || 1) - 1)
    let exported = false
    let explicitlyPrivate = false
    for (let i = start; i >= Math.max(0, start - 2); i--) {
      const line = (lines[i] ?? '').trimStart()
      if (EXPORT_PREFIX_RE.test(line)) { exported = true; break }
      // Декораторы/атрибуты пропускаем, не считая их модификаторами доступа.
      if (line.startsWith('@') || line.startsWith('[')) continue
      if (privateRe && privateRe.test(line)) { explicitlyPrivate = true; break }
    }
    if (!exported && !explicitlyPrivate) {
      if (lang === 'go') exported = /^[A-Z]/.test(n.name)
      else if (lang === 'python') exported = !n.name.startsWith('_') && !n.parentName
      else if (defaultPublic) exported = !n.name.startsWith('_')
    }
    n.exported = exported
  }
}

/** contains-рёбра: файл → символ, контейнер → вложенный символ. */
export function containsEdges(projectId: string, filePath: string, nodes: CodeMapNode[]): CodeMapEdge[] {
  const edges: CodeMapEdge[] = []
  const fid = fileNodeId(filePath)
  const byName = new Map(nodes.map(n => [n.name, n]))
  for (const n of nodes) {
    const parent = n.parentName ? byName.get(n.parentName) : null
    const fromId = parent ? parent.id : fid
    edges.push({
      id: edgeId(fromId, 'contains', n.id, n.lineStart),
      projectId,
      fromNode: fromId,
      toNode: n.id,
      type: 'contains',
      precision: 'resolved',
      filePath,
      line: n.lineStart,
    })
  }
  return edges
}

// ─── Документы (markdown/ADR) ────────────────────────────────────────────────

export interface DocSection {
  title: string
  level: number
  lineStart: number
  lineEnd: number
  /** Текст секции без строки заголовка. */
  text: string
}

/**
 * Секции markdown по заголовкам `# … ######`. Даёт узлы «где это описано»:
 * README/ADR/docs в карте кода отсутствовали полностью.
 */
export function parseMarkdownSections(content: string): DocSection[] {
  const lines = content.split('\n')
  const out: DocSection[] = []
  let cur: { title: string; level: number; lineStart: number; body: string[] } | null = null
  const flush = (endLine: number): void => {
    if (!cur) return
    out.push({ title: cur.title, level: cur.level, lineStart: cur.lineStart, lineEnd: endLine, text: cur.body.join('\n') })
    cur = null
  }
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i])
    if (m) {
      flush(i)
      cur = { title: m[2].trim(), level: m[1].length, lineStart: i + 1, body: [] }
      continue
    }
    if (cur) cur.body.push(lines[i])
  }
  flush(lines.length)
  return out.filter(s => s.title.length > 0)
}

/**
 * Узлы markdown-файла: сам файл + по узлу на секцию.
 * id секции детерминирован по заголовку и строке (одинаковые заголовки
 * «Examples» в разных местах не схлопываются).
 */
export function markdownNodes(projectId: string, filePath: string, content: string): CodeMapNode[] {
  const lineCount = content.split('\n').length
  const nodes: CodeMapNode[] = [{
    id: fileNodeId(filePath),
    projectId,
    filePath,
    name: posix.basename(filePath),
    kind: 'file',
    parentName: null,
    lineStart: 1,
    lineEnd: lineCount,
    signature: '',
    exported: true,
    doc: null,
  }]
  const seen = new Set<string>()
  for (const s of parseMarkdownSections(content)) {
    const slug = s.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'section'
    let id = symbolNodeId(filePath, `${slug}-${s.lineStart}`)
    if (seen.has(id)) id = `${id}-${seen.size}`
    seen.add(id)
    nodes.push({
      id,
      projectId,
      filePath,
      name: s.title.slice(0, 120),
      kind: 'section',
      parentName: null,
      lineStart: s.lineStart,
      lineEnd: s.lineEnd,
      signature: `#${'#'.repeat(Math.max(0, s.level - 1))} ${s.title}`.slice(0, 200),
      exported: true,
      doc: s.text.trim().slice(0, 2000) || null,
    })
  }
  return nodes
}

/**
 * `references` секций доков на символы проекта: имя символа (≥4 символа)
 * встречается в тексте секции. Precision heuristic — упоминание ≠ вызов.
 * Ограничение по числу рёбер на секцию, чтобы README не тянул весь проект.
 */
export function docReferenceEdges(
  index: ProjectIndex,
  filePath: string,
  nodes: CodeMapNode[],
  maxPerSection = 8,
): CodeMapEdge[] {
  const edges: CodeMapEdge[] = []
  const sections = nodes.filter(n => n.kind === 'section')
  if (sections.length === 0) return edges
  // Кандидаты: имена, встречающиеся в проекте; короткие/общие отбрасываем.
  const candidates = [...index.defsByName.keys()].filter(n => n.length >= 4 && n.length <= 60 && !n.includes(' '))
  for (const s of sections) {
    const text = (s.doc ?? '').replace(/`/g, '')
    if (!text) continue
    let found = 0
    for (const name of candidates) {
      if (found >= maxPerSection) break
      if (!text.includes(name)) continue
      const defs = (index.defsByName.get(name) ?? []).filter(d => d.kind !== 'file' && d.kind !== 'package')
      if (defs.length === 0) continue
      // Одно ребро на имя: предпочитаем exported-определение.
      const target = defs.find(d => d.exported) ?? defs[0]
      const precision: CodeEdgePrecision = defs.length === 1 ? 'heuristic' : 'ambiguous'
      edges.push({
        id: edgeId(s.id, 'references', target.id, s.lineStart),
        projectId: index.projectId,
        fromNode: s.id,
        toNode: target.id,
        type: 'references',
        precision,
        filePath,
        line: s.lineStart,
      })
      found++
    }
  }
  return edges
}

/** Загрузить tsconfig paths aliases (упрощённо, без JSONC-комментариев). */export function loadTsconfigAliases(workdir: string, readFile: (p: string) => string | null): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const name of ['tsconfig.json', 'tsconfig.web.json', 'tsconfig.node.json', 'jsconfig.json']) {
    const raw = readFile(path.join(workdir, name))
    if (!raw) continue
    try {
      const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      const cfg = JSON.parse(cleaned) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
      const baseUrl = cfg.compilerOptions?.baseUrl ?? '.'
      const paths = cfg.compilerOptions?.paths ?? {}
      for (const [alias, targets] of Object.entries(paths)) {
        if (targets.length > 0) {
          aliases.set(alias, posix.join(baseUrl, targets[0].replace(/\*$/, '')))
        }
      }
    } catch { /* ignore malformed tsconfig */ }
  }
  return aliases
}

/** Обёртка ensurePackageNode для резолвера (чтобы не тянуть store в тесты напрямую). */
export function ensurePackages(projectId: string, names: string[]): void {
  for (const name of names) ensurePackageNode(projectId, name)
}