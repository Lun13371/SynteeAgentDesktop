//! Доступ к `syntee.db` для semantic-подсистемы.
//!
//! ВАЖНО про многопроцессность: эту же БД держит main-процесс Electron. WAL
//! позволяет писать из двух процессов, но только при коротких транзакциях и
//! `busy_timeout` — иначе SQLITE_BUSY прилетает вместо ожидания. Индексатор
//! пишет строго построчно (по одному upsert), длинных транзакций здесь нет.

use std::path::Path;
use std::time::Duration;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value};

use crate::common::error::Result;

/// Сколько ждать чужую блокировку БД, прежде чем вернуть ошибку.
const BUSY_TIMEOUT_MS: u64 = 10_000;

/// Открывает `syntee.db` для чтения и записи.
pub fn open(db_path: &Path) -> Result<Connection> {
    if !db_path.is_file() {
        return Err(crate::common::error::SidecarError::InvalidRequest(format!(
            "database not found: {}",
            db_path.display()
        )));
    }
    let connection = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))?;
    // journal_mode уже WAL у приложения; выставляем идемпотентно, чтобы
    // sidecar не зависел от того, кто открыл файл первым.
    let _: String = connection
        .query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))
        .unwrap_or_default();
    connection.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(connection)
}

/// Строка SQLite → JSON-объект по именам колонок.
///
/// Нужен для `memory_items`: TS строит MemoryItem через `rowToItem`, и чтобы не
/// дублировать эту типизацию в Rust, строка уходит как есть.
pub fn row_to_json(row: &rusqlite::Row<'_>) -> Result<Value> {
    let names = row.as_ref().column_names();
    let mut map = Map::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let value = match row.get_ref(index)? {
            ValueRef::Null => Value::Null,
            ValueRef::Integer(number) => Value::from(number),
            ValueRef::Real(number) => Value::from(number),
            ValueRef::Text(bytes) => {
                Value::from(String::from_utf8_lossy(bytes).into_owned())
            }
            // BLOB (например, старый TF-IDF `mi.embedding`) в JSON не тащим.
            ValueRef::Blob(_) => Value::Null,
        };
        map.insert((*name).to_owned(), value);
    }
    Ok(Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_to_json_maps_columns() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch("CREATE TABLE t (id TEXT, n INTEGER, r REAL, b BLOB);")
            .expect("schema");
        connection
            .execute("INSERT INTO t VALUES ('a', 7, 1.5, x'0102')", [])
            .expect("insert");
        let value: Value = connection
            .query_row("SELECT id, n, r, b FROM t", [], |row| {
                row_to_json(row).map_err(|error| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
                })
            })
            .expect("row");
        assert_eq!(value["id"], Value::from("a"));
        assert_eq!(value["n"], Value::from(7));
        assert_eq!(value["r"], Value::from(1.5));
        assert_eq!(value["b"], Value::Null);
    }
}
