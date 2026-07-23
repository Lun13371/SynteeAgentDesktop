/**
 * Загрузка конфигурации MCP-серверов из двух источников:
 *   1. Глобальные  — ~/.syntee/mcp.json (файл, редактируемый агентом)
 *   2. Проектные   — {workdir}/.mcp.json (стандартный формат Claude Code)
 *
 * Формат обоих файлов идентичен (Claude Code совместимый):
 *   {
 *     "mcpServers": {
 *       "name": { "command": "...", "args": [...], "env": {...} },
 *       "remote": { "url": "https://...", "type": "streamable-http" }
 *     }
 *   }
 *
 * Runtime-состояние (enabled, scope, toolStates) хранится в electron-store:
 *   - Глобальные:   store.mcpGlobalState[serverName]
 *   - Проектные:    store.mcpProjectState[projectId][serverName]
 */

import Store from 'electron-store'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { GLOBAL_MCP_FILE } from '../../shared/constants'
import type { McpServerConfig, McpToolState, ExtensionScope, McpTransport } from '../../shared/types'

interface McpJsonEntry {
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  type?: string // "stdio" | "sse" | "streamable-http"
}
interface McpJsonFile {
  mcpServers?: Record<string, McpJsonEntry>
}

/** Абсолютный путь к глобальному ~/.syntee/mcp.json. */
export function getGlobalMcpPath(): string {
  return join(homedir(), GLOBAL_MCP_FILE)
}

/** Читает и парсит JSON-файл (mcp.json формат). Молча возвращает пустой объект. */
function readMcpJson(filePath: string): McpJsonFile {
  if (!existsSync(filePath)) return {}
  try {
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as McpJsonFile
  } catch {
    return {}
  }
}

/** Записывает mcpJson в файл, создавая родительские директории. */
function writeMcpJson(filePath: string, data: McpJsonFile): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

/** Определяет транспорт из entry. */
function detectTransport(entry: McpJsonEntry): McpTransport {
  if (entry.type === 'streamable-http' || (entry.url && entry.type !== 'sse')) {
    return 'streamable-http'
  }
  if (entry.url || entry.type === 'sse') {
    return 'sse'
  }
  return 'stdio'
}

/**
 * Загружает ВСЕ серверы: глобальные (из ~/.syntee/mcp.json) + проектные (из .mcp.json).
 * Каждый вызов перечитывает оба файла с диска (они небольшие).
 */
export function loadAllServers(
  store: Store,
  projectWorkdir?: string,
  projectId?: string,
): McpServerConfig[] {
  const out: McpServerConfig[] = []

  // 1. Глобальные из ~/.syntee/mcp.json
  const globalFile = readMcpJson(getGlobalMcpPath())
  if (globalFile.mcpServers) {
    for (const [name, entry] of Object.entries(globalFile.mcpServers)) {
      const transport = detectTransport(entry)
      out.push({
        id: `global:${name}`,
        name,
        transport,
        command: entry.command,
        args: entry.args,
        env: entry.env,
        url: entry.url,
        headers: entry.headers,
        // enabled/scope подставляются менеджером из store.mcpGlobalState
        enabled: true,
        scope: { type: 'global' },
        source: 'global',
      })
    }
  }

  // 2. Проектные из {workdir}/.mcp.json
  if (projectWorkdir) {
    const mcpJsonPath = join(projectWorkdir, '.mcp.json')
    const projectFile = readMcpJson(mcpJsonPath)
    if (projectFile.mcpServers) {
      for (const [name, entry] of Object.entries(projectFile.mcpServers)) {
        const transport = detectTransport(entry)
        const id = projectId ? `project:${projectId}:${name}` : `project:${name}`
        out.push({
          id,
          name,
          transport,
          command: entry.command,
          args: entry.args,
          env: entry.env,
          url: entry.url,
          headers: entry.headers,
          enabled: true,
          scope: { type: 'projects', projectIds: projectId ? [projectId] : [] },
          source: 'project',
          projectId,
        })
      }
    }
  }

  return out
}

// ── Чтение runtime-состояния ──────────────────────────────────────────────

/** Per-tool состояние проектного сервера из store.mcpProjectState. */
export function getProjectToolStates(
  store: Store,
  projectId: string,
  serverName: string,
): Record<string, McpToolState> {
  const state = (store.get('mcpProjectState') as Record<string, {
    toolStates?: Record<string, McpToolState>
    scope?: ExtensionScope
    enabled?: boolean
  }> | undefined) ?? {}
  return state[projectId]?.[serverName]?.toolStates ?? {}
}

/** Per-tool состояние глобального сервера из store.mcpGlobalState. */
export function getGlobalToolStates(
  store: Store,
  serverName: string,
): Record<string, McpToolState> {
  const state = (store.get('mcpGlobalState') as Record<string, {
    toolStates?: Record<string, McpToolState>
  }> | undefined) ?? {}
  return state[serverName]?.toolStates ?? {}
}

