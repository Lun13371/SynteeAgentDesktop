use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, OpenFlags, OptionalExtension};
use serde::Deserialize;

use crate::error::Result;
use crate::symbols::{FileSymbols, SymbolDef};
use crate::text::normalize_join;
use crate::walker::SourceFile;

pub struct Database {
    connection: Connection,
    /// FTS5 is a bundled-SQLite feature, but a caller can point the sidecar at a
    /// database whose FTS module is unavailable. The accelerator is optional, so
    /// a failure to create it must never break indexing.
    fts: bool,
}

const ARTIFACT_LANGS: &[&str] = &["json", "yaml", "toml", "markdown"];
/// `references` and `imports` are the weakest ranking signal; capping their
/// normalized copy keeps the index small without losing a real match.
const SEARCH_BODY_MAX_CHARS: usize = 1200;
const SEARCH_NAMES_MAX_CHARS: usize = 800;
const SEARCH_PATH_MAX_CHARS: usize = 400;
/// Above this many rows a full scan stops being free and FTS narrows the
/// candidate set first. Below it the scan wins on simplicity and recall.
const FTS_MIN_ROWS: i64 = 4_000;
const DEFINITION_FETCH_CHUNK: usize = 400;

/// A ranking row: precomputed normalized text, no definitions.
#[derive(Debug, Clone)]
pub struct IndexRow {
    pub file_path: String,
    pub lang: Option<String>,
    /// Only populated by [`Database::rows_with_symbols`] / test fixtures.
    pub symbols_json: Option<String>,
    pub search_path: String,
    pub search_names: String,
    pub search_body: String,
    pub definitions_count: i64,
    pub ranked_score: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct ExistingFile {
    pub size: u64,
    pub content_hash: u32,
    pub mtime: i64,
}

/// One file to write, already parsed.
pub struct UpsertEntry<'a> {
    pub file: &'a SourceFile,
    pub relative_path: &'a str,
    pub hash: u32,
    pub symbols: &'a FileSymbols,
}

impl IndexRow {
    /// Fills the normalized columns from `file_path` + `symbols_json`.
    ///
    /// Production rows already carry them (they are written at index time);
    /// this is for fixtures and for rows produced before the migration ran.
    pub fn with_derived_search_fields(mut self) -> Self {
        if self.search_path.is_empty() {
            self.search_path = normalize_join([self.file_path.as_str()], SEARCH_PATH_MAX_CHARS);
        }
        if self.search_names.is_empty() && self.search_body.is_empty() {
            if let Some(json) = self.symbols_json.as_deref() {
                if let Some(raw) = parse_raw_symbols(json) {
                    let (names, body) =
                        derive_search_fields(&raw.definitions, &raw.imports, &raw.references);
                    self.search_names = names;
                    self.search_body = body;
                    if self.definitions_count == 0 {
                        self.definitions_count = raw.definitions.len() as i64;
                    }
                }
            }
        }
        self
    }
}

#[derive(Debug, Default, Deserialize)]
struct RawSymbols {
    #[serde(default, rename = "d")]
    definitions: Vec<SymbolDef>,
    #[serde(default, rename = "i")]
    imports: Vec<String>,
    #[serde(default, rename = "r")]
    references: Vec<String>,
}

fn parse_raw_symbols(json: &str) -> Option<RawSymbols> {
    serde_json::from_str::<RawSymbols>(json).ok()
}

fn derive_search_fields(
    definitions: &[SymbolDef],
    imports: &[String],
    references: &[String],
) -> (String, String) {
    let mut names = String::new();
    for definition in definitions {
        if names.len() >= SEARCH_NAMES_MAX_CHARS {
            break;
        }
        let normalized = crate::text::normalize(&definition.name);
        append_field(&mut names, &normalized, SEARCH_NAMES_MAX_CHARS);
        if let Some(parent) = definition.parent_name.as_deref() {
            append_field(&mut names, &crate::text::normalize(parent), SEARCH_NAMES_MAX_CHARS);
        }
    }
    let body = normalize_join(
        imports.iter().map(String::as_str).chain(references.iter().map(String::as_str)),
        SEARCH_BODY_MAX_CHARS,
    );
    (names, body)
}

