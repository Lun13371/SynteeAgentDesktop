use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension};

use crate::error::Result;
use crate::symbols::FileSymbols;

pub struct Database {
    connection: Connection,
}

const ARTIFACT_LANGS: &[&str] = &["json", "yaml", "toml", "markdown"];

#[derive(Debug, Clone)]
pub struct IndexRow {
    pub file_path: String,
    pub lang: Option<String>,
    pub symbols_json: Option<String>,
    pub size: u64,
    pub content_hash: u32,
    pub ranked_score: f64,
    pub relevance_boost: f64,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        validate_db_path(path)?;
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        if !has_projects_table(&connection)? {
            return Err(crate::error::SidecarError::InvalidRequest(
                "dbPath is not an existing Syntee database: projects table is missing".to_owned(),
            ));
        }
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        connection.pragma_update(None, "busy_timeout", 5_000_i64)?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let database = Self { connection };
        database.ensure_index_schema()?;
        Ok(database)
    }

    fn ensure_index_schema(&self) -> Result<()> {
        self.connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS fast_context_sidecar_index (
                project_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                lang TEXT,
                symbols_json TEXT,
                mtime INTEGER NOT NULL DEFAULT 0,
                size INTEGER NOT NULL DEFAULT 0,
                ranked_score REAL NOT NULL DEFAULT 0,
                relevance_boost REAL NOT NULL DEFAULT 0,
                embedding BLOB,
                updated_at INTEGER NOT NULL DEFAULT 0,
                content_hash INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(project_id, file_path)
            );
            CREATE INDEX IF NOT EXISTS idx_fcsi_project ON fast_context_sidecar_index(project_id);
            CREATE INDEX IF NOT EXISTS idx_fcsi_score ON fast_context_sidecar_index(project_id, ranked_score DESC);",
        )?;
        Ok(())
    }

    pub fn existing_hash(&self, project_id: &str, file_path: &str) -> Result<Option<(u64, u32)>> {
        self.connection
            .query_row(
                "SELECT size, content_hash FROM fast_context_sidecar_index WHERE project_id = ?1 AND file_path = ?2",
                (project_id, file_path),
                |row| Ok((row.get::<_, u64>(0)?, row.get::<_, u32>(1)?)),
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn upsert_file(
        &self,
        project_id: &str,
        file: &crate::walker::SourceFile,
        hash: u32,
        symbols: &FileSymbols,
    ) -> Result<()> {
        let json = serde_json::to_string(&serde_json::json!({
            "d": &symbols.definitions,
            "i": &symbols.imports,
            "r": &symbols.references,
        }))?;
        self.connection.execute(
            "INSERT INTO fast_context_sidecar_index (project_id,file_path,lang,symbols_json,mtime,size,content_hash,ranked_score,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8)
             ON CONFLICT(project_id,file_path) DO UPDATE SET
               lang=excluded.lang, symbols_json=excluded.symbols_json, mtime=excluded.mtime,
               size=excluded.size, content_hash=excluded.content_hash, updated_at=excluded.updated_at,
               embedding=CASE WHEN excluded.content_hash != fast_context_sidecar_index.content_hash THEN NULL ELSE fast_context_sidecar_index.embedding END",
            rusqlite::params![project_id, file.path.to_string_lossy(), file.language, json, file.modified_ms, file.size, hash, now_ms()],
        )?;
        Ok(())
    }

    pub fn delete_file(&self, project_id: &str, file_path: &str) -> Result<bool> {
        Ok(self.connection.execute(
            "DELETE FROM fast_context_sidecar_index WHERE project_id = ?1 AND file_path = ?2",
            (project_id, file_path),
        )? > 0)
    }

    pub fn delete_missing(&self, project_id: &str, seen: &[String]) -> Result<usize> {
        self.delete_where_missing(project_id, seen, None)
    }

    /// Prune stale artifact rows (JSON/YAML/TOML/Markdown) that the current capped
    /// walk did not include. Source rows are never touched: a cap may legitimately
    /// hide them, but artifact rows are the ones that crowd the cap out.
    pub fn delete_missing_artifacts(&self, project_id: &str, seen: &[String]) -> Result<usize> {
        self.delete_where_missing(project_id, seen, Some(ARTIFACT_LANGS))
    }

    fn delete_where_missing(
        &self,
        project_id: &str,
        seen: &[String],
        langs: Option<&[&str]>,
    ) -> Result<usize> {
        let seen: std::collections::HashSet<&str> = seen.iter().map(String::as_str).collect();
        let transaction = self.connection.unchecked_transaction()?;
        let mut removed = 0;
        let mut statement = transaction.prepare(
            "SELECT file_path, lang FROM fast_context_sidecar_index WHERE project_id = ?1",
        )?;
        let rows: Vec<(String, Option<String>)> = statement
            .query_map([project_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        for (path, lang) in rows {
            if seen.contains(path.as_str()) {
                continue;
            }
            if let Some(allowed) = langs {
                let is_allowed =
                    lang.as_deref().map(|value| allowed.contains(&value)).unwrap_or(false);
                if !is_allowed {
                    continue;
                }
            }
            removed += transaction.execute(
                "DELETE FROM fast_context_sidecar_index WHERE project_id = ?1 AND file_path = ?2",
                (project_id, path),
            )?;
        }
        transaction.commit()?;
        Ok(removed)
    }

    pub fn rows(&self, project_id: &str) -> Result<Vec<IndexRow>> {
        let mut statement = self.connection.prepare(
            "SELECT file_path,lang,symbols_json,size,content_hash,ranked_score,relevance_boost FROM fast_context_sidecar_index WHERE project_id = ?1 ORDER BY ranked_score DESC",
        )?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok(IndexRow {
                    file_path: row.get(0)?,
                    lang: row.get(1)?,
                    symbols_json: row.get(2)?,
                    size: row.get(3)?,
                    content_hash: row.get(4)?,
                    ranked_score: row.get(5)?,
                    relevance_boost: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn count(&self, project_id: &str) -> Result<usize> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM fast_context_sidecar_index WHERE project_id = ?1",
            [project_id],
            |row| row.get::<_, i64>(0),
        )? as usize)
    }

    pub fn clear(&self, project_id: &str) -> Result<usize> {
        Ok(self.connection.execute(
            "DELETE FROM fast_context_sidecar_index WHERE project_id = ?1",
            [project_id],
        )?)
    }
}

fn validate_db_path(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty() {
        return Err(crate::error::SidecarError::InvalidRequest(
            "dbPath must point to an existing Syntee database".to_owned(),
        ));
    }
    if !path.is_file() {
        return Err(crate::error::SidecarError::InvalidRequest(format!(
            "dbPath does not point to an existing database file: {}",
            path.display()
        )));
    }
    Ok(())
}

fn has_projects_table(connection: &Connection) -> Result<bool> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects')",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

// The sidecar owns a separate table and intentionally performs no column migrations.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use rusqlite::Connection;

    use super::Database;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("syntee-sidecar-{label}-{}.db", std::process::id()))
    }

    #[test]
    fn missing_db_is_rejected_without_creating_a_file() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        assert!(Database::open(&path).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn existing_syntee_db_gets_isolated_sidecar_table() {
        let path = temp_path("existing");
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY);").unwrap();
        drop(connection);
        assert!(Database::open(&path).is_ok());
        let connection = Connection::open(&path).unwrap();
        let tables = connection
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(tables.contains(&"fast_context_sidecar_index".to_owned()));
        assert!(!tables.contains(&"fast_context_index".to_owned()));
        let _ = std::fs::remove_file(&path);
    }
}
