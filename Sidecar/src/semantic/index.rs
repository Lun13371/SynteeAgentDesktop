//! Индексация источников recall_memory в `semantic_embeddings`.
//!
//! Перенесено из `src/core/memory/semanticIndex.ts` (indexSource +
//! runSemanticIndexingOnce). Логика 1:1, но исполняется в отдельном процессе,
//! поэтому блокировки event loop main больше не существует.
//!
//! Свойства:
//!   - идемпотентность: sha256(текст) + тег модели; неизменённые строки
//!     пропускаются, эмбеддятся только новые/изменённые;
//!   - keyset-пагинация (`WHERE id > ? ORDER BY id LIMIT ?`) — память bounded;
//!   - уступка фореграунду: пока main сообщает `foregroundBusy`, цикл спит;
//!   - бюджет времени на цикл: недоделанное доедет следующим вызовом;
//!   - ошибка одной строки не валит цикл (failed++ и дальше).

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::embed::{self, EmbedPrefix, E5Embedder, E5_MODEL_TAG};
use super::store;
use super::types::{SourceReport, SourceRow, SourceStats, SemanticSource};
use super::FOREGROUND_BUSY;
use crate::common::error::Result;

/// Строк на страницу (keyset-пагинация) — bounded память.
const DEFAULT_PAGE_SIZE: usize = 200;
/// Пауза после каждого эмбеддинга: индексация уступает CPU.
const DEFAULT_PAUSE_BETWEEN_ITEMS_MS: u64 = 40;
/// Пауза между страницами — даже если всё skipped (просто читали хэши).
const DEFAULT_PAUSE_BETWEEN_PAGES_MS: u64 = 250;
/// E5 лимит ~512 токенов; для RU/EN ~3 символа/токен → 1500 символов с запасом.
const DEFAULT_MAX_TEXT_CHARS: usize = 1_500;
/// Бюджет CPU-времени на один вызов цикла.
///
/// В TS цикла не было предела и он растягивался на 16.7 минуты (замер
/// 26.10.2026). Здесь недоделанная работа просто продолжится следующим вызовом.
const DEFAULT_BUDGET_MS: u64 = 60_000;
/// Ожидание тишины после активности пользователя.
const FOREGROUND_QUIET_MS: u64 = 2_000;
const FOREGROUND_POLL_MS: u64 = 250;

/// Настройки цикла индексации (приходят из TS — там же живут константы UI).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexRunOptions {
    #[serde(default = "default_page_size")]
    pub page_size: usize,
    #[serde(default = "default_pause_items")]
    pub pause_between_items_ms: u64,
    #[serde(default = "default_pause_pages")]
    pub pause_between_pages_ms: u64,
    #[serde(default = "default_max_text_chars")]
    pub max_text_chars: usize,
    #[serde(default = "default_budget_ms")]
    pub budget_ms: u64,
    /// Пустое значение — все пять источников в каноническом порядке.
    #[serde(default)]
    pub sources: Vec<SemanticSource>,
}

fn default_page_size() -> usize {
    DEFAULT_PAGE_SIZE
}
fn default_pause_items() -> u64 {
    DEFAULT_PAUSE_BETWEEN_ITEMS_MS
}
fn default_pause_pages() -> u64 {
    DEFAULT_PAUSE_BETWEEN_PAGES_MS
}
fn default_max_text_chars() -> usize {
    DEFAULT_MAX_TEXT_CHARS
}
fn default_budget_ms() -> u64 {
    DEFAULT_BUDGET_MS
}

impl Default for IndexRunOptions {
    fn default() -> Self {
        Self {
            page_size: DEFAULT_PAGE_SIZE,
            pause_between_items_ms: DEFAULT_PAUSE_BETWEEN_ITEMS_MS,
            pause_between_pages_ms: DEFAULT_PAUSE_BETWEEN_PAGES_MS,
            max_text_chars: DEFAULT_MAX_TEXT_CHARS,
            budget_ms: DEFAULT_BUDGET_MS,
            sources: Vec::new(),
        }
    }
}

/// Итог одного цикла.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleReport {
    pub model: &'static str,
    pub sources: Vec<SourceReport>,
    pub duration_ms: u64,
    /// true — бюджет кончился, остаток источников доедет следующим вызовом.
    pub budget_exhausted: bool,
    pub total_indexed: usize,
    pub total_skipped: usize,
    pub total_failed: usize,
}

