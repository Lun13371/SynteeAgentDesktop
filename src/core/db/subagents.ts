import { getDB } from './handle'

/**
 * Персистентное хранилище записей суб-агентов.
 *
 * AgentManager держит running-агентов in-memory (воркеры в worker_threads),
 * но после рестарта приложения мапа пуста — карточки саб-агентов в чатах
 * теряют контекст (шаги, summary, статус). Таблица subagents восстанавливает
 * их через agent:get / agent:list.
 *
 * running/pending на момент рестарта логически мертвы (воркер убит), поэтому
 * loadAllAgents() помечает их 'cancelled' с пометкой в error — честнее
 * вечного spinner'а. См. AgentManager.init().
 */

export interface SubagentRow {
  id: string
  parentId: string | null
  chatId: string
  task: string
  status: string
  model: string | null
  mode: string | null
  steps: unknown[]
  result: string
  summary: string
  createdAt: number
  finishedAt: number | null
  error: string | null
  workdir: string | null
  isolationMode: string | null
  role: string | null
}

type SavedRow = {
  id: string
  parent_id: string | null
  chat_id: string
  task: string
  status: string
  model: string | null
  mode: string | null
  steps_json: string | null
  result: string | null
  summary: string | null
  created_at: number
  finished_at: number | null
  error: string | null
  workdir: string | null
  isolation_mode: string | null
  role: string | null
}

function parseRow(r: SavedRow): SubagentRow {
  return {
    id: r.id,
    parentId: r.parent_id,
    chatId: r.chat_id,
    task: r.task,
    status: r.status,
    model: r.model,
    mode: r.mode,
    steps: r.steps_json ? JSON.parse(r.steps_json) : [],
    result: r.result ?? '',
    summary: r.summary ?? '',
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    error: r.error,
    workdir: r.workdir,
    isolationMode: r.isolation_mode,
    role: r.role,
  }
}

const COLS = `id, parent_id, chat_id, task, status, model, mode,
  steps as steps_json, result, summary, created_at, finished_at, error,
  workdir, isolation_mode, role`

export function saveSubagent(rec: SubagentRow): void {
  getDB().prepare(`
    INSERT OR REPLACE INTO subagents
      (id, parent_id, chat_id, task, status, model, mode, steps, result,
       summary, created_at, finished_at, error, workdir, isolation_mode, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rec.id,
    rec.parentId,
    rec.chatId,
    rec.task,
    rec.status,
    rec.model,
    rec.mode,
    rec.steps.length ? JSON.stringify(rec.steps) : null,
    rec.result || null,
    rec.summary || null,
    rec.createdAt,
    rec.finishedAt,
    rec.error,
    rec.workdir,
    rec.isolationMode,
    rec.role,
  )
}

export function loadAllSubagents(): SubagentRow[] {
  const rows = getDB().prepare(`SELECT ${COLS} FROM subagents ORDER BY created_at ASC`).all() as SavedRow[]
  return rows.map(parseRow)
}

export function deleteSubagentsByChat(chatId: string): void {
  getDB().prepare(`DELETE FROM subagents WHERE chat_id = ?`).run(chatId)
}
