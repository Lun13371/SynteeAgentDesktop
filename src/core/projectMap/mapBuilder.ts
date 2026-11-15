/**
 * ProjectMapManager — единый менеджер карт проектов.
 *
 *  - Фон: строит карты всех проектов, активный (открытый чат) — первым и быстро,
 *    остальные — медленнее (пауза между файлами). Уступает foreground (чат busy).
 *  - Инкрементал: подписка на fileIndexer → debounce → переразбор изменённого
 *    файла + перерезолвинг его импортёров. Кэш по sha256 — неизменённые файлы не
 *    перепарсиваются, карта переживает рестарт приложения.
 *  - Прогресс: наружу через setProgressCallback (IPC шлёт в renderer-баннер).
 *
 * Тяжёлый парсинг — в Rust sidecar; здесь только оркестрация и резолвинг (лёгкий).
 */
import { readFile } from 'fs/promises'
import { existsSync, readFileSync, statSync } from 'fs'
import { createHash } from 'crypto'
import * as path from 'path'
import * as os from 'os'
import { getAllProjects, getProjectById, getProjectByWorkdir } from '../db'
import { sidecarSymbols, type SidecarSymbolsResult } from '../sidecar/sidecarClient'
import { startIndexing, getAllFiles, subscribeFileChanges } from '../mentions/fileIndexer'
import type { CodeMapFile, CodeMapNode, CodeMapProgress, CodeMapEdge, ProjectMapSpeedSettings, ProjectMapAutoInfo } from '../../shared/projectMap'
import { DEFAULT_PROJECT_MAP_SPEED } from '../../shared/projectMap'
import * as store from './mapStore'
import {
  ProjectIndex, definitionsToNodes, containsEdges, resolveFileImports,
  resolveFileCalls, ensurePackages, loadTsconfigAliases,
} from './mapResolver'

const CODE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rs', '.go',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.java', '.cs', '.rb', '.php', '.sh', '.bash',
])

/** Пауза между файлами для неактивных проектов задаётся backgroundDelay(). */
const CHANGE_DEBOUNCE_MS = 400
const MAX_FILES = 20000

interface RawFile {
  meta: CodeMapFile
  symbols: SidecarSymbolsResult
  nodes: CodeMapNode[]
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const yieldNow = () => new Promise<void>(r => setImmediate(r))

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function isCodeFile(relPath: string): boolean {
  return CODE_EXTS.has(path.extname(relPath).toLowerCase())
}

/** Минифицированный/гигантский файл: очень длинные строки или большой размер. */
function isMinifiedOrHuge(content: string): boolean {
  if (content.length > 1_000_000) return true
  // Минификация = мало переносов строк при большом размере либо строка-гигант.
  const head = content.slice(0, 50_000)
  const firstLines = head.split('\n', 40)
  for (const line of firstLines) {
    if (line.length > 1500) return true
  }
  const newlines = (head.match(/\n/g) ?? []).length
  if (head.length > 10_000 && newlines < 5) return true
  return false
}

class ProjectMapManager {
  private queue: string[] = []
  private activeProjectId: string | null = null
  private building: string | null = null
  private running = false
  private stopRequested = false
  private loopActive = false
  private progressCb: ((p: CodeMapProgress) => void) | null = null
  private foregroundBusy: () => boolean = () => false
  private watchers = new Map<string, () => void>()
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingChanges = new Map<string, Set<string>>()
  private incrementalBusy = new Set<string>()
  private lastEmit = new Map<string, number>()
  private enabled = true
  private speed: ProjectMapSpeedSettings = DEFAULT_PROJECT_MAP_SPEED
  private configReader: (() => { enabled: boolean; speed: ProjectMapSpeedSettings }) | null = null
  /** Тёплый индекс в памяти: не перечитываем весь граф из SQLite на каждый чих. */
  private indexCache = new Map<string, ProjectIndex>()

  /** Источник конфига (settings store). Вызывается при reloadConfig. */
  setConfigReader(fn: () => { enabled: boolean; speed: ProjectMapSpeedSettings }): void {
    this.configReader = fn
  }

  reloadConfig(): void {
    if (!this.configReader) return
    const cfg = this.configReader()
    this.enabled = cfg.enabled !== false
    this.speed = cfg.speed ?? DEFAULT_PROJECT_MAP_SPEED
    if (!this.enabled) this.stop()
    else if (!this.running) this.start()
  }

