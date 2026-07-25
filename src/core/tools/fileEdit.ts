import { existsSync } from 'fs'
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { resolveToolPath, ensureDirFor, makeDiff, countChangedLines, normalizeLineEndings, type ToolResult } from './_shared'

export interface EditResult extends ToolResult {
  diff?: string
}

export async function writeFile(path: string, content: string, opts?: { dryRun?: boolean; workdir?: string }): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, opts?.workdir)
    await ensureDirFor(path)
    // Читаем оригинал для diff (если файл существует). originalContent = null
    // сигнализирует снапшот-системе что файл был СОЗДАН (→ unlink при rewind),
    // а не перезаписан пустым содержимым.
    let original = ''
    let originalContent: string | null = null
    const fileExists = existsSync(path)
    if (fileExists) {
      try { original = await fsReadFile(path, 'utf-8'); originalContent = original } catch { /* ok */ }
    }
    // dryRun — не записываем, только возвращаем diff-превью
    if (opts?.dryRun) {
      const diff = makeDiff(original, content, path)
      const action = fileExists ? 'ПЕРЕЗАПИСЬ существующего файла' : 'СОЗДАНИЕ нового файла'
      return { success: true, output: `[DRY RUN] ${action}: ${path}\n${diff}`.slice(0, 4000), diff }
    }
    await fsWriteFile(path, content, 'utf-8')
    const lines = content.split('\n').length
    // Генерируем diff как у edit_file
    const diff = makeDiff(original, content, path)
    const changedLines = countChangedLines(diff)
    return { success: true, output: `Файл записан: ${path} (${lines} строк, ${changedLines} строк изменено)`, diff, originalContent }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

// §3.2 — Парсер search/replace patch формата (Codex-style).
// Формат: один или несколько блоков, разделённых маркерами:
//   <<<<<<< SEARCH
//   <точный текст для поиска>
//   =======
//   <новый текст>
//   >>>>>>> REPLACE
// Каждый блок заменяет ровно одно вхождение. Если SEARCH не найден — ошибка.
function applySearchReplacePatch(original: string, patch: string): string {
  const SEARCH_START = '<<<<<<< SEARCH'
  const SEPARATOR = '======='
  const REPLACE_END = '>>>>>>> REPLACE'

  const lines = patch.split('\n')
  let result = original
  let i = 0
  const errors: string[] = []

  while (i < lines.length) {
    // Ищем начало блока SEARCH
    const searchStartIdx = lines.indexOf(SEARCH_START, i)
    if (searchStartIdx === -1) break

    const sepIdx = lines.indexOf(SEPARATOR, searchStartIdx + 1)
    if (sepIdx === -1) {
      errors.push('Найден SEARCH без ======= сепаратора')
      break
    }

    const replaceEndIdx = lines.indexOf(REPLACE_END, sepIdx + 1)
    if (replaceEndIdx === -1) {
      errors.push('Найден SEARCH/SEPARATOR без >>>>>>> REPLACE')
      break
    }

    const searchText = lines.slice(searchStartIdx + 1, sepIdx).join('\n')
    const replaceText = lines.slice(sepIdx + 1, replaceEndIdx).join('\n')

    if (!searchText) {
      errors.push(`Пустой SEARCH в блоке ${searchStartIdx + 1}`)
      i = replaceEndIdx + 1
      continue
    }

    // Нормализуем CRLF → LF для сравнения
    const normResult = normalizeLineEndings(result)
    const normSearch = normalizeLineEndings(searchText)

    if (!normResult.includes(normSearch)) {
      errors.push(`SEARCH не найден (строки ${searchStartIdx + 2}-${sepIdx}): "${searchText.slice(0, 80)}..."`)
      i = replaceEndIdx + 1
      continue
    }

    // Заменяем только первое вхождение
    result = normResult.replace(normSearch, replaceText)
    i = replaceEndIdx + 1
  }

  if (errors.length > 0) {
    throw new Error(`apply_patch ошибки (${errors.length}):\n${errors.join('\n')}`)
  }

  return result
}

