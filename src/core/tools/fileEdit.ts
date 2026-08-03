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
        error: 'Файл уже существует. write_file только для создания нового файла. Для правок существующего используй edit_file (mode=replace/insert/overwrite/apply_patch).',
      }
    }
    // dryRun — не записываем, только возвращаем diff-превью
    if (opts?.dryRun) {
      const diff = `+++ ${path}\n${content.split('\n').map(l => '+' + l).join('\n')}`
      return { success: true, output: `[DRY RUN] СОЗДАНИЕ нового файла: ${path}\n${diff}`.slice(0, 4000), diff }
    }
    await ensureDirFor(path)
    await writeWithOptionalBom(path, content)
    const lines = content.split('\n').length
    const diff = `+++ ${path}\n${content.split('\n').map(l => '+' + l).join('\n')}`
    return { success: true, output: `Файл создан: ${path} (${lines} строк)`, diff, originalContent: null }
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
        await writeWithOptionalBom(params.path, initial)
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
    await writeWithOptionalBom(params.path, updated)
    const changedLines2 = countChangedLines(diff)
    return { success: true, output: `Файл обновлён: ${params.path} (${changedLines2} строк изменено)`, diff, originalContent: original }
  } catch (e: any) {
    return { success: false, output: '', error: e.message }
  }
}