fn append_field(target: &mut String, value: &str, max_chars: usize) {
    if value.is_empty() || target.len() >= max_chars {
        return;
    }
    if !target.is_empty() {
        target.push(' ');
    }
    for word in value.split_whitespace() {
        if target.len() + word.len() + 1 > max_chars {
            return;
        }
        target.push_str(word);
        target.push(' ');
    }
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
        let mut database = Self { connection, fts: false };
        database.ensure_index_schema()?;
        database.fts = database.ensure_fts();
        Ok(database)
    }

    fn ensure_index_schema(&mut self) -> Result<()> {
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
                search_path TEXT NOT NULL DEFAULT '',
                search_names TEXT NOT NULL DEFAULT '',
                search_body TEXT NOT NULL DEFAULT '',
                definitions_count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(project_id, file_path)
            );
            CREATE INDEX IF NOT EXISTS idx_fcsi_project ON fast_context_sidecar_index(project_id);
            CREATE INDEX IF NOT EXISTS idx_fcsi_score ON fast_context_sidecar_index(project_id, ranked_score DESC);
            CREATE TABLE IF NOT EXISTS fast_context_sidecar_meta (
                project_id TEXT PRIMARY KEY,
                last_index_ms INTEGER NOT NULL DEFAULT 0,
                files_count INTEGER NOT NULL DEFAULT 0,
                fts_built INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        if !self.has_column("fast_context_sidecar_meta", "fts_built")? {
            self.connection.execute(
                "ALTER TABLE fast_context_sidecar_meta ADD COLUMN fts_built INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        // Tables created by an earlier sidecar build lack the search columns.
        // Adding them is not enough: their contents would be empty and every
        // search would miss. Zeroing `content_hash` forces the next index pass to
        // re-read and re-parse every file, which repopulates them.
        let mut added_search_column = false;
        for (name, ddl) in [
            ("search_path", "ALTER TABLE fast_context_sidecar_index ADD COLUMN search_path TEXT NOT NULL DEFAULT ''"),
            ("search_names", "ALTER TABLE fast_context_sidecar_index ADD COLUMN search_names TEXT NOT NULL DEFAULT ''"),
            ("search_body", "ALTER TABLE fast_context_sidecar_index ADD COLUMN search_body TEXT NOT NULL DEFAULT ''"),
            ("definitions_count", "ALTER TABLE fast_context_sidecar_index ADD COLUMN definitions_count INTEGER NOT NULL DEFAULT 0"),
        ] {
            if !self.has_column("fast_context_sidecar_index", name)? {
                self.connection.execute(ddl, [])?;
                if name.starts_with("search_") {
                    added_search_column = true;
                }
            }
        }
        if added_search_column {
            // Zeroing only the hash is not enough: the mtime fast path would skip
            // every file whose timestamp did not move, leaving the new columns
            // empty. An impossible mtime forces a real re-read of each row once.
            self.connection.execute(
                "UPDATE fast_context_sidecar_index SET content_hash = 0, mtime = -1",
                [],
            )?;
        }
        Ok(())
    }

    fn has_column(&self, table: &str, column: &str) -> Result<bool> {
        let mut statement = self.connection.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(names.iter().any(|name| name == column))
    }

    fn ensure_fts(&self) -> bool {
        self.connection
            .execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS fast_context_sidecar_fts USING fts5(
                    project_id UNINDEXED,
                    file_path UNINDEXED,
                    body,
                    tokenize = 'unicode61'
                );",
            )
            .is_ok()
    }

    // ── incremental indexing ────────────────────────────────────────────────

    /// All hashes of a project in one query instead of one SELECT per file.
    pub fn snapshot(&self, project_id: &str) -> Result<HashMap<String, ExistingFile>> {
        let mut statement = self.connection.prepare(
            "SELECT file_path, size, content_hash, mtime FROM fast_context_sidecar_index WHERE project_id = ?1",
        )?;
        let rows = statement.query_map([project_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ExistingFile {
                    size: row.get::<_, u64>(1)?,
                    content_hash: row.get::<_, u32>(2)?,
                    mtime: row.get::<_, i64>(3)?,
                },
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (path, entry) = row?;
            map.insert(path, entry);
        }
        Ok(map)
    }

    /// Record a new mtime for an unchanged file (hash matched, timestamp moved).
    pub fn touch(&self, project_id: &str, file_path: &str, mtime: i64) -> Result<()> {
        self.connection.execute(
            "UPDATE fast_context_sidecar_index SET mtime = ?1 WHERE project_id = ?2 AND file_path = ?3",
            params![mtime, project_id, file_path],
        )?;
        Ok(())
    }

    /// Write a whole batch in one transaction: one commit per pass instead of
    /// one per file, which was the dominant cost of a warm re-index.
    ///
    /// `maintain_fts` is false for projects below [`FTS_MIN_ROWS`]: they are
    /// searched with a full scan, so the FTS writes would be pure overhead.
    pub fn upsert_files(
        &self,
        project_id: &str,
        entries: &[UpsertEntry<'_>],
        maintain_fts: bool,
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO fast_context_sidecar_index
                    (project_id,file_path,lang,symbols_json,mtime,size,content_hash,ranked_score,updated_at,
                     search_path,search_names,search_body,definitions_count)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,0,?8,?9,?10,?11,?12)
                 ON CONFLICT(project_id,file_path) DO UPDATE SET
                   lang=excluded.lang, symbols_json=excluded.symbols_json, mtime=excluded.mtime,
                   size=excluded.size, content_hash=excluded.content_hash, updated_at=excluded.updated_at,
                   search_path=excluded.search_path, search_names=excluded.search_names,
                   search_body=excluded.search_body, definitions_count=excluded.definitions_count
                 RETURNING rowid",
            )?;
            for entry in entries {
                let (names, body) = derive_search_fields(
                    &entry.symbols.definitions,
                    &entry.symbols.imports,
                    &entry.symbols.references,
                );
                let json = serde_json::to_string(&serde_json::json!({
                    "d": &entry.symbols.definitions,
                    "i": &entry.symbols.imports,
                    "r": &entry.symbols.references,
                }))?;
                let path = entry.file.path.to_string_lossy().to_string();
                let search_path = normalize_join([entry.relative_path], SEARCH_PATH_MAX_CHARS);
                let rowid: i64 = statement.query_row(
                    params![
                        project_id,
                        path,
                        entry.file.language,
                        json,
                        entry.file.modified_ms,
                        entry.file.size,
                        entry.hash,
                        now_ms(),
                        search_path,
                        names,
                        body,
                        entry.symbols.definitions.len() as i64,
                    ],
                    |row| row.get(0),
                )?;
                if self.fts && maintain_fts {
                    transaction.execute(
                        "DELETE FROM fast_context_sidecar_fts WHERE rowid = ?1",
                        [rowid],
                    )?;
                    transaction.execute(
                        "INSERT INTO fast_context_sidecar_fts (rowid, project_id, file_path, body) VALUES (?1,?2,?3,?4)",
                        params![rowid, project_id, path, format!("{search_path} {names} {body}")],
                    )?;
                }
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_file(&self, project_id: &str, file_path: &str) -> Result<bool> {
        let transaction = self.connection.unchecked_transaction()?;
        if self.fts {
            transaction.execute(
                "DELETE FROM fast_context_sidecar_fts WHERE rowid IN
                   (SELECT rowid FROM fast_context_sidecar_index WHERE project_id = ?1 AND file_path = ?2)",
                params![project_id, file_path],
            )?;
        }
        let removed = transaction.execute(
            "DELETE FROM fast_context_sidecar_index WHERE project_id = ?1 AND file_path = ?2",
            params![project_id, file_path],
        )?;
        transaction.commit()?;
        Ok(removed > 0)
    }

    /// Remove every row under a deleted directory.
    ///
    /// Two patterns, because the stored separator is whatever the platform used:
    /// a bare `LIKE 'dir%'` would also match a sibling named `dir2`.
    pub fn delete_prefix(&self, project_id: &str, directory: &str) -> Result<usize> {
        let base = directory.trim_end_matches(['/', '\\']);
        let forward = format!("{base}/%");
        let backward = format!("{base}\\%");
        let transaction = self.connection.unchecked_transaction()?;
        if self.fts {
            transaction.execute(
                "DELETE FROM fast_context_sidecar_fts WHERE rowid IN
                   (SELECT rowid FROM fast_context_sidecar_index
                      WHERE project_id = ?1 AND (file_path LIKE ?2 OR file_path LIKE ?3))",
                params![project_id, forward, backward],
            )?;
        }
        let removed = transaction.execute(
            "DELETE FROM fast_context_sidecar_index
               WHERE project_id = ?1 AND (file_path LIKE ?2 OR file_path LIKE ?3)",
            params![project_id, forward, backward],
        )?;
        transaction.commit()?;
        Ok(removed)
    }

    pub fn delete_missing(&self, project_id: &str, seen: &HashSet<String>) -> Result<usize> {
        self.delete_where_missing(project_id, seen, None)
    }

    /// Prune stale artifact rows (JSON/YAML/TOML/Markdown) that the current capped
    /// walk did not include. Source rows are never touched: a cap may legitimately
    /// hide them, but artifact rows are the ones that crowd the cap out.
    pub fn delete_missing_artifacts(
        &self,
        project_id: &str,
        seen: &HashSet<String>,
    ) -> Result<usize> {
        self.delete_where_missing(project_id, seen, Some(ARTIFACT_LANGS))
    }

    fn delete_where_missing(
        &self,
        project_id: &str,
        seen: &HashSet<String>,
        langs: Option<&[&str]>,
    ) -> Result<usize> {
        let transaction = self.connection.unchecked_transaction()?;
        // A temp table avoids both the 999-parameter limit and one DELETE per row.
        transaction.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS seen_paths(path TEXT PRIMARY KEY);
             DELETE FROM seen_paths;",
        )?;
        {
            let mut insert =
                transaction.prepare("INSERT OR IGNORE INTO seen_paths(path) VALUES (?1)")?;
            for path in seen {
                insert.execute([path])?;
            }
        }
        let lang_filter = match langs {
            Some(langs) => format!(
                "AND lang IN ({})",
                langs.iter().map(|lang| format!("'{lang}'")).collect::<Vec<_>>().join(",")
            ),
            None => String::new(),
        };
        if self.fts {
            transaction.execute(
                &format!(
                    "DELETE FROM fast_context_sidecar_fts WHERE rowid IN
                       (SELECT rowid FROM fast_context_sidecar_index
                          WHERE project_id = ?1 AND file_path NOT IN (SELECT path FROM seen_paths) {lang_filter})"
                ),
                [project_id],
            )?;
        }
        let removed = transaction.execute(
            &format!(
                "DELETE FROM fast_context_sidecar_index
                   WHERE project_id = ?1 AND file_path NOT IN (SELECT path FROM seen_paths) {lang_filter}"
            ),
            [project_id],
        )?;
        transaction.commit()?;
        Ok(removed)
    }

    // ── reading ─────────────────────────────────────────────────────────────

    /// Ranking rows for a project. `symbols_json` is intentionally not selected:
    /// it is the largest column by far and ranking never needs it.
    pub fn scan_rows(&self, project_id: &str) -> Result<Vec<IndexRow>> {
        let mut statement = self.connection.prepare(
            "SELECT file_path,lang,search_path,search_names,search_body,definitions_count,ranked_score
               FROM fast_context_sidecar_index WHERE project_id = ?1",
        )?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok(IndexRow {
                    file_path: row.get(0)?,
                    lang: row.get(1)?,
                    symbols_json: None,
                    search_path: row.get(2)?,
                    search_names: row.get(3)?,
                    search_body: row.get(4)?,
                    definitions_count: row.get(5)?,
                    ranked_score: row.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Definitions for the files that made it into the result.
    pub fn definitions_for(
        &self,
        project_id: &str,
        paths: &[String],
    ) -> Result<HashMap<String, Vec<SymbolDef>>> {
        let mut map = HashMap::new();
        if paths.is_empty() {
            return Ok(map);
        }
        for chunk in paths.chunks(DEFINITION_FETCH_CHUNK) {
            let placeholders = (0..chunk.len())
                .map(|index| format!("?{}", index + 2))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT file_path, symbols_json FROM fast_context_sidecar_index
                   WHERE project_id = ?1 AND file_path IN ({placeholders})"
            );
            let mut statement = self.connection.prepare(&sql)?;
            let parameters = std::iter::once(project_id)
                .chain(chunk.iter().map(String::as_str))
                .collect::<Vec<_>>();
            let rows = statement.query_map(params_from_iter(parameters), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            for row in rows {
                let (path, json) = row?;
                if let Some(parsed) = json.as_deref().and_then(parse_raw_symbols) {
                    map.insert(path, parsed.definitions);
                }
            }
        }
        Ok(map)
    }

    /// Candidate paths from the FTS accelerator. `None` means "do not use FTS"
    /// (small project, FTS unavailable, or the query produced nothing usable) —
    /// the caller then falls back to a full scan.
    pub fn fts_candidates(&self, project_id: &str, tokens: &[String]) -> Option<Vec<String>> {
        if !self.fts || tokens.is_empty() {
            return None;
        }
        let count = self.count(project_id).ok()?;
        if (count as i64) < FTS_MIN_ROWS {
            return None;
        }
        let query = tokens
            .iter()
            .filter(|token| !token.is_empty())
            .map(|token| format!("\"{}\"*", token.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" OR ");
        if query.is_empty() {
            return None;
        }
        let mut statement = self
            .connection
            .prepare(
                "SELECT file_path FROM fast_context_sidecar_fts
                   WHERE body MATCH ?1 AND project_id = ?2 LIMIT 500",
            )
            .ok()?;
        let rows = statement
            .query_map(params![query, project_id], |row| row.get::<_, String>(0))
            .ok()?
            .collect::<rusqlite::Result<Vec<_>>>()
            .ok()?;
        (!rows.is_empty()).then_some(rows)
    }

    pub fn count(&self, project_id: &str) -> Result<usize> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM fast_context_sidecar_index WHERE project_id = ?1",
            [project_id],
            |row| row.get::<_, i64>(0),
        )? as usize)
    }

    pub fn clear(&self, project_id: &str) -> Result<usize> {
        let transaction = self.connection.unchecked_transaction()?;
        if self.fts {
            transaction.execute(
                "DELETE FROM fast_context_sidecar_fts WHERE rowid IN
                   (SELECT rowid FROM fast_context_sidecar_index WHERE project_id = ?1)",
                [project_id],
            )?;
        }
        let removed = transaction.execute(
            "DELETE FROM fast_context_sidecar_index WHERE project_id = ?1",
            [project_id],
        )?;
        transaction
            .execute("DELETE FROM fast_context_sidecar_meta WHERE project_id = ?1", [project_id])?;
        transaction.commit()?;
        Ok(removed)
    }

    // ── index metadata ──────────────────────────────────────────────────────

    /// Whether this project's rows are mirrored in the FTS accelerator.
    pub fn fts_ready(&self, project_id: &str) -> Result<bool> {
        if !self.fts {
            return Ok(false);
        }
        Ok(self
            .connection
            .query_row(
                "SELECT fts_built FROM fast_context_sidecar_meta WHERE project_id = ?1",
                [project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0)
            != 0)
    }

    /// Build the FTS mirror once a project grows past the scan threshold.
    ///
    /// Below it a full scan is both faster and simpler, so small projects never
    /// pay the per-row FTS writes. The rebuild is a single statement over the
    /// index, so a project that crosses the threshold converges in one pass.
    pub fn enable_fts_if_large(&self, project_id: &str) -> Result<bool> {
        if !self.fts || self.fts_ready(project_id)? {
            return Ok(false);
        }
        if (self.count(project_id)? as i64) < FTS_MIN_ROWS {
            return Ok(false);
        }
        let transaction = self.connection.unchecked_transaction()?;
        transaction
            .execute("DELETE FROM fast_context_sidecar_fts WHERE project_id = ?1", [project_id])?;
        transaction.execute(
            "INSERT INTO fast_context_sidecar_fts (rowid, project_id, file_path, body)
             SELECT rowid, project_id, file_path,
                    search_path || ' ' || search_names || ' ' || search_body
               FROM fast_context_sidecar_index WHERE project_id = ?1",
            [project_id],
        )?;
        transaction.execute(
            "INSERT INTO fast_context_sidecar_meta (project_id, fts_built) VALUES (?1, 1)
             ON CONFLICT(project_id) DO UPDATE SET fts_built = 1",
            [project_id],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub fn last_index_ms(&self, project_id: &str) -> Result<i64> {
        Ok(self
            .connection
            .query_row(
                "SELECT last_index_ms FROM fast_context_sidecar_meta WHERE project_id = ?1",
                [project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    pub fn mark_indexed(&self, project_id: &str, files_count: usize) -> Result<()> {
        self.connection.execute(
            "INSERT INTO fast_context_sidecar_meta (project_id, last_index_ms, files_count)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(project_id) DO UPDATE SET last_index_ms = excluded.last_index_ms,
               files_count = excluded.files_count",
            params![project_id, now_ms(), files_count as i64],
        )?;
        Ok(())
    }

    // ── graph ranking ───────────────────────────────────────────────────────

    /// Fill `ranked_score` from the definition/reference graph.
    ///
    /// A file gains score for every other file that references a name it
    /// defines — the cheap, index-only version of "how much of the codebase
    /// depends on this file". Runs after a pass that actually changed something,
    /// so a warm re-index does not pay for it.
    pub fn recompute_rank(&self, project_id: &str) -> Result<usize> {
        let mut statement = self.connection.prepare(
            "SELECT file_path, search_names, search_body FROM fast_context_sidecar_index WHERE project_id = ?1",
        )?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        if rows.is_empty() {
            return Ok(0);
        }

        let mut definers: HashMap<&str, Vec<usize>> = HashMap::new();
        for (index, (_, names, _)) in rows.iter().enumerate() {
            for token in names.split_whitespace() {
                definers.entry(token).or_default().push(index);
            }
        }

        let mut incoming = vec![0.0_f64; rows.len()];
        for (index, (_, _, body)) in rows.iter().enumerate() {
            let mut credited: HashSet<usize> = HashSet::new();
            for token in body.split_whitespace() {
                let Some(targets) = definers.get(token) else { continue };
                for target in targets {
                    if *target != index && credited.insert(*target) {
                        incoming[*target] += 1.0;
                    }
                }
            }
        }

        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut update = transaction.prepare(
                "UPDATE fast_context_sidecar_index SET ranked_score = ?1 WHERE project_id = ?2 AND file_path = ?3",
            )?;
            for (index, (path, _, _)) in rows.iter().enumerate() {
                let score = if incoming[index] <= 0.0 {
                    0.0
                } else {
                    (1.0 + incoming[index]).ln().min(6.0)
                };
                update.execute(params![score, project_id, path])?;
            }
        }
        transaction.commit()?;
        Ok(rows.len())
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
    use crate::symbols::{FileSymbols, SymbolDef};
    use crate::walker::SourceFile;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("syntee-sidecar-{label}-{}.db", std::process::id()))
    }

    fn open_with_projects(label: &str) -> (Database, PathBuf) {
        let path = temp_path(label);
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY);").unwrap();
        drop(connection);
        (Database::open(&path).unwrap(), path)
    }

    fn source_file(path: &str) -> SourceFile {
        SourceFile {
            path: PathBuf::from(path),
            language: "rust".to_owned(),
            size: 10,
            modified_ms: 1,
        }
    }

    fn symbols(name: &str, references: &[&str]) -> FileSymbols {
        FileSymbols {
            definitions: vec![SymbolDef {
                name: name.to_owned(),
                kind: "function".to_owned(),
                line_start: 1,
                line_end: 2,
                signature: format!("fn {name}()"),
                parent_name: None,
            }],
            imports: Vec::new(),
            references: references.iter().map(|value| (*value).to_owned()).collect(),
            truncated: false,
        }
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
        let (database, path) = open_with_projects("existing");
        drop(database);
        assert!(path.exists());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn upsert_writes_search_columns_and_definitions() {
        let (database, path) = open_with_projects("upsert");
        let file = source_file("C:/proj/src/tokens.rs");
        let file_symbols = symbols("count_tokens", &["cl100k_base"]);
        database
            .upsert_files(
                "p1",
                &[super::UpsertEntry {
                    file: &file,
                    relative_path: "src/tokens.rs",
                    hash: 42,
                    symbols: &file_symbols,
                }],
                false,
            )
            .unwrap();
        let rows = database.scan_rows("p1").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].search_names.contains("count tokens"));
        assert!(rows[0].search_path.contains("tokens rs"));
        assert!(rows[0].search_body.contains("cl100k base"));
        assert_eq!(rows[0].definitions_count, 1);
        let definitions = database.definitions_for("p1", &[rows[0].file_path.clone()]).unwrap();
        assert_eq!(definitions.len(), 1);
        drop(database);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn delete_missing_prunes_rows_outside_the_seen_set() {
        let (database, path) = open_with_projects("prune");
        let keep = source_file("C:/proj/src/keep.rs");
        let drop_file = source_file("C:/proj/src/drop.rs");
        let keep_symbols = symbols("keep", &[]);
        let drop_symbols = symbols("drop", &[]);
        database
            .upsert_files(
                "p1",
                &[
                    super::UpsertEntry {
                        file: &keep,
                        relative_path: "src/keep.rs",
                        hash: 1,
                        symbols: &keep_symbols,
                    },
                    super::UpsertEntry {
                        file: &drop_file,
                        relative_path: "src/drop.rs",
                        hash: 2,
                        symbols: &drop_symbols,
                    },
                ],
                false,
            )
            .unwrap();
        let mut seen = std::collections::HashSet::new();
        seen.insert("C:/proj/src/keep.rs".to_owned());
        assert_eq!(database.delete_missing("p1", &seen).unwrap(), 1);
        assert_eq!(database.count("p1").unwrap(), 1);
        drop(database);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn graph_rank_rewards_files_whose_names_are_referenced() {
        let (database, path) = open_with_projects("rank");
        let core = source_file("C:/proj/src/core.rs");
        let user_a = source_file("C:/proj/src/user_a.rs");
        let user_b = source_file("C:/proj/src/user_b.rs");
        let core_symbols = symbols("compute_rank", &[]);
        let user_symbols = symbols("caller", &["compute_rank"]);
        database
            .upsert_files(
                "p1",
                &[
                    super::UpsertEntry {
                        file: &core,
                        relative_path: "src/core.rs",
                        hash: 1,
                        symbols: &core_symbols,
                    },
                    super::UpsertEntry {
                        file: &user_a,
                        relative_path: "src/user_a.rs",
                        hash: 2,
                        symbols: &user_symbols,
                    },
                    super::UpsertEntry {
                        file: &user_b,
                        relative_path: "src/user_b.rs",
                        hash: 3,
                        symbols: &user_symbols,
                    },
                ],
                false,
            )
            .unwrap();
        database.recompute_rank("p1").unwrap();
        let rows = database.scan_rows("p1").unwrap();
        let core_row = rows.iter().find(|row| row.file_path.ends_with("core.rs")).unwrap();
        let user_row = rows.iter().find(|row| row.file_path.ends_with("user_a.rs")).unwrap();
        assert!(core_row.ranked_score > user_row.ranked_score);
        drop(database);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn fts_mirror_is_only_built_for_large_projects() {
        let (database, path) = open_with_projects("ftsgate");
        let file = source_file("C:/proj/src/a.rs");
        let file_symbols = symbols("alpha", &[]);
        database
            .upsert_files(
                "p1",
                &[super::UpsertEntry {
                    file: &file,
                    relative_path: "src/a.rs",
                    hash: 1,
                    symbols: &file_symbols,
                }],
                false,
            )
            .unwrap();
        // One row is far below the threshold: no mirror, no per-row FTS writes.
        assert!(!database.enable_fts_if_large("p1").unwrap());
        assert!(!database.fts_ready("p1").unwrap());
        drop(database);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn legacy_table_gets_search_columns_and_a_forced_reindex() {
        let path = temp_path("legacy");
        let _ = std::fs::remove_file(&path);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY);
                 CREATE TABLE fast_context_sidecar_index (
                    project_id TEXT NOT NULL, file_path TEXT NOT NULL, lang TEXT, symbols_json TEXT,
                    mtime INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL DEFAULT 0,
                    ranked_score REAL NOT NULL DEFAULT 0, relevance_boost REAL NOT NULL DEFAULT 0,
                    embedding BLOB, updated_at INTEGER NOT NULL DEFAULT 0,
                    content_hash INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_id, file_path));
                 INSERT INTO fast_context_sidecar_index (project_id, file_path, content_hash)
                    VALUES ('p1', 'C:/proj/src/a.rs', 123);",
            )
            .unwrap();
        drop(connection);
        let database = Database::open(&path).unwrap();
        let snapshot = database.snapshot("p1").unwrap();
        assert_eq!(snapshot["C:/proj/src/a.rs"].content_hash, 0, "stale rows must be re-parsed");
        assert_eq!(
            snapshot["C:/proj/src/a.rs"].mtime, -1,
            "the mtime fast path must not skip them"
        );
        drop(database);
        let _ = std::fs::remove_file(path);
    }
}