export async function editFile(params: {
  path: string
  mode: 'replace' | 'insert' | 'overwrite' | 'apply_patch'
  old_str?: string
  new_str?: string
  after_line?: number
  content?: string
  create_if_not_exists?: boolean
  dryRun?: boolean
  patch?: string
  workdir?: string
}): Promise<EditResult> {
  try {
    params.path = resolveToolPath(params.path, params.workdir)
    const fileExists = existsSync(params.path)

    // create_if_not_exists — создать файл если не существует (только overwrite/insert)
    if (!fileExists) {
      if (params.create_if_not_exists) {
        if (params.dryRun) {
          const initial = params.content ?? params.new_str ?? ''
          return { success: true, output: `[DRY RUN] СОЗДАНИЕ нового файла: ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}`.slice(0, 4000), diff: `+++ ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}` }
        }
        await ensureDirFor(params.path)
        const initial = params.content ?? params.new_str ?? ''
        await fsWriteFile(params.path, initial, 'utf-8')
        return { success: true, output: `Файл создан: ${params.path}`, diff: `+++ ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}` }
      }
      return { success: false, output: '', error: 'Файл не найден: ' + params.path }
    }

    const original = await fsReadFile(params.path, 'utf-8')
    let updated = original

    if (params.mode === 'apply_patch') {
      // §3.2 — Codex-style apply_patch: надёжная замена по точным ханкам.
      // patch содержит серию "*** [file]" / "--- old" / "+++ new" блоков или
      // просто пары old_str→new_str разделённые маркерами.
      // Поддерживаем упрощённый формат: блоки вида:
      //   <<<<<<< SEARCH
      //   точный текст для поиска
      //   =======
      //   новый текст
      //   >>>>>>> REPLACE
      if (!params.patch) return { success: false, output: '', error: 'edit_file apply_patch: нужен patch' }
      updated = applySearchReplacePatch(original, params.patch)
    } else if (params.mode === 'replace') {
      if (!params.old_str) return { success: false, output: '', error: 'edit_file replace: нужен old_str' }
      // Нормализуем CRLF → LF для сравнения
      const normOrig = normalizeLineEndings(original)
      const normOld = normalizeLineEndings(params.old_str)
      if (!normOrig.includes(normOld)) {
        // Попытка fuzzy: игнорируем ведущие пробелы строк
        const stripIndent = (s: string) => s.split('\n').map(l => l.trimStart()).join('\n')
        if (stripIndent(normOrig).includes(stripIndent(normOld))) {
          // Найдено с другим отступом — ищем реальное место в оригинале
          const oldLines = normOld.split('\n').map(l => l.trimStart())
          const origLines = normOrig.split('\n')
          const matchIdx = origLines.findIndex((_, i) =>
            oldLines.every((ol, j) => (origLines[i + j] ?? '').trimStart() === ol)
          )
          if (matchIdx >= 0) {
            const realOld = origLines.slice(matchIdx, matchIdx + oldLines.length).join('\n')
            updated = normOrig.replace(realOld, params.new_str ?? '')
          } else {
            return { success: false, output: '', error: 'edit_file replace: old_str не найден (fuzzy тоже не помог). Проверь отступы и точность фрагмента.' }
          }
        } else {
          return { success: false, output: '', error: 'edit_file replace: old_str не найден в файле. Используй read_file чтобы уточнить контент.' }
        }
      } else {
        updated = normOrig.replace(normOld, params.new_str ?? '')
      }

    } else if (params.mode === 'insert') {
      const lines = original.split('\n')
      const at = Math.min(params.after_line ?? lines.length, lines.length)
      lines.splice(at, 0, ...(params.content ?? '').split('\n'))
      updated = lines.join('\n')

    } else if (params.mode === 'overwrite') {
      if (params.content === undefined) return { success: false, output: '', error: 'edit_file overwrite: нужен content' }
      updated = params.content
    }

    const diff = makeDiff(original, updated, params.path)
    // dryRun — не записываем, только diff-превью
    if (params.dryRun) {
      const changedLines = countChangedLines(diff)
      return { success: true, output: `[DRY RUN] Правка ${params.mode} для: ${params.path} (${changedLines} строк изменено)\n${diff}`.slice(0, 4000), diff }
    }
    await fsWriteFile(params.path, updated, 'utf-8')
    const changedLines2 = countChangedLines(diff)
    return { success: true, output: `Файл обновлён: ${params.path} (${changedLines2} строк изменено)`, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}

export async function multiEditFile(params: {
  path: string
  edits: Array<{ old_str: string; new_str: string }>
  dryRun?: boolean
  workdir?: string
}): Promise<EditResult> {
  try {
    params.path = resolveToolPath(params.path, params.workdir)
    if (!existsSync(params.path)) return { success: false, output: '', error: 'Файл не найден: ' + params.path }
    const original = await fsReadFile(params.path, 'utf-8')
    let updated = original
    const failed: string[] = []

    for (const edit of params.edits) {
      if (updated.includes(edit.old_str)) {
        updated = updated.replace(edit.old_str, edit.new_str)
      } else {
        failed.push(edit.old_str.slice(0, 60) + '…')
      }
    }

    const diff = makeDiff(original, updated, params.path)
    const changedLines = countChangedLines(diff)
    const warn = failed.length ? `\nНе найдено ${failed.length} фрагментов: ${failed.join('; ')}` : ''
    // dryRun — не записываем
    if (params.dryRun) {
      return { success: true, output: `[DRY RUN] Мульти-правка для: ${params.path} (${changedLines} строк изменено)${warn}\n${diff}`.slice(0, 4000), diff }
    }
    await fsWriteFile(params.path, updated, 'utf-8')
    return { success: true, output: `Файл обновлён: ${params.path} (${changedLines} строк изменено)${warn}`, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}
