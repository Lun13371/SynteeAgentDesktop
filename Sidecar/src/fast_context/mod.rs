//! Fast Context — индексация файлов проекта и поиск по коду.
//!
//! Подсистема отвечает за:
//!   - обход проекта (walker) и слежение за изменениями (watcher);
//!   - разбор символов через tree-sitter (ast) и lexical fallback (symbols);
//!   - хранение индекса и FTS5-поиск (db, search);
//!   - языковые определения (language) и русско-английские синонимы (synonyms).

pub mod ast;
pub mod db;
pub mod indexer;
pub mod language;
pub mod search;
pub mod symbols;
pub mod synonyms;
pub mod walker;
pub mod watcher;
