import { sep } from 'path'
import type Store from 'electron-store'
import { getIndexSettings, type ProgressCallback } from './settings'
import { buildContentSnippets } from './retriever'
import { summarizeWithLLM, type FastContextFile, type FastContextResult } from './annotator'
import { sidecarIndex, sidecarSearch, SidecarError } from './sidecarClient'
import type { SymbolDef } from './types'

// ─── Orchestrator ───────────────────────────────────────────────────────────
//
// The Rust sidecar is the only Fast Context backend. There is deliberately no
// TypeScript indexing/search fallback: a missing or broken sidecar must surface
// as a typed error instead of silently switching to a second implementation
// with different indexing rules and ranking.

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

  // Читаем настройки индексации из store (лимиты, ignoreDirs).
  const idxSettings = getIndexSettings(store)

  onProgress?.({ stage: 'indexing', detail: 'Сканирование файлов (Rust)', filesProcessed: 0, filesTotal: 0 })
  let sidecarIndexResult: Awaited<ReturnType<typeof sidecarIndex>>
  try {
    sidecarIndexResult = await sidecarIndex(projectId, workdir, {
      maxFiles: idxSettings.maxFilesPerProject,
      maxFileSizeKb: idxSettings.maxFileSizeKb,
      ignoreDirs: idxSettings.ignoreDirs,
    })
    // A file cap intentionally indexes a deterministic subset. It is usable for
    // retrieval; only actual walk/read errors make the index unsafe to trust.
    if (sidecarIndexResult.hadErrors === true || (sidecarIndexResult.complete === false && !sidecarIndexResult.hitCap)) {
      const reasons = [
        sidecarIndexResult.hadErrors ? 'one or more files could not be read' : null,
        sidecarIndexResult.complete === false && !sidecarIndexResult.hitCap
          ? 'index walk did not complete'
          : null,
      ].filter((reason): reason is string => reason !== null)
      throw new SidecarError('index_unavailable', `Rust sidecar index is incomplete: ${reasons.join('; ')}`)
    }
    if (sidecarIndexResult.hitCap) {
      onProgress?.({
        stage: 'indexing',
        detail: `Индексирована часть проекта: ${sidecarIndexResult.filesFound ?? idxSettings.maxFilesPerProject} файлов (лимит ${idxSettings.maxFilesPerProject})`,
        filesProcessed: sidecarIndexResult.filesFound,
        filesTotal: idxSettings.maxFilesPerProject,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onProgress?.({ stage: 'error', detail: `Rust Fast Context недоступен: ${message}` })
    throw error instanceof SidecarError ? error : new SidecarError('unavailable', message)
  }

  // Stage 2: retrieving
  const walkedCount = sidecarIndexResult.filesFound ?? 0
  onProgress?.({ stage: 'retrieving', detail: `Поиск по ${walkedCount} файлам`, filesProcessed: 0, filesTotal: 0 })
  let sidecarResult: Awaited<ReturnType<typeof sidecarSearch>>
  try {
    sidecarResult = await sidecarSearch(projectId, query, maxFiles, maxTokens)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    onProgress?.({ stage: 'error', detail: `Rust Fast Context search недоступен: ${message}` })
    throw error instanceof SidecarError ? error : new SidecarError('unavailable', message)
  }

  const slice: string = sidecarResult.slice
  const topFiles: Array<{ path: string; score: number; definitions: SymbolDef[] }> = sidecarResult.topFiles

  // Real index size: rows in the Rust index, not just this walk's file count.
  const indexedCount = sidecarResult.indexedFilesCount ?? sidecarIndexResult.filesFound ?? 0

  if (topFiles.length === 0) {
    onProgress?.({ stage: 'done', detail: 'Ничего не найдено' })
    return {
      files: [],
      summary: indexedCount === 0
        ? 'Индекс Fast Context пуст: проиндексировано 0 файлов. Проверьте workdir проекта и настройки индексации.'
        : 'Не найдено релевантных файлов по запросу. Индекс содержит файлы, но ни один не совпал с запросом.',
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
  const snippetResult = await buildContentSnippets(topFiles, 5, 3, 30, outerQueryTokens)
  const fullSlice = snippetResult.text ? slice + snippetResult.text : slice

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
    snippets: snippetResult.items,
  }
}