  /** Пауза между файлами фоновой индексации: manual = уровень, auto = железо. */
  private backgroundDelay(): number {
    if (this.speed.mode === 'manual') {
      const lvl = Math.max(0, Math.min(100, this.speed.level))
      return Math.round(150 * (1 - lvl / 100))
    }
    return this.autoInfo().backgroundDelayMs
  }

  /** Авто-бюджет от железа: больше ядер/памяти → меньше пауза, но всегда >0. */
  autoInfo(): ProjectMapAutoInfo {
    const cores = os.cpus().length || 2
    const memGB = Math.round(os.totalmem() / 1024 / 1024 / 1024)
    let delay: number
    if (cores >= 8 && memGB >= 16) delay = 10
    else if (cores >= 4 && memGB >= 8) delay = 25
    else delay = 60
    return { cores, memGB, backgroundDelayMs: delay }
  }

  setProgressCallback(cb: (p: CodeMapProgress) => void): void {
    this.progressCb = cb
  }

  setForegroundPredicate(fn: () => boolean): void {
    this.foregroundBusy = fn
  }

  private emit(p: CodeMapProgress): void {
    // Busy-фазы шлём не чаще ~8/сек: иначе на каждый файл летит IPC + рендер
    // renderer'а (сотни/сек) и UI подвисает. ready/error всегда проходят.
    const busy = p.phase !== 'ready' && p.phase !== 'error'
    if (busy) {
      const now = Date.now()
      const last = this.lastEmit.get(p.projectId) ?? 0
      if (now - last < 120) return
      this.lastEmit.set(p.projectId, now)
    }
    try { this.progressCb?.(p) } catch { /* ignore */ }
  }

  /** Активный проект (открытый чат) получает приоритет в очереди. */
  setActiveProject(projectId: string | null): void {
    this.activeProjectId = projectId
    if (projectId) {
      this.queue = [projectId, ...this.queue.filter(id => id !== projectId)]
      this.ensureProject(projectId)
    }
    this.kick()
  }

  /** Запустить фоновую индексацию всех проектов (активный — первым). */
  start(): void {
    if (this.running) return
    this.running = true
    this.stopRequested = false
    // Отложенный старт: БД инициализируется в registerChatIPC (позже регистрации
    // IPC), а startup не должен конкурировать с индексацией. Паттерн semanticIndex.
    setTimeout(() => {
      if (this.stopRequested || !this.running || !this.enabled) return
      try {
        const projects = getAllProjects()
        const ordered = this.activeProjectId
          ? [this.activeProjectId, ...projects.map(p => p.id).filter(id => id !== this.activeProjectId)]
          : projects.map(p => p.id)
        for (const id of ordered) this.enqueue(id)
        this.kick()
      } catch (e) {
        console.warn('[projectMap] start failed:', e instanceof Error ? e.message : e)
      }
    }, 3000)
  }

  stop(): void {
    this.stopRequested = true
    this.running = false
    for (const unsub of this.watchers.values()) unsub()
    this.watchers.clear()
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
    this.indexCache.clear()
  }

  /** Принудительная полная пересборка карты проекта. */
  rebuildProject(projectId: string): void {
    this.forceRebuild.add(projectId)
    this.queue = [projectId, ...this.queue.filter(id => id !== projectId)]
    this.kick()
  }

  /** Построить карту проекта, если её ещё нет (или устарела). */
  ensureProject(projectId: string): void {
    this.enqueue(projectId)
    this.kick()
  }

  private enqueue(projectId: string): void {
    if (!this.queue.includes(projectId) && this.building !== projectId) {
      this.queue.push(projectId)
    }
  }

  private kick(): void {
    if (this.loopActive || !this.running || this.stopRequested) return
    this.loopActive = true
    void this.loop().finally(() => { this.loopActive = false })
  }

  private async loop(): Promise<void> {
    while (this.running && !this.stopRequested && this.queue.length > 0) {
      // Активный проект всегда в приоритете.
      if (this.activeProjectId && this.queue.includes(this.activeProjectId)) {
        this.queue = [this.activeProjectId, ...this.queue.filter(id => id !== this.activeProjectId)]
      }
      const projectId = this.queue.shift()!
      this.building = projectId
      try {
        const force = this.forceRebuild.has(projectId)
        this.forceRebuild.delete(projectId)
        await this.buildProject(projectId, force)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        store.setStatus(projectId, { state: 'error', error: msg })
        this.emit({ projectId, phase: 'error', percent: 0, indexedFiles: 0, totalFiles: 0, error: msg, projectName: getProjectById(projectId)?.name, pendingProjects: this.queue.length })
        console.warn(`[projectMap] build failed for ${projectId}:`, msg)
      } finally {
        this.building = null
      }
      await yieldNow()
    }
  }