/// Один цикл индексации всех запрошенных источников.
pub fn run_cycle(
    db_path: &Path,
    embedder: &E5Embedder,
    options: &IndexRunOptions,
) -> Result<CycleReport> {
    let started = Instant::now();
    let budget = Duration::from_millis(options.budget_ms);
    let connection = store::open(db_path)?;

    let sources: Vec<SemanticSource> = if options.sources.is_empty() {
        SemanticSource::ALL.to_vec()
    } else {
        options.sources.clone()
    };

    let mut reports = Vec::with_capacity(sources.len());
    let mut budget_exhausted = false;

    for source in sources {
        if started.elapsed() >= budget {
            budget_exhausted = true;
            break;
        }
        let source_started = Instant::now();
        let stats = index_source(&connection, source, embedder, options, started, budget)?;
        reports.push(SourceReport {
            source,
            stats,
            duration_ms: source_started.elapsed().as_millis() as u64,
        });
        if started.elapsed() >= budget {
            budget_exhausted = true;
            break;
        }
    }

    let total_indexed = reports.iter().map(|r| r.stats.indexed).sum();
    let total_skipped = reports.iter().map(|r| r.stats.skipped).sum();
    let total_failed = reports.iter().map(|r| r.stats.failed).sum();

    Ok(CycleReport {
        model: E5_MODEL_TAG,
        sources: reports,
        duration_ms: started.elapsed().as_millis() as u64,
        budget_exhausted,
        total_indexed,
        total_skipped,
        total_failed,
    })
}

