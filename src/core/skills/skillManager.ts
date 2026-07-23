/**
 * SkillManager — синглтон в main-процессе.
 *
 * Отвечает за:
 *   - загрузку всех скиллов (builtin + user + project)
 *   - применение per-skill состояния (enabled + scope) из electron-store
 *   - селекцию активных скиллов для конкретного чата/проекта с учётом инкогнито
 *   - инвалидацию кэша (по mtime)
 *
 * Состояние скиллов хранится в store.skillsState по id скилла:
 *   { [skillId]: { enabled, scope: { type:'global'|'projects', projectIds? } } }
 *
 * Скиллы без записи в skillsState — по умолчанию ВЫключены (явное opt-in),
 * кроме встроенных (builtin) — они по умолчанию включены глобально.
 */

import Store from 'electron-store'
import { loadAllSkills, tagProjectSkills } from './skillLoader'
import type { Skill, SkillState, ExtensionScope } from '../../shared/types'

export class SkillManager {
  private store: Store
  /** workdir → cached skills. Инвалидируется по mtime папки (грубо). */
  private projectCache = new Map<string, { mtimeMs: number; skills: Skill[] }>()
  /** Глобальные (builtin + user) — кэшируем один раз, живут всё приложение. */
  private globalSkills: Skill[] | null = null

  constructor(store: Store) {
    this.store = store
  }

  /** Сбросить весь кэш — вызывается при явной перезагрузке из UI. */
  invalidate(): void {
    this.globalSkills = null
    this.projectCache.clear()
  }

  /** Загружает все скиллы: глобальные + проектные для указанного workdir. */
  loadSkills(projectWorkdir?: string, projectId?: string): Skill[] {
    if (this.globalSkills === null) {
      this.globalSkills = loadAllSkills(undefined)
    }
    let projectSkills: Skill[] = []
    if (projectWorkdir) {
      // Простая инвалидация по existsSync — если папка есть, сканируем каждый раз.
      // Файлы немногочисленны, парсинг дешёвый — без mtime-трекинга на уровне файла.
      projectSkills = loadAllSkills(projectWorkdir).filter(s => s.source === 'project')
      if (projectId) projectSkills = tagProjectSkills(projectSkills, projectId)
    }
    return [...this.globalSkills, ...projectSkills]
  }

  /** Читает состояние скилла из store (с дефолтом для builtin). */
  getState(skillId: string, source: Skill['source']): SkillState {
    const stateMap = (this.store.get('skillsState') as Record<string, SkillState> | undefined) ?? {}
    const st = stateMap[skillId]
    if (st) return st
    // builtin по умолчанию включены глобально; остальные — выключены.
    if (source === 'builtin') {
      return { enabled: true, scope: { type: 'global' } }
    }
    return { enabled: false, scope: { type: 'global' } }
  }

  /** Сохраняет состояние скилла. */
  setState(skillId: string, state: SkillState): void {
    const stateMap = (this.store.get('skillsState') as Record<string, SkillState> | undefined) ?? {}
    stateMap[skillId] = state
    this.store.set('skillsState', stateMap)
  }

  /** Обновляет часть состояния скилла (merge). */
  patchState(skillId: string, patch: Partial<SkillState>, source: Skill['source']): void {
    const current = this.getState(skillId, source)
    this.setState(skillId, { ...current, ...patch })
  }

  /**
   * Применимо ли расширение к данному чату по scope.
   * - global → всегда да
   * - projects → да если projectId в списке projectIds
   */
  private scopeApplies(scope: ExtensionScope, projectId?: string): boolean {
    if (scope.type === 'global') return true
    if (!projectId || !scope.projectIds?.length) return false
    return scope.projectIds.includes(projectId)
  }

  /**
   * Возвращает скиллы, активные для данного чата — для инъекции в system prompt.
   * В инкогнито-режиме возвращает пустой массив (приватность).
   */
  getActiveSkillsForChat(opts: {
    projectWorkdir?: string
    projectId?: string
    isIncognito?: boolean
  }): Skill[] {
    if (opts.isIncognito) return []
    const all = this.loadSkills(opts.projectWorkdir, opts.projectId)
    return all.filter(skill => {
      const state = this.getState(skill.id, skill.source)
      if (!state.enabled) return false
      return this.scopeApplies(state.scope, opts.projectId)
    })
  }

  /**
   * Возвращает все скиллы с их состоянием — для UI (popover).
   * projectWorkdir/projectId — чтобы включить проектные скиллы в список.
   */
  getAllWithState(opts: { projectWorkdir?: string; projectId?: string } = {}): Array<Skill & { state: SkillState }> {
    const all = this.loadSkills(opts.projectWorkdir, opts.projectId)
    return all.map(skill => ({
      ...skill,
      state: this.getState(skill.id, skill.source),
    }))
  }
}

// Синглтон создаётся в main-процессе при инициализации (см. main/index.ts).
let skillManagerInstance: SkillManager | null = null

export function initSkillManager(store: Store): SkillManager {
  skillManagerInstance = new SkillManager(store)
  return skillManagerInstance
}

export function getSkillManager(): SkillManager {
  if (!skillManagerInstance) {
    throw new Error('SkillManager не инициализирован. Вызови initSkillManager() в main.')
  }
  return skillManagerInstance
}
