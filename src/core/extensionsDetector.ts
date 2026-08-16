/**
 * Extensions Detector — простая система обнаружения MCP-серверов и skills
 * для активного проекта. Без chokidar: детект при активации чата + polling
 * каждые few секунд (configurable). Перекрывает и случай когда .mcp.json
 * уже существует при открытии проекта, и когда файл создаётся/меняется
 * в процессе работы (например через /setup).
 *
 * Принцип:
 *   - При setActiveProject(workdir) — немедленный scan + запуск polling.
 *   - Каждые POLL_INTERVAL_MS — повторный scan; если обнаружены новые
 *     .mcp.json-записи или .md в .syntee/skills/ — пуш в McpManager/
 *     SkillManager и renderer.
 *   - Хэши по содержимому файлов — не дёргаем менеджеры если ничего не
 *     изменилось (экономим CPU).
 *
 * Сравнение с chokidar: проще, надёжнее на Windows (нет проблем с
 * watchем несуществующих путей), не требует лишних FS-handles. Минус —
 * задержка до POLL_INTERVAL_MS (2с) — приемлемо для onboarding-флоу.
 */
import { existsSync, statSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { IPC_EVENTS } from '../shared/constants'
import { getMcpManager } from './mcp/McpManager'
import { getSkillManager } from './skills/skillManager'

let _getWindow: (() => BrowserWindow | null) | null = null
let _workdir: string | null = null
let _projectId: string | null = null
let _pollTimer: NodeJS.Timeout | null = null
let _mcpHash: string | ''
let _skillsHash: string = ''

/** Интервал polling — 5с. Достаточно быстро для UX (onboarding-флоу),
 * дёшево для CPU (один stat+hash). 2с было слишком агрессивно для idle. */
const POLL_INTERVAL_MS = 5000

/** Установить getter окна для push-ивентов в renderer. */
export function initExtensionsDetector(getWindow: () => BrowserWindow | null): void {
  _getWindow = getWindow
}

function emitSkillsUpdated(projectId: string): void {
  const win = _getWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC_EVENTS.SKILLS_UPDATED, { projectId })
  }
}

/** Быстрый хэш содержимого файла (не крипто-стойкий — просто для сравнения). */
function fileHash(filePath: string): string {
  try {
    const content = readFileSync(filePath, 'utf-8')
    // Простой djb2-хэш — достаточно чтобы отличить изменения, дёшево.
    let h = 5381
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) + h + content.charCodeAt(i)) | 0
    }
    return content.length + ':' + (h >>> 0).toString(36)
  } catch {
    return ''
  }
}

/** Хэш папки skills — сумма хэшей всех .md (порядок-independent через sorted). */
function skillsDirHash(dir: string): string {
  if (!existsSync(dir)) return ''
  try {
    const entries = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md'))
    const parts: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry)
      try {
        const st = statSync(full)
        parts.push(entry + ':' + st.size + ':' + st.mtimeMs)
      } catch { /* skip */ }
    }
    parts.sort()
    return parts.join('|')
  } catch {
    return ''
  }
}

/** Один scan-цикл: сравнить хэши, при изменении дернуть менеджеры. */
function scanOnce(): void {
  if (!_workdir || !_projectId) return
  // Пауза когда главное окно скрыто — экономит FS-stat'ы в фоне.
  // При возврате окна следующий тик обновит состояние.
  const win = _getWindow?.()
  if (win && !win.isDestroyed() && !win.isVisible()) return
  const mcpJsonPath = join(_workdir, '.mcp.json')
  const skillsDir = join(_workdir, '.syntee', 'skills')

  // MCP
  const mcpH = existsSync(mcpJsonPath) ? fileHash(mcpJsonPath) : ''
  if (mcpH !== _mcpHash) {
    _mcpHash = mcpH
    try {
      getMcpManager().reloadProjectServers(_workdir, _projectId)
    } catch (e) {
      console.warn('[extensionsDetector] reloadProjectServers failed:', e)
    }
  }

  // Skills
  const skillsH = skillsDirHash(skillsDir)
  if (skillsH !== _skillsHash) {
    _skillsHash = skillsH
    try {
      const changed = getSkillManager().autoEnableProjectSkills(_projectId, _workdir)
      emitSkillsUpdated(_projectId)
      if (changed) {
        console.log('[extensionsDetector] auto-enabled new project skills for', _projectId)
      }
    } catch (e) {
      console.warn('[extensionsDetector] autoEnableProjectSkills failed:', e)
    }
  }
}

/** Останавливает polling и сбрасывает состояние. */
function stopCurrent(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _workdir = null
  _projectId = null
  _mcpHash = ''
  _skillsHash = ''
}

/**
 * Переключает детектор на активный проект. projectId=null — остановить.
 * Вызывается из fastcontext:setActive handler и/или при активации чата.
 * Немедленный scan + запуск polling на POLL_INTERVAL_MS.
 */
export function setActiveExtensionsProject(projectId: string | null, workdir?: string): void {
  // Нет проекта — останавливаем.
  if (!projectId || !workdir) {
    stopCurrent()
    return
  }
  // Тот же проект — не пересоздаём (polling уже идёт).
  if (_workdir === workdir && _projectId === projectId && _pollTimer) {
    scanOnce()
    return
  }
  stopCurrent()
  _workdir = workdir
  _projectId = projectId
  scanOnce()
  _pollTimer = setInterval(scanOnce, POLL_INTERVAL_MS)
}

/** Текущий наблюдаемый projectId (для логов/диагностики). */
export function getWatchedProjectId(): string | null {
  return _projectId
}
