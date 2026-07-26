/**
 * IPC handlers для Skills.
 *
 * Каналы:
 *   skills:getAll      — все скиллы (с состоянием) для UI; опционально projectId
 *                        чтобы включить проектные скиллы указанного проекта.
 *   skills:setState    — обновить состояние скилла (enabled + scope).
 *   skills:reload      — сбросить кэш и перечитать скиллы с диска.
 *   skills:getActive   — активные скиллы для конкретного чата (для бейджа).
 *
 * SkillManager — синглтон, инициализируется в main/index.ts через initSkillManager.
 */
import { ipcMain, app } from 'electron'
import Store from 'electron-store'
import { join } from 'path'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { getSkillManager } from '../../core/skills/skillManager'
import { getProjectById, getChatWorkdirContext } from '../../core/db'
import type { SkillState } from '../../shared/types'

/**
 * Достаёт { projectId, workdir } для чата из БД.
 * getChatWorkdirContext возвращает только workdir/verificationCommand —
 * projectId получаем через projects-таблицу по workdir, либо напрямую из chats.
 */
function getChatProjectInfo(chatId: string): { projectId?: string; workdir?: string } {
  try {
    const ctx = getChatWorkdirContext(chatId)
    if (!ctx.workdir) return {}
    // getChatWorkdirContext уже делает JOIN projects, но не отдаёт id.
    // Перебираем проекты по workdir (он уникален по схеме — UNIQUE constraint).
    const projects = listProjectIdsByWorkdir(ctx.workdir)
    return { workdir: ctx.workdir, projectId: projects[0] }
  } catch {
    return {}
  }
}

/** Возвращает id проектов с данным workdir (обычно 0 или 1 — workdir UNIQUE). */
function listProjectIdsByWorkdir(workdir: string): string[] {
  // Используем getProjectById по известным id нельзя — id мы и ищем.
  // Прямой SQL через getProjectById не подходит; используем обходной путь:
  // читаем все проекты из БД через getAll-аналог. Чтобы не плодить функции,
  // обращаемся к getChatWorkdirContext-стилю — но проще добавить хелпер тут.
  // БД доступна через импорт database.ts — добавим минимальный запрос.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAllProjects } = require('../../core/db/database') as { getAllProjects: () => Array<{ id: string; workdir: string }> }
  return getAllProjects().filter(p => p.workdir === workdir).map(p => p.id)
}

export function registerSkillsIPC(store: Store): void {
  void store

  ipcMain.handle('skills:getAll', (_e, params?: { projectId?: string }) => {
    const mgr = getSkillManager()
    let projectWorkdir: string | undefined
    if (params?.projectId) {
      const proj = getProjectById(params.projectId)
      projectWorkdir = proj?.workdir
    }
    return mgr.getAllWithState({ projectWorkdir, projectId: params?.projectId })
  })

  ipcMain.handle('skills:setState', (_e, params: { skillId: string; state: SkillState; source: 'builtin' | 'user' | 'project' }) => {
    const mgr = getSkillManager()
    mgr.setState(params.skillId, params.state)
    return { ok: true }
  })

  ipcMain.handle('skills:reload', () => {
    getSkillManager().invalidate()
    return { ok: true }
  })

  ipcMain.handle('skills:getActive', (_e, params: { chatId: string; isIncognito?: boolean }) => {
    const mgr = getSkillManager()
    const info = getChatProjectInfo(params.chatId)
    return mgr.getActiveSkillsForChat({
      projectWorkdir: info.workdir,
      projectId: info.projectId,
      isIncognito: params.isIncognito,
    })
  })

  // Прямая установка скилла по URL — без агента.
  // Принимает URL на .md-файл (raw) или GitHub-репозиторий.
  // Для .md-файла: скачиваем и копируем в skills-папку.
  // Для репозитория: git clone → ищем .md → копируем → удаляем clone.
  ipcMain.handle('skills:installFromUrl', async (_e, params: {
    url: string
    scope: 'global' | { workdir: string }
  }): Promise<{ ok: boolean; installed: number; error?: string }> => {
    const { url } = params
    if (!url?.trim()) return { ok: false, installed: 0, error: 'URL обязателен' }

    // Целевая папка
    const targetDir = params.scope === 'global'
      ? join(app.getPath('userData'), 'skills')
      : join(params.scope.workdir, '.syntee', 'skills')
    try { mkdirSync(targetDir, { recursive: true }) } catch { /* ok */ }

    // Прямая ссылка на .md-файл (raw.githubusercontent.com или прямой URL)
    if (url.endsWith('.md') || url.includes('raw.githubusercontent.com')) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
        if (!res.ok) return { ok: false, installed: 0, error: `HTTP ${res.status}` }
        const content = await res.text()
        if (!content.trim()) return { ok: false, installed: 0, error: 'Файл пустой' }
        const filename = url.split('/').pop() || `skill-${Date.now()}.md`
        const dest = join(targetDir, filename)
        writeFileSync(dest, content, 'utf-8')
        // Инвалидируем кэш чтобы новый скилл подхватился
        getSkillManager().invalidate()
        return { ok: true, installed: 1 }
      } catch (e) {
        return { ok: false, installed: 0, error: (e as Error).message }
      }
    }

    // GitHub-репозиторий — git clone, ищем .md, копируем
    const { execFile } = require('child_process') as { execFile: (cmd: string, args: string[], opts: unknown, cb: (err: unknown, stdout: string, stderr: string) => void) => void }
    const { promisify } = require('util') as { promisify: <T>(fn: T) => T }
    const execFileAsync = promisify(execFile)
    const tmpDir = join(app.getPath('temp'), `.syntee-skill-${Date.now()}`)

    try {
      await execFileAsync('git', ['clone', '--depth', '1', url, tmpDir], { timeout: 30_000 }, () => {})

      // Ищем .md-файлы (не рекурсивно в корне + в skills/ подпапке)
      const mdFiles: string[] = []
      const scanDir = (dir: string) => {
        try {
          const entries = readdirSync(dir)
          for (const entry of entries) {
            const full = join(dir, entry)
            let stat
            try { stat = statSync(full) } catch { continue }
            if (stat.isDirectory()) {
              if (entry === '.git' || entry === 'node_modules') continue
              scanDir(full)
            } else if (entry.toLowerCase().endsWith('.md')) {
              mdFiles.push(full)
            }
          }
        } catch { /* ok */ }
      }
      scanDir(tmpDir)

      if (mdFiles.length === 0) {
        return { ok: false, installed: 0, error: 'В репозитории не найдено .md-файлов' }
      }

      // Копируем все .md в targetDir
      let installed = 0
      for (const src of mdFiles) {
        const filename = src.split(/[\\/]/).pop() || `skill-${Date.now()}-${installed}.md`
        const dest = join(targetDir, filename)
        try {
          const content = readFileSync(src, 'utf-8')
          writeFileSync(dest, content, 'utf-8')
          installed++
        } catch { /* skip */ }
      }

      // Удаляем временную папку
      try {
        await execFileAsync('rd', ['/s', '/q', tmpDir], { timeout: 5000 }, () => {})
      } catch { /* ok */ }

      getSkillManager().invalidate()
      return { ok: true, installed }
    } catch (e) {
      // Чистим temp
      try {
        await execFileAsync('rd', ['/s', '/q', tmpDir], { timeout: 5000 }, () => {})
      } catch { /* ok */ }
      return { ok: false, installed: 0, error: (e as Error).message }
    }
  })
}
