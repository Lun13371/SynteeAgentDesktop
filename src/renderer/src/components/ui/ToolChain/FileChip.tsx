import { memo } from 'react'
import AppIcon from '../AppIcon/AppIcon'
import './FileChip.css'
/**
 * Компактная плашка файла для карточек инструментов.
 *
 *   [JS] inspect-chat.mjs  scratch/dbinspect  +41 −7
 *
 * Единый вид для чтения (read_file), правки (edit_file) и записи (write_file):
 * бейдж расширения по цвету языка, имя файла, приглушённая папка и счётчики
 * строк. Полный путь — в tooltip, чтобы не занимать место в шапке карточки.
 */

// Цвета расширений — как в редакторах (GitHub/VSCode): узнаваемо с первого взгляда.
const EXT_COLORS: Record<string, string> = {
  js: '#f7df1e',
  mjs: '#f7df1e',
  cjs: '#f7df1e',
  jsx: '#61dafb',
  ts: '#3b82f6',
  tsx: '#3b82f6',
  mts: '#3b82f6',
  cts: '#3b82f6',
  json: '#f59e0b',
  jsonc: '#f59e0b',
  css: '#38bdf8',
  scss: '#ec4899',
  sass: '#ec4899',
  less: '#38bdf8',
  html: '#e34f26',
  htm: '#e34f26',
  xml: '#e34f26',
  svg: '#f59e0b',
  md: '#94a3b8',
  mdx: '#94a3b8',
  py: '#3572a5',
  rs: '#dea584',
  go: '#00add8',
  java: '#b07219',
  kt: '#a97bff',
  cs: '#178600',
  c: '#555555',
  h: '#555555',
  cpp: '#f34b7d',
  hpp: '#f34b7d',
  php: '#4f5d95',
  rb: '#701516',
  sh: '#4ade80',
  bash: '#4ade80',
  zsh: '#4ade80',
  ps1: '#38bdf8',
  bat: '#c1f12e',
  cmd: '#c1f12e',
  sql: '#e38c00',
  yml: '#cb171e',
  yaml: '#cb171e',
  toml: '#9c4221',
  ini: '#6b7280',
  env: '#faf08b',
  lock: '#6b7280',
  txt: '#94a3b8',
}

const FALLBACK_COLOR = '#94a3b8'

export function fileExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Последние две папки пути — достаточно, чтобы отличить файлы, и не режет глаз. */
export function fileDirTail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  // Последняя часть — сам файл, её не показываем.
  const dirs = parts.slice(0, -1)
  if (dirs.length === 0) return ''
  return dirs.slice(-2).join('/')
}

export interface FileChipProps {
  path: string
  /** Строк добавлено (для правок). */
  added?: number
  /** Строк удалено (для правок). */
  deleted?: number
  /** Показывать родительскую папку. */
  showDir?: boolean
  /** Путь — папка (list_directory, поиск по каталогу): иконка папки вместо
   *  бейджа расширения. Иначе такой путь получал «?». */
  isDir?: boolean
}

const DIR_COLOR = '#a78bfa'

const FileChip = memo(function FileChip({ path, added, deleted, showDir = true, isDir }: FileChipProps) {
  const trimmed = path.replace(/[\\/]+$/, '')
  const ext = fileExtension(trimmed)
  const base = trimmed.split(/[\\/]/).pop() ?? ''
  // Каталог: явный признак от вызывающего, либо путь с концевым слешем,
  // либо имя без точки вообще (папка вида src/main/ipc). Файлы без
  // расширения (Makefile, .gitignore) при этом остаются файлами.
  const asDir = isDir ?? (/[\\/]$/.test(path) || (base !== '' && !base.includes('.')))
  const color = asDir ? DIR_COLOR : (EXT_COLORS[ext] ?? FALLBACK_COLOR)
  const name = fileBaseName(trimmed)
  const dir = showDir ? fileDirTail(trimmed) : ''
  const hasStats = typeof added === 'number' || typeof deleted === 'number'
  return (
    <span className={`file-chip${asDir ? ' file-chip--dir' : ''}`} title={path}>
      {asDir ? (
        <span className="file-chip-badge file-chip-badge--dir" style={{ color, background: color + '22' }}>
          <AppIcon name="folder" size="xs" />
        </span>
      ) : (
        <span className="file-chip-badge" style={{ color, background: color + '22' }}>
          {(ext || '?').toUpperCase().slice(0, 3)}
        </span>
      )}
      <span className="file-chip-name">{name || path || 'файл'}</span>
      {dir && <span className="file-chip-dir">{dir}</span>}
      {hasStats && (
        <span className="file-chip-stats">
          {typeof added === 'number' && added > 0 && <span className="file-chip-added">+{added}</span>}
          {typeof deleted === 'number' && deleted > 0 && <span className="file-chip-deleted">−{deleted}</span>}
          {(added ?? 0) === 0 && (deleted ?? 0) === 0 && <span className="file-chip-nostat">без изменений</span>}
        </span>
      )}
    </span>
  )
}, (prev, next) =>
  prev.path === next.path && prev.added === next.added &&
  prev.deleted === next.deleted && prev.showDir === next.showDir &&
  prev.isDir === next.isDir)

export default FileChip