  private forceRebuild = new Set<string>()

  private async waitWhileBusy(): Promise<void> {
    let waited = 0
    while (this.foregroundBusy() && waited < 60_000 && !this.stopRequested) {
      await sleep(500)
      waited += 500
    }
  }

  private ensureWatcher(projectId: string, workdir: string): void {
    if (this.watchers.has(workdir)) return
    const unsub = subscribeFileChanges(workdir, (relPaths) => this.onFileChanges(workdir, relPaths))
    this.watchers.set(workdir, unsub)
    void projectId
  }

  private scanCodeFiles(workdir: string): { relPath: string; absPath: string; size: number; mtime: number }[] {
    return getAllFiles(workdir)
      .filter(f => isCodeFile(f.relPath))
      .slice(0, MAX_FILES)
      .map(f => ({ relPath: f.relPath, absPath: f.path, size: f.size, mtime: f.mtime }))
  }

  private loadAliases(workdir: string): Map<string, string> {
    return loadTsconfigAliases(workdir, (p) => {
      try { return existsSync(p) ? readFileSync(p, 'utf-8') : null } catch { return null }
    })
  }

  /** Загрузить индекс проекта из уже сохранённых узлов (для warm/инкрементал).
      Страницами с yield — чтобы не блокировать main длинным sync-чтением. */
  private async indexFromStore(projectId: string, workdir: string): Promise<ProjectIndex> {
    const index = new ProjectIndex(projectId, workdir)
    index.aliases = this.loadAliases(workdir)
    const byFile = new Map<string, CodeMapNode[]>()
    const PAGE = 2000
    let offset = 0
    for (;;) {
      const nodes = store.listNodes(projectId, PAGE, offset)
      if (nodes.length === 0) break
      for (const n of nodes) {
        if (n.kind === 'package') continue
        const list = byFile.get(n.filePath) ?? []
        list.push(n)
        byFile.set(n.filePath, list)
      }
      offset += nodes.length
      if (nodes.length === PAGE) await yieldNow()
    }
    let i = 0
    for (const [filePath, fileNodes] of byFile) {
      index.addFileNodes(filePath, fileNodes)
      if (++i % 200 === 0) await yieldNow()
    }
    for (const f of store.listFiles(projectId)) index.files.add(f.path)
    return index
  }

  /** Индекс из кэша или тёплая загрузка из store (один раз на проект). */
  private async getIndex(projectId: string, workdir: string): Promise<ProjectIndex> {
    let idx = this.indexCache.get(projectId)
    if (!idx) {
      idx = await this.indexFromStore(projectId, workdir)
      this.indexCache.set(projectId, idx)
    }
    return idx
  }

  private async parseFile(
    projectId: string, relPath: string, absPath: string, size: number, mtime: number,
  ): Promise<RawFile | null> {
    let content: string
    try {
      content = await readFile(absPath, 'utf-8')
    } catch {
      return null
    }
    // Минифицированные/гигантские файлы не дают осмысленных символов и вешают
    // sidecar на десятки секунд (он serial) — блокируя индексацию остальных
    // проектов и инкрементал активного. Пропускаем до обращения к sidecar.
    if (isMinifiedOrHuge(content)) return null
    const symbols = await sidecarSymbols(absPath, content, { skipReferences: false })
    if (!symbols.supported) return null
    const nodes = definitionsToNodes(projectId, relPath, symbols.definitions)
    const fileNode: CodeMapNode = {
      id: store.fileNodeId(relPath),
      projectId,
      filePath: relPath,
      name: path.basename(relPath),
      kind: 'file',
      parentName: null,
      lineStart: 0,
      lineEnd: 0,
      signature: '',
      exported: false,
    }
    const allNodes = [fileNode, ...nodes]
    const meta: CodeMapFile = {
      projectId,
      path: relPath,
      language: symbols.language,
      hash: sha256(content),
      mtime,
      size,
      parser: symbols.parser,
      truncated: symbols.truncated,
      indexedAt: Date.now(),
    }
    return { meta, symbols, nodes: allNodes }
  }

