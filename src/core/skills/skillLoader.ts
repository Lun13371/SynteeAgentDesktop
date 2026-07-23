/**
 * Загрузчик скиллов — markdown-файлов с YAML frontmatter.
 *
 * Источники (приоритет от низшего к высшему — проектные перекрывают
 * пользовательские перекрывают встроенные при совпадении id):
 *   1. builtin  — resources/skills/ (вшиты в дистрибутив)
 *   2. user     — {userData}/skills/
 *   3. project  — {workdir}/.syntee/skills/
 *
 * Формат файла:
 *   ---
 *   name: Краткое имя
 *   description: Описание одной-двумя строками
 *   ---
 *   Тело файла — инструкции, попадающие в system prompt когда скилл включён.
 *
 * frontmatter минимален и парсится встроенным парсером (без новой зависимости).
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Skill, SkillSource } from '../../shared/types'

interface ParsedFrontmatter {
  name?: string
  description?: string
  /** Неиспользуемые поля пока сохраняем, чтобы не ломать парсинг. */
  raw: Record<string, string>
}

/** Минимальный YAML-парсер для плоских key: value. Без вложенностей/массивов. */
function parseFlatYaml(text: string): ParsedFrontmatter {
  const raw: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    // Снимаем кавычки
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    raw[m[1]] = val
  }
  return { name: raw.name, description: raw.description, raw }
}

/**
 * Разбирает .md-файл: frontmatter (между --- ... ---) + тело-инструкции.
 * Если frontmatter нет — имя = basename без .md, описание = первая непустая строка.
 */
function parseSkillFile(filePath: string, source: SkillSource, projectId?: string): Skill | null {
  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
  let stat: { mtimeMs: number }
  try {
    stat = statSync(filePath)
  } catch {
    return null
  }

  const basename = filePath.split(/[\\/]/).pop() ?? filePath
  const nameNoExt = basename.replace(/\.md$/i, '')

  let name = nameNoExt
  let description = ''
  let instructions = content

  // frontmatter: файл начинается с --- на первой строке
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (fmMatch) {
    const fm = parseFlatYaml(fmMatch[1])
    if (fm.name) name = fm.name
    description = fm.description ?? ''
    instructions = fmMatch[2] ?? ''
  } else {
    // Без frontmatter: первая непустая строка = описание
    const lines = content.split(/\r?\n/)
    for (const ln of lines) {
      const t = ln.trim()
      if (t) { description = t; break }
    }
  }

  instructions = instructions.trim()
  if (!instructions) return null

  const id = `${source}:${projectId ?? ''}:${nameNoExt}`

  return {
    id,
    name: name || nameNoExt,
    description: description || name,
    instructions,
    source,
    filePath,
    projectId,
    mtimeMs: stat.mtimeMs,
  }
}

/** Сканирует папку и возвращает скиллы из всех .md файлов (не рекурсивно). */
function scanDir(dir: string, source: SkillSource, projectId?: string): Skill[] {
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const skills: Skill[] = []
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue
    const full = join(dir, entry)
    try {
      if (!statSync(full).isFile()) continue
    } catch { continue }
    const skill = parseSkillFile(full, source, projectId)
    if (skill) skills.push(skill)
  }
  return skills
}

/**
 * Загружает ВСЕ скиллы из всех источников.
 *
 * @param projectWorkdir — workdir текущего проекта (для проектных скиллов).
 *   Если undefined — проектные скиллы не загружаются.
 * @param builtinDir — переопределять только в тестах.
 */
export function loadAllSkills(projectWorkdir?: string, builtinDir?: string): Skill[] {
  const out: Skill[] = []

  // 1. builtin — вшитые скиллы. В packed-приложении лежат в resources/skills.
  let builtinPath = builtinDir
  if (!builtinPath) {
    try {
      builtinPath = join(process.resourcesPath ?? '', 'skills')
    } catch {
      builtinPath = ''
    }
  }
  if (builtinPath && existsSync(builtinPath)) {
    out.push(...scanDir(builtinPath, 'builtin'))
  }

  // 2. user — глобальная папка пользователя.
  let userDir = ''
  try {
    userDir = join(app.getPath('userData'), 'skills')
  } catch { /* app может быть недоступен в тестах */ }
  if (userDir) {
    out.push(...scanDir(userDir, 'user'))
  }

  // 3. project — .syntee/skills/ в workdir.
  if (projectWorkdir) {
    const projectDir = join(projectWorkdir, '.syntee', 'skills')
    out.push(...scanDir(projectDir, 'project', undefined))
  }

  return out
}

/**
 * Присваивает projectId проектным скиллам (post-hoc, после загрузки по workdir
 * конкретного проекта). loadAllSkills вызывается с workdir, но projectId
 * выставляется здесь, когда менеджер знает id проекта.
 */
export function tagProjectSkills(skills: Skill[], projectId: string): Skill[] {
  return skills.map(s => s.source === 'project' ? { ...s, projectId } : s)
}
