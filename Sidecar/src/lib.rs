//! Syntee sidecar — CPU-тяжёлые подсистемы приложения в отдельном процессе.
//!
//! Раскладка:
//!   - `common`   — конфиг, ошибки, хэши, протокольный рантайм;
//!   - `text`     — токенизация;
//!   - `symbols`  — разбор символов кода (tree-sitter + lexical fallback);
//!   - `semantic` — E5-эмбеддинги памяти: индексация и cosine-поиск;
//!   - `commands` — диспетчер методов протокола;
//!   - `protocol` — формат запроса/ответа.

pub mod commands;
pub mod common;
pub mod protocol;
pub mod semantic;
pub mod symbols;
pub mod text;