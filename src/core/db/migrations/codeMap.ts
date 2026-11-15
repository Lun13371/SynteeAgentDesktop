import type Database from 'better-sqlite3'

/**
 * Схема графа кода проекта (project map). Отдельна от memory_graph_*: граф кода
 * детерминированный, пересобирается из файлов, ключуется по (project_id, path).
 * Идемпотентна — CREATE TABLE IF NOT EXISTS.
 */
export function runCodeMapSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_map_files (
      project_id  TEXT NOT NULL,
      path        TEXT NOT NULL,
      language    TEXT,
      hash        TEXT NOT NULL,
      mtime       INTEGER NOT NULL DEFAULT 0,
      size        INTEGER NOT NULL DEFAULT 0,
      parser      TEXT,
      truncated   INTEGER NOT NULL DEFAULT 0,
      indexed_at  INTEGER NOT NULL,
      PRIMARY KEY (project_id, path)
    );

    CREATE TABLE IF NOT EXISTS code_map_nodes (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      file_path   TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,
      parent_name TEXT,
      line_start  INTEGER NOT NULL DEFAULT 0,
      line_end    INTEGER NOT NULL DEFAULT 0,
      signature   TEXT NOT NULL DEFAULT '',
      exported    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS code_map_edges (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      from_node   TEXT NOT NULL,
      to_node     TEXT NOT NULL,
      type        TEXT NOT NULL,
      precision   TEXT NOT NULL DEFAULT 'heuristic',
      file_path   TEXT NOT NULL,
      line        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS code_map_status (
      project_id    TEXT PRIMARY KEY,
      state         TEXT NOT NULL DEFAULT 'idle',
      total_files   INTEGER NOT NULL DEFAULT 0,
      indexed_files INTEGER NOT NULL DEFAULT 0,
      total_nodes   INTEGER NOT NULL DEFAULT 0,
      total_edges   INTEGER NOT NULL DEFAULT 0,
      started_at    INTEGER,
      updated_at    INTEGER NOT NULL DEFAULT 0,
      error         TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cmn_project_file ON code_map_nodes(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_cmn_project_name ON code_map_nodes(project_id, name);
    CREATE INDEX IF NOT EXISTS idx_cmn_project_kind ON code_map_nodes(project_id, kind);
    CREATE INDEX IF NOT EXISTS idx_cme_project_from ON code_map_edges(project_id, from_node);
    CREATE INDEX IF NOT EXISTS idx_cme_project_to ON code_map_edges(project_id, to_node);
    CREATE INDEX IF NOT EXISTS idx_cme_project_file ON code_map_edges(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_cme_project_type ON code_map_edges(project_id, type);
  `)
}