//! Syntee sidecar — CPU-тяжёлые подсистемы приложения в отдельном процессе.
//!
//! Раскладка:
//!   - `common`       — конфиг, ошибки, хэши, протокольный рантайм;
//!   - `text`         — нормализация и токенизация;
//!   - `fast_context` — индекс файлов проекта (tree-sitter + FTS5);
//!   - `semantic`     — E5-эмбеддинги памяти: индексация и cosine-поиск;
//!   - `commands`     — диспетчер методов протокола;
//!   - `protocol`     — формат запроса/ответа.

pub mod commands;
pub mod common;
pub mod fast_context;
pub mod protocol;
pub mod semantic;
pub mod text;
