/**
 * IPC handlers для маркетплейса расширений (MCP + Skills).
 *
 * Каналы:
 *   marketplace:searchMcp       — поиск MCP-серверов в официальном registry
 *   marketplace:searchSkills    — поиск Skills-репозиториев через GitHub Search API
 *   marketplace:getSkillReadme  — README репозитория для detail view
 */
import { ipcMain, app } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import Store from 'electron-store'
import { searchMcpServers } from '../../core/marketplace/mcpRegistry'
import { searchSkills, getSkillReadme } from '../../core/marketplace/skillsRegistry'
import {
  buildMcpInstallInstruction,
  buildSkillInstallInstruction,
  finalizeSkillInstruction,
  buildMcpUrlInstallInstruction,
  finalizeMcpUrlInstruction,
  type McpInstallParams,
  type SkillInstallParams,
  type McpUrlInstallParams,
} from '../../core/marketplace/installInstructions'

// AbortControllers для отмены поиска (кнопка "Отмена" в UI).
// По одному на тип поиска — новый поиск отменяет предыдущий.
let mcpSearchAbort: AbortController | null = null
let skillsSearchAbort: AbortController | null = null

export function registerMarketplaceIPC(store: Store): void {
  ipcMain.handle('marketplace:searchMcp', async (_e, params: { query: string; limit?: number; cursor?: string }) => {
    // Отменяем предыдущий поиск если он ещё идёт
    mcpSearchAbort?.abort()
    mcpSearchAbort = new AbortController()
    try {
      return await searchMcpServers(params.query ?? '', params.limit ?? 30, params.cursor, mcpSearchAbort.signal)
    } catch (e) {
      // AbortError — пользователь нажал "Отмена" или начал новый поиск.
      // Возвращаем пустой результат вместо throw (чтобы не спамить консоль Electron).
      if ((e as Error).name === 'AbortError') return { servers: [], nextCursor: undefined }
      throw e
    } finally {
      mcpSearchAbort = null
    }
  })

  ipcMain.handle('marketplace:cancelMcpSearch', () => {
    mcpSearchAbort?.abort()
    mcpSearchAbort = null
  })

  ipcMain.handle('marketplace:searchSkills', async (_e, params: { query: string; page?: number; perPage?: number }) => {
    const token = (store.get('integrations') as { github?: { token?: string } } | undefined)?.github?.token
    skillsSearchAbort?.abort()
    skillsSearchAbort = new AbortController()
    try {
      return await searchSkills(params.query ?? '', params.page ?? 1, params.perPage ?? 24, token || undefined, skillsSearchAbort.signal)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return { skills: [], hasMore: false }
      throw e
    } finally {
      skillsSearchAbort = null
    }
  })

  ipcMain.handle('marketplace:cancelSkillsSearch', () => {
    skillsSearchAbort?.abort()
    skillsSearchAbort = null
  })

  ipcMain.handle('marketplace:getSkillReadme', async (_e, params: { fullName: string }) => {
    const token = (store.get('integrations') as { github?: { token?: string } } | undefined)?.github?.token
    return getSkillReadme(params.fullName, token || undefined)
  })

  // Строит текст инструкции агенту для установки MCP-сервера/скилла.
  // Выполняется в main, потому что нужен app.getPath('userData') для
  // глобальной установки скиллов (абсолютный путь к userData/skills/).
  ipcMain.handle('marketplace:buildMcpInstruction', (_e, params: McpInstallParams) => {
    return buildMcpInstallInstruction(params)
  })

  ipcMain.handle('marketplace:buildSkillInstruction', (_e, params: SkillInstallParams) => {
    const instruction = buildSkillInstallInstruction(params)
    if (params.scope === 'global') {
      const globalSkillsPath = join(app.getPath('userData'), 'skills')
      return finalizeSkillInstruction(instruction, globalSkillsPath)
    }
    return instruction
  })

  // Инструкция для AI-установки MCP-сервера по произвольному URL
  // (GitHub/GitLab/npm/pypi/git). AI сам определяет тип, клонирует/устанавливает,
  // настраивает mcp.json и сообщает какие env нужны.
  ipcMain.handle('marketplace:buildMcpUrlInstruction', (_e, params: McpUrlInstallParams) => {
    const instruction = buildMcpUrlInstallInstruction(params)
    if (params.scope === 'global') {
      return finalizeMcpUrlInstruction(instruction, join(homedir(), '.syntee', 'mcp.json'))
    }
    return finalizeMcpUrlInstruction(instruction, join(params.workdir, '.mcp.json'))
  })
}
