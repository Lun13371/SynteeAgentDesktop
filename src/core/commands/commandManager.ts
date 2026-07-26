/**
 * CommandManager — синглтон в main-процессе.
 *
 * Отвечает за:
 *   - загрузку всех кастомных slash-команд (builtin-pkg + user + project)
 *   - кэширование по workdir с инвалидацией по mtime папки
 *   - селекцию команд для UI (объединение с builtin из SLASH_COMMANDS
 *     происходит в renderer через filterCommands/builtin+custom)
 *
 * В отличие от SkillManager, у команд нет per-command state (enabled/scope) —
 * они все "активны" если файл существует. Управление состоянием не нужно,
 * поскольку кастомная команда не инъектируется в system prompt автоматически
 * (как скиллы) — она срабатывает только при явном вводе /name.
 */

import { loadAllCommands } from './commandLoader'
import type { SlashCommand } from '../../shared/slashCommands'

export class CommandManager {
  /** workdir → cached custom commands. Инвалидируется по mtime папки. */
  private projectCache = new Map<string, { mtimeMs: number; commands: SlashCommand[] }>()
  /** Глобальные (builtin-pkg + user) — кэшируем один раз. */
  private globalCommands: SlashCommand[] | null = null

  /** Сбросить весь кэш — вызывается при явной перезагрузке из UI. */
  invalidate(): void {
    this.globalCommands = null
    this.projectCache.clear()
  }

  /**
   * Загружает все кастомные команды: глобальные + проектные для workdir.
   * Возвращает только custom-команды — builtin из SLASH_COMMANDS renderer
   * добавляет сам через filterCommands(builtin + custom).
   */
  loadCommands(projectWorkdir?: string): SlashCommand[] {
    if (this.globalCommands === null) {
      this.globalCommands = loadAllCommands(undefined)
    }
    let projectCommands: SlashCommand[] = []
    if (projectWorkdir) {
      // Простая инвалидация: проверяем .syntee/commands/ каждый раз.
      // Файлов немного, парсинг дешёвый — без mtime-трекинга на уровне файла.
      projectCommands = loadAllCommands(projectWorkdir).filter(c => c.source === 'project')
    }
    return [...this.globalCommands, ...projectCommands]
  }

  /**
   * Возвращает все кастомные команды для UI. projectWorkdir — чтобы включить
   * проектные команды в список.
   */
  getAllForUI(opts: { projectWorkdir?: string } = {}): SlashCommand[] {
    return this.loadCommands(opts.projectWorkdir)
  }
}

// Синглтон создаётся в main-процессе при инициализации (см. main/index.ts).
let commandManagerInstance: CommandManager | null = null

export function initCommandManager(): CommandManager {
  commandManagerInstance = new CommandManager()
  return commandManagerInstance
}

export function getCommandManager(): CommandManager {
  if (!commandManagerInstance) {
    throw new Error('CommandManager не инициализирован. Вызови initCommandManager() в main.')
  }
  return commandManagerInstance
}
