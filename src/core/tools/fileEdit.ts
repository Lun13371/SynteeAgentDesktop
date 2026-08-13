import { existsSync } from 'fs'
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'fs/promises'
import { resolveToolPath, ensureDirFor, makeDiff, countChangedLines, normalizeLineEndings, type ToolResult } from './_shared'

export interface EditResult extends ToolResult {
  diff?: string
}

// Запись файла с авто-добавлением UTF-8 BOM для .ps1. PowerShell 5.1 (он же
// Windows PowerShell, powershell.exe) читает текстовые файлы без BOM как
// cp1251 — кириллические строки в .ps1 превращаются в мусор, падает парсер.
// pwsh 7+ UTF-8 по умолчанию и BOM переваривает нормально. Поэтому всегда
// добавляем BOM для .ps1: файл остаётся читаемым и в PS 5.1, и в pwsh 7+,
// и в VS Code. Node при `readFile(path,'utf-8')` BOM автоматически стрипает,
// так что все diff/patch-сравнения работают с чистым контентом без BOM.
function writeWithOptionalBom(filePath: string, content: string): Promise<void> {
  if (/\.ps1$/i.test(filePath)) {
    // EF BB BF — UTF-8 BOM
    const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(content, 'utf-8')])
    return fsWriteFile(filePath, buf)
  }
  return fsWriteFile(filePath, content, 'utf-8')
}

// Fuzzy find-and-replace: игнорирует leading whitespace (tabs vs spaces,
// лишние/недостающие отступы). Используется и apply_patch, и legacy replace.
// Возвращает { found, result }. При replaceAll=true заменяет все вхождения.
function fuzzyFindAndReplace(
  haystack: string,
  needle: string,
  replacement: string,
  replaceAll: boolean,
): { found: boolean; result: string } {
  const stripIndent = (s: string) => s.split('\n').map(l => l.trimStart()).join('\n')
  const strippedHaystack = stripIndent(haystack)
  const strippedNeedle = stripIndent(needle)

  if (!strippedHaystack.includes(strippedNeedle)) {
    return { found: false, result: haystack }
  }

  const needleLines = strippedNeedle.split('\n')
  const origLines = haystack.split('\n')

  // Находим все стартовые позиции совпадений по trimStart-сравнению строк
  const matchStarts: number[] = []
  for (let i = 0; i <= origLines.length - needleLines.length; i++) {
    if (needleLines.every((nl, j) => (origLines[i + j] ?? '').trimStart() === nl)) {
      matchStarts.push(i)
    }
  }

  if (matchStarts.length === 0) {
    return { found: false, result: haystack }
  }

  const startsToReplace = replaceAll ? matchStarts : [matchStarts[0]]
  // Заменяем с последней позиции к первой, чтобы не сбить индексы
  for (let k = startsToReplace.length - 1; k >= 0; k--) {
    const start = startsToReplace[k]
    origLines.splice(start, needleLines.length, ...replacement.split('\n'))
  }

  return { found: true, result: origLines.join('\n') }
}