  /** parseFile с защитой: таймаут/ошибка одного файла не роняет всю карту. */
  private async parseFileSafe(
    projectId: string, relPath: string, absPath: string, size: number, mtime: number,
  ): Promise<RawFile | null> {
    try {
      return await this.parseFile(projectId, relPath, absPath, size, mtime)
    } catch (e) {
      console.warn(`[projectMap] skip ${relPath}: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }

  private resolveAndWrite(index: ProjectIndex, raw: RawFile): void {
    const { meta, symbols, nodes } = raw
    const importRes = resolveFileImports(index, meta.path, symbols.importDetails, meta.language)
    ensurePackages(index.projectId, importRes.packages)
    const callEdges = resolveFileCalls(index, meta.path, symbols.callSites, symbols.importDetails, meta.language)
    const contains = containsEdges(index.projectId, meta.path, nodes)
    const edges: CodeMapEdge[] = [...importRes.edges, ...callEdges, ...contains]
    store.replaceFile(index.projectId, meta, nodes, edges)
  }

  private async buildProject(projectId: string, force: boolean): Promise<void> {
    const project = getProjectById(projectId)
    if (!project) return
    const workdir = project.workdir
    const projectName = project.name
    if (!existsSync(workdir)) {
      store.setStatus(projectId, { state: 'error', error: 'workdir not found' })
      return
    }

    store.setStatus(projectId, { state: 'building', startedAt: Date.now(), error: null })
    this.emit({ projectId, phase: 'scanning', percent: 0, indexedFiles: 0, totalFiles: 0, projectName, pendingProjects: this.queue.length })

    await startIndexing(workdir)
    this.ensureWatcher(projectId, workdir)
    const files = this.scanCodeFiles(workdir)
    const total = files.length
    store.setStatus(projectId, { totalFiles: total })

    const index = force ? new ProjectIndex(projectId, workdir) : await this.getIndex(projectId, workdir)
    if (force) {
      index.aliases = this.loadAliases(workdir)
      store.clearProject(projectId)
      this.indexCache.set(projectId, index)
    }
    const existing = new Map(store.listFiles(projectId).map(f => [f.path, f]))

    const isActive = projectId === this.activeProjectId
    const toResolve: RawFile[] = []
    let done = 0

    // ── Парсинг ──
    for (const f of files) {
      if (this.stopRequested) return
      await this.waitWhileBusy()
      const prev = existing.get(f.relPath)
      if (!force && prev && prev.hash) {
        // Мгновенный фильтр: mtime+size совпали → файл не менялся, не читаем.
        if (prev.mtime === f.mtime && prev.size === f.size) {
          done++
          continue
        }
        // mtime/size изменились — подтверждаем hash'ом (мог быть просто touch).
        let content: string | null = null
        try { content = await readFile(f.absPath, 'utf-8') } catch { content = null }
        if (content !== null && sha256(content) === prev.hash) {
          store.updateFileStat(projectId, f.relPath, f.mtime, f.size)
          done++
          continue
        }
      }
      const raw = await this.parseFileSafe(projectId, f.relPath, f.absPath, f.size, f.mtime)
      done++
      if (raw) {
        index.removeFile(f.relPath)
        index.addFileNodes(f.relPath, raw.nodes)
        toResolve.push(raw)
      } else {
        store.removeFile(projectId, f.relPath)
        index.removeFile(f.relPath)
      }
      this.emit({ projectId, phase: 'parsing', percent: Math.round((done / Math.max(1, total)) * 90), indexedFiles: done, totalFiles: total, projectName, pendingProjects: this.queue.length })
      if (!isActive) await sleep(this.backgroundDelay())
      else await yieldNow()
    }

    // ── Резолвинг + запись ──
    let resolved = 0
    for (const raw of toResolve) {
      if (this.stopRequested) return
      this.resolveAndWrite(index, raw)
      resolved++
      this.emit({ projectId, phase: 'resolving', percent: 90 + Math.round((resolved / Math.max(1, toResolve.length)) * 10), indexedFiles: done, totalFiles: total, projectName, pendingProjects: this.queue.length })
      await yieldNow()
    }

    // Удалить файлы, которых больше нет на диске.
    const onDisk = new Set(files.map(f => f.relPath))
    let removed = 0
    for (const f of store.listFiles(projectId)) {
      if (!onDisk.has(f.path)) {
        store.removeFile(projectId, f.path)
        index.removeFile(f.path)
        removed++
      }
    }

    // prune — полный скан рёбер (sync): только когда реально что-то удалили.
    if (removed > 0) store.pruneDanglingEdges(projectId)
    store.refreshCounts(projectId)
    const status = store.getStatus(projectId)
    store.setStatus(projectId, { state: 'ready', indexedFiles: status.indexedFiles })
    this.emit({ projectId, phase: 'ready', percent: 100, indexedFiles: status.indexedFiles, totalFiles: total, message: `${status.totalNodes} узлов, ${status.totalEdges} связей`, projectName, pendingProjects: this.queue.length })
  }

  // ─── Инкрементальные обновления ────────────────────────────────────────────

  private onFileChanges(workdir: string, relPaths: string[]): void {
    const code = relPaths.filter(isCodeFile)
    if (code.length === 0) return
    let set = this.pendingChanges.get(workdir)
    if (!set) {
      set = new Set()
      this.pendingChanges.set(workdir, set)
    }
    for (const p of code) set.add(p)
    const prev = this.debounceTimers.get(workdir)
    if (prev) clearTimeout(prev)
    this.debounceTimers.set(workdir, setTimeout(() => {
      this.debounceTimers.delete(workdir)
      void this.flushChanges(workdir)
    }, CHANGE_DEBOUNCE_MS))
  }

  private async flushChanges(workdir: string): Promise<void> {
    const pending = this.pendingChanges.get(workdir)
    this.pendingChanges.delete(workdir)
    if (!pending || pending.size === 0) return
    const project = getProjectByWorkdir(workdir)
    if (!project) return
    const projectId = project.id
    // Не мешаем полной сборке этого проекта.
    if (this.building === projectId || this.incrementalBusy.has(projectId)) {
      this.onFileChanges(workdir, [...pending])
      return
    }
    this.incrementalBusy.add(projectId)
    try {
      await this.waitWhileBusy()
      const index = await this.getIndex(projectId, workdir)
      const changed = [...pending]
      const resolvedPaths = new Set<string>()
      let removed = 0

      for (const relPath of changed) {
        if (this.stopRequested) return
        const absPath = path.join(workdir, relPath)
        if (!existsSync(absPath)) {
          store.removeFile(projectId, relPath)
          index.removeFile(relPath)
          resolvedPaths.add(relPath)
          removed++
          continue
        }
        let st
        try { st = await readFile(absPath, 'utf-8') } catch { continue }
        let mtime = Date.now(), size = st.length
        try { const s = statSync(absPath); mtime = s.mtimeMs; size = s.size } catch { /* ignore */ }
        const raw = await this.parseFileSafe(projectId, relPath, absPath, size, mtime)
        if (!raw) continue
        index.removeFile(relPath)
        index.addFileNodes(relPath, raw.nodes)
        this.resolveAndWrite(index, raw)
        resolvedPaths.add(relPath)
        await yieldNow()
      }

      // Перерезолвить импортёров изменённых файлов (их рёбра могли поменяться).
      const importers = new Set<string>()
      for (const relPath of resolvedPaths) {
        for (const e of store.getFileEdges(projectId, relPath, 'in')) {
          const fromFile = store.getNode(projectId, e.fromNode)?.filePath
          if (fromFile && !resolvedPaths.has(fromFile)) importers.add(fromFile)
        }
      }
      for (const relPath of importers) {
        if (this.stopRequested) return
        const absPath = path.join(workdir, relPath)
        if (!existsSync(absPath)) continue
        let st
        try { st = await readFile(absPath, 'utf-8') } catch { continue }
        let mtime = Date.now(), size = st.length
        try { const s = statSync(absPath); mtime = s.mtimeMs; size = s.size } catch { /* ignore */ }
        const raw = await this.parseFileSafe(projectId, relPath, absPath, size, mtime)
        if (!raw) continue
        index.removeFile(relPath)
        index.addFileNodes(relPath, raw.nodes)
        this.resolveAndWrite(index, raw)
        // Уступаем main между импортёрами: горячий файл может иметь десятки
        // импортёров, sync-записи подряд без yield фризили UI.
        await yieldNow()
      }

      if (removed > 0) store.pruneDanglingEdges(projectId)
      store.refreshCounts(projectId)
      const status = store.getStatus(projectId)
      this.emit({ projectId, phase: 'ready', percent: 100, indexedFiles: status.indexedFiles, totalFiles: status.totalFiles, message: 'Карта обновлена', projectName: project.name, pendingProjects: this.queue.length, incremental: true, changedFiles: changed.length })
    } catch (e) {
      console.warn('[projectMap] incremental failed:', e instanceof Error ? e.message : e)
    } finally {
      this.incrementalBusy.delete(projectId)
    }
  }
}

export const projectMapManager = new ProjectMapManager()