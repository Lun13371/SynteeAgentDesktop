//! Разбор символов исходного кода для команды `symbols` (outline в read_file).
//!
//!   - `ast`      — tree-sitter с нативными грамматиками;
//!   - `lexical`  — lexical fallback для форматов без Rust-грамматики;
//!   - `language` — определение языка по пути файла.

pub mod ast;
pub mod language;
pub mod lexical;

pub use lexical::{extract_symbols, FileSymbols, SymbolDef};