export async function writeFile(path: string, content: string, opts?: { dryRun?: boolean; workdir?: string }): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, opts?.workdir)
    // write_file — СОЗДАНИЕ нового файла с нуля. Перезапись существующего
    // запрещена: для правок используй edit_file (mode=apply_patch/insert/
    // overwrite) — он возвращает diff и сохраняет оригинал для
    // undo/rewind. Без этой проверки модель часто звала write_file для
    // точечных правок, теряя весь контент файла.
    if (existsSync(path)) {
      return {
        success: false,
        output: '',
        error: 'File already exists. write_file is only for creating a new file. To edit an existing file use edit_file (mode=apply_patch/insert/overwrite).',
      }
    }
    // dryRun — do not write, only return a diff preview
    if (opts?.dryRun) {
      const diff = `+++ ${path}\n${content.split('\n').map(l => '+' + l).join('\n')}`
      return { success: true, output: `[DRY RUN] CREATING new file: ${path}\n${diff}`.slice(0, 4000), diff }
    }
    await ensureDirFor(path)
    await writeWithOptionalBom(path, content)
    const lines = content.split('\n').length
    const diff = `+++ ${path}\n${content.split('\n').map(l => '+' + l).join('\n')}`
    return { success: true, output: `File created: ${path} (${lines} lines)`, diff, originalContent: null }
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
// Каждый блок заменяет ровно одно вхождение (или все при replaceAll=true).
// Если SEARCH не найден ни точно, ни fuzzy (по отступам) — ошибка.
function applySearchReplacePatch(original: string, patch: string, replaceAll = false): string {
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
      errors.push('Found SEARCH without a ======= separator')
      break
    }

    const replaceEndIdx = lines.indexOf(REPLACE_END, sepIdx + 1)
    if (replaceEndIdx === -1) {
      errors.push('Found SEARCH/SEPARATOR without >>>>>>> REPLACE')
      break
    }

    const searchText = lines.slice(searchStartIdx + 1, sepIdx).join('\n')
    const replaceText = lines.slice(sepIdx + 1, replaceEndIdx).join('\n')

    if (!searchText) {
      errors.push(`Empty SEARCH in block ${searchStartIdx + 1}`)
      i = replaceEndIdx + 1
      continue
    }

    // Normalize CRLF → LF for comparison
    const normResult = normalizeLineEndings(result)
    const normSearch = normalizeLineEndings(searchText)

    if (normResult.includes(normSearch)) {
      // Exact match found
      if (replaceAll) {
        result = normResult.split(normSearch).join(replaceText)
      } else {
        result = normResult.replace(normSearch, replaceText)
      }
    } else {
      // Fuzzy attempt: ignore leading whitespace of each line (tabs vs spaces,
      // extra/missing indent). Same logic as replace-mode fuzzy, now shared.
      const fuzzy = fuzzyFindAndReplace(normResult, normSearch, replaceText, replaceAll)
      if (fuzzy.found) {
        result = fuzzy.result
      } else {
        errors.push(buildNotFoundSnippetError(normResult, normSearch, `apply_patch SEARCH (lines ${searchStartIdx + 2}-${sepIdx})`))
      }
    }
    i = replaceEndIdx + 1
  }

  if (errors.length > 0) {
    throw new Error(`apply_patch errors (${errors.length}):\n${errors.join('\n')}`)
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
  replace_all?: boolean
  workdir?: string
}): Promise<EditResult> {
  try {
    // Legacy fallback: если модель передаёт mode='replace' (старый контекст
    // из истории чата или устаревший системный промпт) — конвертируем в
    // single-block apply_patch. Это сохраняет обратную совместимость: старые
    // чаты не ломаются, модель не получает "invalid mode" error.
    if (params.mode === 'replace') {
      if (!params.old_str) return { success: false, output: '', error: 'edit_file replace: old_str is required' }
      if (params.new_str === undefined) {
        return {
          success: false,
          output: '',
          error: 'edit_file replace: new_str is required. If you want to delete old_str — pass new_str: "" explicitly.',
        }
      }
      params = {
        ...params,
        mode: 'apply_patch',
        patch: `<<<<<<< SEARCH\n${params.old_str}\n=======\n${params.new_str}\n>>>>>>> REPLACE`,
      }
    }

    // Validate mode BEFORE any actions. Previously an invalid mode (typo,
    // hallucination: "delete", "append") silently fell through all if/else
    // branches → updated = original → file rewritten with same content →
    // success=true "0 lines changed". The AI thought the edit applied. Now —
    // an explicit error with the list of allowed modes.
    const VALID_MODES = ['apply_patch', 'insert', 'overwrite']
    if (!VALID_MODES.includes(params.mode)) {
      return {
        success: false,
        output: '',
        error: `edit_file: invalid mode="${params.mode}". Allowed modes: ${VALID_MODES.join(', ')}.`,
      }
    }

    params.path = resolveToolPath(params.path, params.workdir)
    const fileExists = existsSync(params.path)

    // create_if_not_exists — создать файл если не существует (только overwrite/insert)
    if (!fileExists) {
      if (params.create_if_not_exists) {
        if (params.dryRun) {
          const initial = params.content ?? params.new_str ?? ''
          return { success: true, output: `[DRY RUN] CREATING new file: ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}`.slice(0, 4000), diff: `+++ ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}` }
        }
        await ensureDirFor(params.path)
        const initial = params.content ?? params.new_str ?? ''
        await writeWithOptionalBom(params.path, initial)
        return { success: true, output: `File created: ${params.path}`, diff: `+++ ${params.path}\n${initial.split('\n').map(l => '+' + l).join('\n')}` }
      }
      return { success: false, output: '', error: 'File not found: ' + params.path }
    }

    // Size guard before reading. read_file has MAX_READ_FILE_SIZE=20MB,
    // edit_file did not. Editing a 500MB log → OOM / long pause without a
    // clear error. Matches the read_file limit for consistency.
    try {
      const stat = await import('fs/promises').then(m => m.stat(params.path))
      if (stat.size > 20 * 1024 * 1024) {
        return {
          success: false,
          output: '',
          error: `File too large (${Math.round(stat.size / 1024 / 1024)}MB). edit_file works with files up to 20MB. Use read_file with offset/limit for partial editing or run_command.`,
        }
      }
    } catch { /* stat failed — continue, fsReadFile below will give a clear error */ }

    const original = await fsReadFile(params.path, 'utf-8')
    let updated = original

    if (params.mode === 'apply_patch') {
      if (!params.patch) return { success: false, output: '', error: 'edit_file apply_patch: patch is required' }
      updated = applySearchReplacePatch(original, params.patch, params.replace_all ?? false)
    } else if (params.mode === 'insert') {
      // Protection against silent empty insert: content is MANDATORY for insert. Previously
      // `content ?? ''` silently inserted one empty line if the model forgot content
      // → success=true, the AI thought it inserted code.
      if (params.content === undefined) {
        return {
          success: false,
          output: '',
          error: 'edit_file insert: content is required. Pass the content to insert (an empty string "" is allowed if you want to insert a blank line).',
        }
      }
      const lines = original.split('\n')
      const at = Math.min(params.after_line ?? lines.length, lines.length)
      lines.splice(at, 0, ...params.content.split('\n'))
      updated = lines.join('\n')

    } else if (params.mode === 'overwrite') {
      if (params.content === undefined) return { success: false, output: '', error: 'edit_file overwrite: content is required' }
      updated = params.content
    }

    const diff = makeDiff(original, updated, params.path)
    // If the edit changed nothing — that is suspicious (the model called
    // edit_file but passed no changes). Report explicitly, do not write the file.
    if (updated === original) {
      return {
        success: false,
        output: '',
        error: `edit_file ${params.mode}: the edit did not change the file (old_str not found or new_str matches old_str). Check the arguments or reread the file with read_file.`,
      }
    }
    if (params.dryRun) {
      const changedLines = countChangedLines(diff)
      return { success: true, output: `[DRY RUN] Edit ${params.mode} for: ${params.path} (${changedLines} lines changed)\n${diff}`.slice(0, 4000), diff }
    }
    await writeWithOptionalBom(params.path, updated)
    const changedLines2 = countChangedLines(diff)
    return { success: true, output: `File updated: ${params.path} (${changedLines2} lines changed)`, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}


// ── Snippet-хелпер для ошибок "not found" ──────────────────────────────────
// Когда old_str / SEARCH не найден в файле, включаем в сообщение об ошибке
// фрагмент актуального содержимого файла (15 строк) с номерами строк. Это
// позволяет AI скорректировать old_str без отдельного вызова read_file —
// экономит round-trip и снижает количество ошибок редактирования.
function buildNotFoundSnippetError(normOrig: string, normOld: string, context: string): string {
  const lines = normOrig.split('\n')
  const oldFirstLine = normOld.split('\n')[0]?.trimStart() ?? ''
  // Пытаемся найти строку с частичным совпадением по первым 30 символам old_str
  const partialIdx = oldFirstLine
    ? lines.findIndex(l => l.includes(oldFirstLine.slice(0, 30)))
    : -1
  const snippetStart = Math.max(0, (partialIdx >= 0 ? partialIdx : 0) - 3)
  const SNIPPET_LINES = 15
  const snippetLines = lines.slice(snippetStart, snippetStart + SNIPPET_LINES)
  const snippet = snippetLines
    .map((l, i) => {
      const lineNum = snippetStart + i + 1
      const truncated = l.length > 200 ? l.slice(0, 200) + '…' : l
      return `${lineNum}: ${truncated}`
    })
    .join('\n')
  return `edit_file ${context}: old_str not found in the file. Here is the actual content (lines ${snippetStart + 1}-${snippetStart + snippetLines.length}):\n\n${snippet}\n\nUse this actual content to correct old_str, or reread the file with read_file.`
}