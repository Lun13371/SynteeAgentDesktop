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
export function writeWithOptionalBom(filePath: string, content: string): Promise<void> {
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
  // trimStart + trimEnd (trailing whitespace) для сравнения — но не для замены
  const stripIndent = (s: string) => s.split('\n').map(l => l.trimStart().replace(/\s+$/, '')).join('\n')
  const strippedHaystack = stripIndent(haystack)
  const strippedNeedle = stripIndent(needle)

  if (!strippedHaystack.includes(strippedNeedle)) {
    return { found: false, result: haystack }
  }

  const needleLines = strippedNeedle.split('\n')
  const origLines = haystack.split('\n')

  // Находим все стартовые позиции совпадений по trimStart+trimEnd сравнению строк
  const matchStarts: number[] = []
  for (let i = 0; i <= origLines.length - needleLines.length; i++) {
    if (needleLines.every((nl, j) => (origLines[i + j] ?? '').trimStart().replace(/\s+$/, '') === nl)) {
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


export async function writeFile(path: string, content: string, opts?: { dryRun?: boolean; workdir?: string; force?: boolean }): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, opts?.workdir)
    // write_file — СОЗДАНИЕ нового файла с нуля. Перезапись существующего
    // запрещена (если force !== true): для правок используй edit_file
    // (mode=apply_patch/insert/overwrite) — он возвращает diff и сохраняет
    // оригинал для undo/rewind. force=true позволяет перезаписать существующий
    // файл (например, для восстановления после неудачной правки).
    if (existsSync(path) && !opts?.force) {
      return {
        success: false,
        output: '',
        error: 'File already exists. write_file is only for creating a new file. To edit an existing file use edit_file (mode=apply_patch/insert/overwrite), or pass force=true to overwrite.',
      }
    }
    let originalContent: string | null = null
    if (existsSync(path) && opts?.force) {
      originalContent = await fsReadFile(path, 'utf-8')
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
    return { success: true, output: `File created: ${path} (${lines} lines)`, diff, originalContent }
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

    // Обрезаем пустые строки в начале/конце SEARCH — модель часто добавляет
    // случайные пустые строки вокруг паттерна, что ломает точный поиск.
    const trimmedSearch = searchText.replace(/^\n+/, '').replace(/\n+$/, '')

    if (!trimmedSearch) {
      errors.push(`Empty SEARCH in block ${searchStartIdx + 1}`)
      i = replaceEndIdx + 1
      continue
    }

    // Normalize CRLF → LF for comparison
    const normResult = normalizeLineEndings(result)
    const normSearch = normalizeLineEndings(trimmedSearch)

    if (normResult.includes(normSearch)) {
      // Exact match found
      if (replaceAll) {
        result = normResult.split(normSearch).join(replaceText)
      } else {
        result = normResult.replace(normSearch, replaceText)
      }
    } else {
      // Fuzzy attempt: ignore leading/trailing whitespace of each line (tabs vs
      // spaces, extra/missing indent, trailing whitespace). Same logic as
      // replace-mode fuzzy, now shared.
      const fuzzy = fuzzyFindAndReplace(normResult, normSearch, replaceText, replaceAll)
      if (fuzzy.found) {
        result = fuzzy.result
      } else {
        const hint = 'Tip: the SEARCH block does not match the file. Reread the file with read_file and copy the exact content into the SEARCH block. The snippet below shows the actual file content around the expected location.'
        errors.push(buildNotFoundSnippetError(normResult, normSearch, `apply_patch SEARCH (lines ${searchStartIdx + 2}-${sepIdx})`) + ' ' + hint)
      }
    }
    i = replaceEndIdx + 1
  }

  if (errors.length > 0) {
    throw new Error(`apply_patch errors (${errors.length}):\n${errors.join('\n')}`)
  }

  // Preserve original line endings: normalizeLineEndings above converted
  // result to LF for comparison. If original had CRLF, restore it so the
  // file doesn't silently switch from CRLF to LF (which would make git diff
  // show every line as changed on Windows).
  if (original.includes('\r\n')) {
    result = result.replace(/\r?\n/g, '\r\n')
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
  confirm_overwrite?: boolean
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
    if (!params.mode || !VALID_MODES.includes(params.mode)) {
      // Если mode пустой или невалидный — дефолтим на apply_patch вместо ошибки.
      // Модель может передать пустой mode из-за обрыва стрима или битого JSON —
      // лучше тихо дефолтить, чем блокировать тул.
      params.mode = 'apply_patch'
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
    let insertWarning = ''

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
      // Context check: предупредить если after_line внутри незакрытой многострочной
      // конструкции (открытый {, (, [). Вставка туда может сломать синтаксис.
      const braceWarn = checkBraceBalance(lines, at)
      lines.splice(at, 0, ...params.content.split('\n'))
      updated = lines.join('\n')
      if (braceWarn) {
        insertWarning = braceWarn
      }

    } else if (params.mode === 'overwrite') {
      if (params.content === undefined) return { success: false, output: '', error: 'edit_file overwrite: content is required' }
      // Safety guard: предотвратить случайное уничтожение файла (4128 строк → 1).
      // Если новый контент составляет <10% строк от оригинала и модель НЕ передала
      // confirm_overwrite=true — отказ. Модель повторит с confirm_overwrite=true
      // если это действительно intended.
      const origLines = original.split('\n').length
      const newLines = params.content.split('\n').length
      if (origLines > 10 && newLines < origLines * 0.1 && !params.confirm_overwrite) {
        const pct = Math.round((1 - newLines / origLines) * 100)
        return {
          success: false,
          output: '',
          error: `overwrite will replace ${origLines} lines with ${newLines} lines (${pct}% reduction). This looks like accidental data loss. If this is intentional, pass confirm_overwrite=true.`,
        }
      }
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
    const outMsg = `File updated: ${params.path} (${changedLines2} lines changed)`
    return { success: true, output: insertWarning ? `${outMsg}\n⚠ ${insertWarning}` : outMsg, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}
// ── Проверка баланса скобок для insert context warning ──────────────────────
// Считает баланс { } ( ) [ ] от строки 1 до upToLine. Если баланс ненулевой —
// after_line находится внутри незакрытой конструкции. Упрощённо: не парсит
// строковые литералы и комментарии (false positives возможны, но warning
// не блокирует — лучше ложный warning, чем сломанный import).
function checkBraceBalance(lines: string[], upToLine: number): string | null {
  let depth = 0
  let openChar = ''
  const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' }
  const opens = new Set(['{', '(', '['])
  for (let i = 0; i < Math.min(upToLine, lines.length); i++) {
    // Упрощённо: убираем содержимое строковых литералов в той же строке
    // (одинарные/двойные кавычки, backtick template literals)
    const stripped = lines[i].replace(/'(?:[^'\\]|\\.)*'/g, '').replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/`(?:[^`\\]|\\.)*`/g, '')
    for (const ch of stripped) {
      if (opens.has(ch)) {
        if (depth === 0) openChar = ch
        depth++
      } else if (pairs[ch]) {
        depth = Math.max(0, depth - 1)
      }
    }
  }
  if (depth > 0) {
    const typeName = openChar === '{' ? 'brace' : openChar === '(' ? 'paren' : 'bracket'
    return `Line ${upToLine} is inside an unclosed ${typeName} block (depth=${depth}). Insert here may break syntax.`
  }
  return null
}


// ── Snippet-хелпер для ошибок "not found" ──────────────────────────────────
// Когда old_str / SEARCH не найден в файле, включаем в сообщение об ошибке
// фрагмент актуального содержимого файла (15 строк) с номерами строк. Это
// позволяет AI скорректировать old_str без отдельного вызова read_file —
// экономит round-trip и снижает количество ошибок редактирования.
function buildNotFoundSnippetError(normOrig: string, normOld: string, context: string): string {
  const lines = normOrig.split('\n')
  // Пытаемся найти ЛЮБУЮ строку из old_str в файле (не только первую).
  // Перебираем строки old_str — больше шансов попасть в нужную область.
  const oldLines = normOld.split('\n').map(l => l.trimStart()).filter(l => l.length > 0)
  let partialIdx = -1
  for (const oldLine of oldLines) {
    const probe = oldLine.slice(0, 40)
    if (probe) {
      partialIdx = lines.findIndex(l => l.includes(probe))
      if (partialIdx >= 0) break
    }
  }
  const snippetStart = Math.max(0, (partialIdx >= 0 ? partialIdx : 0) - 5)
  const SNIPPET_LINES = 30
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