// ── CRUD глобальных серверов (файл) ───────────────────────────────────────

/** Сохраняет/обновляет глобальный сервер в ~/.syntee/mcp.json. */
export function saveGlobalServerToFile(config: McpServerConfig): void {
  const filePath = getGlobalMcpPath()
  const data = readMcpJson(filePath)
  if (!data.mcpServers) data.mcpServers = {}
  const entry: McpJsonEntry = {}
  if (config.transport === 'stdio') {
    entry.command = config.command
    if (config.args?.length) entry.args = config.args
    if (config.env && Object.keys(config.env).length) entry.env = config.env
  } else {
    entry.url = config.url
    if (config.transport === 'streamable-http') entry.type = 'streamable-http'
    else if (config.transport === 'sse') entry.type = 'sse'
    if (config.headers && Object.keys(config.headers).length) entry.headers = config.headers
  }
  data.mcpServers[config.name] = entry
  writeMcpJson(filePath, data)
}

/** Удаляет глобальный сервер из ~/.syntee/mcp.json по имени. */
export function deleteGlobalServerFromFile(serverName: string): void {
  const filePath = getGlobalMcpPath()
  const data = readMcpJson(filePath)
  if (data.mcpServers && data.mcpServers[serverName]) {
    delete data.mcpServers[serverName]
    writeMcpJson(filePath, data)
  }
}

/**
 * Сохраняет/обновляет проектный сервер в {workdir}/.mcp.json.
 * Используется при прямой установке MCP из маркетплейса (без агента) —
 * приложение само пишет файл, не создавая чат с инструкцией.
 */
export function saveProjectServerToFile(config: McpServerConfig, workdir: string): void {
  const filePath = join(workdir, '.mcp.json')
  const data = readMcpJson(filePath)
  if (!data.mcpServers) data.mcpServers = {}
  const entry: McpJsonEntry = {}
  if (config.transport === 'stdio') {
    entry.command = config.command
    if (config.args?.length) entry.args = config.args
    if (config.env && Object.keys(config.env).length) entry.env = config.env
  } else {
    entry.url = config.url
    if (config.transport === 'streamable-http') entry.type = 'streamable-http'
    else if (config.transport === 'sse') entry.type = 'sse'
    if (config.headers && Object.keys(config.headers).length) entry.headers = config.headers
  }
  data.mcpServers[config.name] = entry
  writeMcpJson(filePath, data)
}

// ── Утилиты ───────────────────────────────────────────────────────────────

/** Per-tool состояние по умолчанию: включён, подтверждение требуется. */
export function defaultToolState(): McpToolState {
  return { enabled: true, requireApproval: true }
}

/** Генерирует id для нового сервера (legacy, для совместимости). */
export function generateServerId(): string {
  return 'mcp-' + randomUUID().slice(0, 8)
}

/**
 * Миграция: переносит старые глобальные серверы из store.mcpServers
 * в файл ~/.syntee/mcp.json. Вызывается один раз при инициализации.
 * Безопасна: если файл уже существует, не перезаписывает.
 */
export function migrateGlobalMcpToFile(store: Store): void {
  const oldServers = (store.get('mcpServers') as McpServerConfig[] | undefined) ?? []
  if (oldServers.length === 0) return

  const filePath = getGlobalMcpPath()
  const existing = readMcpJson(filePath)

  // Переносим runtime-состояние в mcpGlobalState
  const globalState = (store.get('mcpGlobalState') as Record<string, {
    enabled: boolean
    scope: ExtensionScope
    toolStates: Record<string, McpToolState>
  }> | undefined) ?? {}

  for (const srv of oldServers) {
    // Записываем в файл (если ещё нет)
    if (!existing.mcpServers) existing.mcpServers = {}
    if (!existing.mcpServers[srv.name]) {
      const entry: McpJsonEntry = {}
      if (srv.transport === 'stdio') {
        entry.command = srv.command
        if (srv.args?.length) entry.args = srv.args
        if (srv.env && Object.keys(srv.env).length) entry.env = srv.env
      } else if (srv.url) {
        entry.url = srv.url
        if (srv.transport === 'streamable-http') entry.type = 'streamable-http'
        else if (srv.transport === 'sse') entry.type = 'sse'
        if (srv.headers && Object.keys(srv.headers).length) entry.headers = srv.headers
      }
      existing.mcpServers[srv.name] = entry
    }
    // Переносим состояние
    if (!globalState[srv.name]) {
      globalState[srv.name] = {
        enabled: srv.enabled,
        scope: srv.scope ?? { type: 'global' },
        toolStates: (store.get('mcpGlobalToolStates') as Record<string, Record<string, McpToolState>> | undefined)?.[srv.id] ?? {},
      }
    }
  }

  writeMcpJson(filePath, existing)
  store.set('mcpGlobalState', globalState)

  // Чистим старые ключи
  store.delete('mcpServers')
  store.delete('mcpGlobalToolStates')
}
