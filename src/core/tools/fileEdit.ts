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

export async function writeFile(path: string, content: string, opts?: { dryRun?: boolean; workdir?: string }): Promise<ToolResult> {
  try {
    path = resolveToolPath(path, opts?.workdir)
    // write_file — СОЗДАНИЕ нового файла с нуля. Перезапись существующего
    // запрещена: для правок используй edit_file (mode=replace/insert/
    // overwrite/apply_patch) — он возвращает diff и сохраняет оригинал для
    // undo/rewind. Без этой проверки модель часто звала write_file для
    // точечных правок, теряя весь контент файла.
    if (existsSync(path)) {
      return {
        success: false,
        output: '',
        error: 'File already exists. write_file is only for creating a new file. To edit an existing file use edit_file (mode=replace/insert/overwrite/apply_patch).',
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

    if (!normResult.includes(normSearch)) {
      errors.push(`SEARCH not found (lines ${searchStartIdx + 2}-${sepIdx}): "${searchText.slice(0, 80)}..."`)
      i = replaceEndIdx + 1
      continue
    }

    // Replace only the first occurrence
    result = normResult.replace(normSearch, replaceText)
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
  workdir?: string
}): Promise<EditResult> {
  try {
    // Validate mode BEFORE any actions. Previously an invalid mode (typo,
    // hallucination: "delete", "append") silently fell through all if/else
    // branches → updated = original → file rewritten with same content →
    // success=true "0 lines changed". The AI thought the edit applied. Now —
    // an explicit error with the list of allowed modes.
    const VALID_MODES = ['replace', 'insert', 'overwrite', 'apply_patch']
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
      updated = applySearchReplacePatch(original, params.patch)
    } else if (params.mode === 'replace') {
      if (!params.old_str) return { success: false, output: '', error: 'edit_file replace: old_str is required' }
      // Protection against silent delete: new_str is MANDATORY for replace. Previously
      // `new_str ?? ''` silently replaced the found fragment with an empty string =
      // deleted code if the model forgot to pass new_str. Now an explicit error.
      // Deletion via replace is still available: pass new_str: "" explicitly to delete.
      if (params.new_str === undefined) {
        return {
          success: false,
          output: '',
          error: 'edit_file replace: new_str is required. If you want to delete old_str — pass new_str: "" explicitly. Deletion without explicit new_str is forbidden (protection against accidental code loss).',
        }
      }
      const normOrig = normalizeLineEndings(original)
      const normOld = normalizeLineEndings(params.old_str)
      if (!normOrig.includes(normOld)) {
        // Fuzzy attempt: ignore leading whitespace of lines
        const stripIndent = (s: string) => s.split('\n').map(l => l.trimStart()).join('\n')
        if (stripIndent(normOrig).includes(stripIndent(normOld))) {
          const oldLines = normOld.split('\n').map(l => l.trimStart())
          const origLines = normOrig.split('\n')
          const matchIdx = origLines.findIndex((_, i) =>
            oldLines.every((ol, j) => (origLines[i + j] ?? '').trimStart() === ol)
          )
          if (matchIdx >= 0) {
            const realOld = origLines.slice(matchIdx, matchIdx + oldLines.length).join('\n')
            updated = normOrig.replace(realOld, params.new_str)
          } else {
            return { success: false, output: '', error: 'edit_file replace: old_str not found (fuzzy did not help either). Check indentation and fragment accuracy. The file may have changed — reread it with read_file.' }
          }
        } else {
          return { success: false, output: '', error: 'edit_file replace: old_str not found in the file. Reread the file with read_file to confirm the actual content.' }
        }
      } else {
        updated = normOrig.replace(normOld, params.new_str)
      }

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