/// Индексация одного источника.
fn index_source(
    connection: &Connection,
    source: SemanticSource,
    embedder: &E5Embedder,
    options: &IndexRunOptions,
    cycle_started: Instant,
    budget: Duration,
) -> Result<SourceStats> {
    let mut stats = SourceStats::default();
    let mut after_id = String::new();

    let mut select_existing = connection.prepare_cached(
        "SELECT content_hash, model FROM semantic_embeddings WHERE source = ? AND source_id = ?",
    )?;
    let mut upsert = connection.prepare_cached(
        "INSERT OR REPLACE INTO semantic_embeddings
           (source, source_id, content_hash, embedding, model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )?;

    loop {
        if !wait_for_foreground_idle(cycle_started, budget) {
            break;
        }
        let rows = fetch_page(connection, source, &after_id, options.page_size)?;
        if rows.is_empty() {
            break;
        }
        let page_len = rows.len();
        after_id = rows[rows.len() - 1].id.clone();

        for row in rows {
            if cycle_started.elapsed() >= budget {
                return Ok(stats);
            }

            let text = truncate_chars(row.text.trim(), options.max_text_chars);
            if text.is_empty() {
                stats.skipped += 1;
                continue;
            }

            let hash = sha256_hex(&text);
            let existing: Option<(String, String)> = select_existing
                .query_row(params![source.as_str(), &row.id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .ok();

            // Не переэмбеддим неизменённое: hash совпал + та же модель.
            if let Some((content_hash, model)) = existing {
                if content_hash == hash && model == E5_MODEL_TAG {
                    if !wait_for_foreground_idle(cycle_started, budget) {
                        return Ok(stats);
                    }
                    stats.skipped += 1;
                    continue;
                }
            }

            if !wait_for_foreground_idle(cycle_started, budget) {
                return Ok(stats);
            }

            match embedder.embed(&text, EmbedPrefix::Passage) {
                Ok(vector) => {
                    upsert.execute(params![
                        source.as_str(),
                        &row.id,
                        &hash,
                        embed::vector_to_blob(&vector),
                        E5_MODEL_TAG,
                        now_millis(),
                    ])?;
                    stats.indexed += 1;
                }
                // Ошибка одной строки (слишком длинный/битый текст) не валит цикл.
                Err(_) => stats.failed += 1,
            }

            // Пауза только после реального эмбеддинга — skipped-скан не спит
            // (полный проход по 100k сообщений занимает секунды, не часы).
            sleep_ms(options.pause_between_items_ms);
        }

        if page_len < options.page_size {
            break;
        }
        sleep_ms(options.pause_between_pages_ms);
    }

    if !wait_for_foreground_idle(cycle_started, budget) {
        return Ok(stats);
    }
    cleanup_orphans(connection, source)?;
    Ok(stats)
}

/// Одна страница строк источника (keyset-пагинация по PK, ASC).
///
/// Тексты собираются из тех же полей, что ищут chatSearch.ts / search.ts.
fn fetch_page(
    connection: &Connection,
    source: SemanticSource,
    after_id: &str,
    limit: usize,
) -> Result<Vec<SourceRow>> {
    let limit = limit as i64;
    match source {
        SemanticSource::Memory => {
            // title + content — search.ts матчит и content, и title (LIKE boost).
            let mut statement = connection.prepare_cached(
                "SELECT id, title, content FROM memory_items WHERE id > ? ORDER BY id ASC LIMIT ?",
            )?;
            let rows = statement.query_map(params![after_id, limit], |row| {
                let id: String = row.get(0)?;
                let title: Option<String> = row.get(1)?;
                let content: String = row.get(2)?;
                let text = format!("{}. {}", title.unwrap_or_default(), content);
                Ok(SourceRow { id, text: text.trim().to_owned() })
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        }
        SemanticSource::Messages => {
            // user/assistant — как FTS-триггеры messages_fts_ai индексируют роли;
            // system-сообщения (разделители компакции) семантически бесполезны.
            let mut statement = connection.prepare_cached(
                "SELECT id, content FROM messages
                 WHERE id > ? AND role IN ('user','assistant')
                 ORDER BY id ASC LIMIT ?",
            )?;
            let rows = statement.query_map(params![after_id, limit], |row| {
                Ok(SourceRow { id: row.get(0)?, text: row.get(1)? })
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        }
        SemanticSource::Summaries => {
            let mut statement = connection.prepare_cached(
                "SELECT chat_id, content FROM chat_summaries WHERE chat_id > ? ORDER BY chat_id ASC LIMIT ?",
            )?;
            let rows = statement.query_map(params![after_id, limit], |row| {
                Ok(SourceRow { id: row.get(0)?, text: row.get(1)? })
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        }
        SemanticSource::AgentLogs => {
            // Включаем ограниченный фрагмент args: lexical-поиск тоже смотрит в
            // args, и технические идентификаторы (пути, параметры тулов) живут там.
            let mut statement = connection.prepare_cached(
                "SELECT id, tool, args, result, error FROM agent_logs
                 WHERE id > ? ORDER BY id ASC LIMIT ?",
            )?;
            let rows = statement.query_map(params![after_id, limit], |row| {
                let id: String = row.get(0)?;
                let tool: Option<String> = row.get(1)?;
                let args: Option<String> = row.get(2)?;
                let result: Option<String> = row.get(3)?;
                let error: Option<String> = row.get(4)?;
                let mut parts: Vec<String> = Vec::new();
                if let Some(tool) = tool {
                    parts.push(format!("[{tool}]"));
                }
                if let Some(args) = args {
                    parts.push(format!("ARGS: {}", truncate_chars(&args, 700)));
                }
                match error {
                    Some(error) => parts.push(format!("ERROR: {error}")),
                    None => {
                        if let Some(result) = result {
                            parts.push(result);
                        }
                    }
                }
                Ok(SourceRow { id, text: parts.join(" ") })
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        }
        SemanticSource::Pinned => {
            let mut statement = connection.prepare_cached(
                "SELECT pm.message_id, m.content
                 FROM pinned_messages pm
                 JOIN messages m ON m.id = pm.message_id
                 WHERE pm.message_id > ? ORDER BY pm.message_id ASC LIMIT ?",
            )?;
            let rows = statement.query_map(params![after_id, limit], |row| {
                Ok(SourceRow { id: row.get(0)?, text: row.get(1)? })
            })?;
            Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
        }
    }
}

/// Удаляет эмбеддинги строк, которых больше нет в источнике (prune/rewind).
fn cleanup_orphans(connection: &Connection, source: SemanticSource) -> Result<usize> {
    let sql = format!(
        "DELETE FROM semantic_embeddings WHERE source = ? AND source_id NOT IN {}",
        source.pk_subquery()
    );
    let removed = connection.execute(&sql, params![source.as_str()])?;
    Ok(removed)
}

/// Ждёт, пока main не сообщит «пользователь работает».
///
/// Возвращает false, если бюджет цикла кончился прямо во время ожидания —
/// тогда индексатор выходит и продолжится следующим вызовом, а не держит
/// запрос открытым, пока пользователь печатает.
fn wait_for_foreground_idle(cycle_started: Instant, budget: Duration) -> bool {
    let mut quiet_until = Instant::now();
    loop {
        if cycle_started.elapsed() >= budget {
            return false;
        }
        if FOREGROUND_BUSY.load(std::sync::atomic::Ordering::Relaxed) {
            quiet_until = Instant::now() + Duration::from_millis(FOREGROUND_QUIET_MS);
            sleep_ms(FOREGROUND_POLL_MS);
            continue;
        }
        let now = Instant::now();
        if now >= quiet_until {
            return true;
        }
        sleep_ms(FOREGROUND_POLL_MS);
    }
}

fn sleep_ms(ms: u64) {
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Усечение по символам (не по байтам — иначе рвётся UTF-8).
fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_is_stable() {
        assert_eq!(
            sha256_hex("hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        let text = "привет мир";
        assert_eq!(truncate_chars(text, 6), "привет");
        assert_eq!(truncate_chars(text, 100), text);
    }

    #[test]
    fn page_query_orders_by_pk() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE memory_items (id TEXT, title TEXT, content TEXT);
                 INSERT INTO memory_items VALUES ('b','B','second'), ('a','A','first');",
            )
            .expect("fixture");
        let rows = fetch_page(&connection, SemanticSource::Memory, "", 10).expect("page");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "a");
        assert_eq!(rows[0].text, "A. first");
    }

    #[test]
    fn orphan_cleanup_removes_missing_rows() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch(
                "CREATE TABLE memory_items (id TEXT);
                 INSERT INTO memory_items VALUES ('a');
                 CREATE TABLE semantic_embeddings
                   (source TEXT, source_id TEXT, content_hash TEXT, embedding BLOB,
                    model TEXT, updated_at INTEGER);
                 INSERT INTO semantic_embeddings VALUES
                   ('memory','a','h',x'00','m',0), ('memory','gone','h',x'00','m',0);",
            )
            .expect("fixture");
        let removed = cleanup_orphans(&connection, SemanticSource::Memory).expect("cleanup");
        assert_eq!(removed, 1);
    }
}
