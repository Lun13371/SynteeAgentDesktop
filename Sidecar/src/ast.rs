//! Native tree-sitter symbol extraction.
//!
//! The TypeScript side used `web-tree-sitter` with WASM grammars, loaded through
//! a hand-rolled Emscripten bootstrap that needed its own `.wasm` directory and
//! an `initFastContextWasmDir()` call in every thread. The same grammars
//! compiled into the sidecar remove that whole loading path: parsing happens in
//! a process that is already dedicated to CPU-heavy work, and the caller just
//! gets symbols back over the JSONL protocol.
//!
//! Scope: languages with a maintained Rust grammar crate. Everything else
//! (markdown, yaml, toml, …) keeps the lexical scanner in `symbols.rs`, so the
//! module reports `None` instead of pretending to understand the file.

use std::collections::HashSet;

use tree_sitter::{Language, Node, Parser};

use crate::symbols::{FileSymbols, SymbolDef};

/// Node kinds that represent a definition. Mirrors the list the TypeScript
/// extractor used, so outlines keep the same vocabulary across languages.
const DEFINITION_NODE_TYPES: &[&str] = &[
    // functions / methods
    "function_declaration",
    "function_definition",
    "function_item",
    "method_definition",
    "method_declaration",
    "function_declarator",
    "arrow_function",
    "function_expression",
    // classes / structs / interfaces / traits
    "class_declaration",
    "class_definition",
    "class_specifier",
    "interface_declaration",
    "trait_item",
    "impl_item",
    "impl_block",
    "struct_declaration",
    "struct_specifier",
    "struct_item",
    "enum_declaration",
    "enum_specifier",
    "enum_item",
    "union_specifier",
    "union_declaration",
    "type_declaration",
    "type_alias_declaration",
    "type_definition",
    "type_specifier",
    // module / namespace / package
    "module_declaration",
    "module_definition",
    "namespace_declaration",
    "package_declaration",
    "package_clause",
    // variables (top-level / exports)
    "variable_declaration",
    "lexical_declaration",
    "const_declaration",
    "const_item",
    "static_variable_declaration",
    // misc
    "constructor_declaration",
    "destructor_declaration",
    "attribute_item",
    "macro_definition",
    "macro_rules",
];

/// Containers whose members are extracted with a `parentName`.
const CONTAINER_NODE_TYPES: &[&str] = &[
    "class_declaration",
    "class_definition",
    "class_specifier",
    "interface_declaration",
    "trait_item",
    "impl_item",
    "impl_block",
    "struct_declaration",
    "struct_specifier",
    "struct_item",
    "enum_declaration",
    "enum_specifier",
    "enum_item",
    "union_specifier",
    "union_declaration",
    "module_declaration",
    "module_definition",
    "namespace_declaration",
    "package_declaration",
    "package_clause",
];

const IMPORT_NODE_TYPES: &[&str] = &[
    "import_statement",
    "import_declaration",
    "import_from_statement",
    "import_specifier",
    "import_clause",
    "use_declaration",
    "use_statement",
    "package_clause",
    "extern_crate_declaration",
    "mod_item",
    "include_directive",
    "preproc_include",
    "require_statement",
    "require_expression",
    "from_import_statement",
];

/// Cap on visited AST nodes. Large generated/minified files would otherwise
/// spend seconds walking a tree nobody reads.
const MAX_NODES: usize = 20_000;
/// Cap on extracted definitions — matches the lexical extractor.
const MAX_DEFINITIONS: usize = 300;
/// Cap on collected references.
const MAX_REFERENCES: usize = 200;
/// Minimum identifier length for a call-site reference.
const MIN_REFERENCE_LEN: usize = 4;

/// Names that appear everywhere as locals and would only add noise to the graph.
const COMMON_LOCAL_NAMES: &[&str] = &[
    "result",
    "error",
    "data",
    "value",
    "values",
    "item",
    "items",
    "index",
    "count",
    "length",
    "size",
    "name",
    "type",
    "types",
    "path",
    "paths",
    "file",
    "files",
    "self",
    "this",
    "that",
    "args",
    "opts",
    "options",
    "config",
    "state",
    "props",
    "event",
    "target",
    "source",
    "callback",
    "resolve",
    "reject",
    "promise",
    "response",
    "request",
    "context",
    "next",
    "prev",
    "start",
    "end",
    "text",
    "content",
    "body",
    "head",
    "tail",
    "first",
    "last",
    "curr",
    "current",
    "entry",
    "exit",
    "status",
    "code",
    "message",
    "reason",
    "object",
    "array",
    "string",
    "number",
    "boolean",
    "function",
    "console",
    "window",
    "document",
    "global",
    "process",
    "module",
    "exports",
    "require",
    "import",
    "default",
    "class",
    "return",
    "const",
    "let",
    "null",
    "true",
    "false",
    "undefined",
    "then",
    "catch",
    "finally",
    "throw",
    "async",
    "await",
    "yield",
    "push",
    "pop",
    "slice",
    "splice",
    "split",
    "join",
    "filter",
    "reduce",
    "forEach",
    "some",
    "every",
    "find",
    "keys",
    "entries",
    "assign",
    "create",
    "freeze",
    "from",
    "isArray",
    "parse",
    "stringify",
    "info",
    "debug",
    "trace",
];

/// Resolve a fast-context language id to a native grammar.
///
/// `None` means "no native grammar" — the caller falls back to the lexical
/// scanner rather than failing the request.
fn language(name: &str) -> Option<Language> {
    Some(match name {
        "javascript" => tree_sitter_javascript::LANGUAGE.into(),
        "typescript" => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        "tsx" => tree_sitter_typescript::LANGUAGE_TSX.into(),
        "python" => tree_sitter_python::LANGUAGE.into(),
        "rust" => tree_sitter_rust::LANGUAGE.into(),
        "go" => tree_sitter_go::LANGUAGE.into(),
        "c" => tree_sitter_c::LANGUAGE.into(),
        "cpp" => tree_sitter_cpp::LANGUAGE.into(),
        "java" => tree_sitter_java::LANGUAGE.into(),
        "c_sharp" => tree_sitter_c_sharp::LANGUAGE.into(),
        "ruby" => tree_sitter_ruby::LANGUAGE.into(),
        "php" => tree_sitter_php::LANGUAGE_PHP.into(),
        "bash" => tree_sitter_bash::LANGUAGE.into(),
        "json" => tree_sitter_json::LANGUAGE.into(),
        _ => return None,
    })
}

/// True when the language has a native grammar (used by `capabilities`).
pub fn supports(language_name: &str) -> bool {
    language(language_name).is_some()
}

/// Parse `source` and extract definitions/imports/references.
///
/// Returns `None` when the language has no native grammar or the parser cannot
/// be created; an empty `FileSymbols` is a valid "parsed, found nothing".
pub fn extract(source: &str, language_name: &str, skip_references: bool) -> Option<FileSymbols> {
    let grammar = language(language_name)?;
    let mut parser = Parser::new();
    parser.set_language(&grammar).ok()?;
    let tree = parser.parse(source, None)?;
    let mut symbols = walk(&tree, source);
    if !skip_references {
        symbols.references = collect_references(source, &symbols.definitions);
    }
    symbols.imports.truncate(100);
    Some(symbols)
}

fn walk<'tree>(tree: &'tree tree_sitter::Tree, source: &str) -> FileSymbols {
    let mut definitions: Vec<SymbolDef> = Vec::new();
    let mut imports: Vec<String> = Vec::new();
    // (node, parent container name) — explicit stack, no recursion, so a deeply
    // nested file cannot blow the sidecar's stack.
    let mut stack: Vec<(Node<'tree>, Option<String>)> = vec![(tree.root_node(), None)];
    let mut visited = 0usize;

    while let Some((node, parent)) = stack.pop() {
        if visited >= MAX_NODES || definitions.len() >= MAX_DEFINITIONS {
            break;
        }
        visited += 1;
        let kind = node.kind();

        if DEFINITION_NODE_TYPES.contains(&kind) {
            if let Some(name) = node_name(node, source) {
                definitions.push(SymbolDef {
                    name: name.clone(),
                    kind: kind_category(kind).to_owned(),
                    line_start: node.start_position().row + 1,
                    line_end: node.end_position().row + 1,
                    signature: signature(node, source),
                    parent_name: parent.clone(),
                });
                if CONTAINER_NODE_TYPES.contains(&kind) {
                    push_children(&mut stack, node, Some(name));
                }
                continue;
            }
        }

        if IMPORT_NODE_TYPES.contains(&kind) {
            if let Some(text) = node_text(node, source) {
                let first = text.lines().next().unwrap_or("").trim();
                if !first.is_empty() {
                    imports.push(first.chars().take(120).collect());
                }
            }
            continue;
        }

        push_children(&mut stack, node, parent);
    }

    FileSymbols { definitions, imports, references: Vec::new() }
}

fn push_children<'tree>(
    stack: &mut Vec<(Node<'tree>, Option<String>)>,
    node: Node<'tree>,
    parent: Option<String>,
) {
    // Reverse order so the stack yields children left-to-right.
    for index in (0..node.child_count()).rev() {
        if let Some(child) = node.child(index) {
            stack.push((child, parent.clone()));
        }
    }
}

fn node_text<'a>(node: Node<'_>, source: &'a str) -> Option<&'a str> {
    node.utf8_text(source.as_bytes()).ok()
}

/// Definition name: named field first (the reliable path in every grammar),
/// then the first identifier-ish child.
fn node_name(node: Node<'_>, source: &str) -> Option<String> {
    for field in ["name", "declarator", "type", "key"] {
        if let Some(child) = node.child_by_field_name(field) {
            if let Some(text) = node_text(child, source) {
                let trimmed = text.trim();
                if !trimmed.is_empty() && !trimmed.contains('\n') {
                    return Some(trimmed.chars().take(120).collect());
                }
            }
        }
    }
    for index in 0..node.child_count() {
        let child = node.child(index)?;
        if matches!(
            child.kind(),
            "identifier"
                | "type_identifier"
                | "property_identifier"
                | "field_identifier"
                | "constant"
                | "constructor"
        ) {
            if let Some(text) = node_text(child, source) {
                return Some(text.trim().chars().take(120).collect());
            }
        }
    }
    None
}

fn signature(node: Node<'_>, source: &str) -> String {
    node_text(node, source)
        .and_then(|text| text.lines().next())
        .map(|line| line.trim().chars().take(100).collect())
        .unwrap_or_default()
}

fn kind_category(kind: &str) -> &'static str {
    if kind.contains("function") || kind.contains("method") {
        "function"
    } else if kind.contains("class") {
        "class"
    } else if kind.contains("interface") {
        "interface"
    } else if kind.contains("struct") {
        "struct"
    } else if kind.contains("enum") {
        "enum"
    } else if kind.contains("trait") || kind.contains("impl") {
        "impl"
    } else if kind.contains("type") {
        "type"
    } else if kind.contains("module") || kind.contains("namespace") || kind.contains("package") {
        "module"
    } else if kind.contains("const") || kind.contains("variable") || kind.contains("static") {
        "variable"
    } else if kind.contains("constructor") {
        "constructor"
    } else if kind.contains("macro") {
        "macro"
    } else {
        "definition"
    }
}

/// Identifiers used in the file that are not defined here — the signal graph
/// ranking uses to link a file to the files it calls into.
///
/// A source scan rather than an AST walk: it is one pass, it never misses a
/// usage inside a macro or string template, and the consumer only needs names.
fn collect_references(source: &str, definitions: &[SymbolDef]) -> Vec<String> {
    let local: HashSet<&str> = definitions.iter().map(|item| item.name.as_str()).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut references: Vec<String> = Vec::new();
    let bytes = source.as_bytes();
    let mut index = 0usize;

    while index < bytes.len() {
        let byte = bytes[index];
        if byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$' {
            let start = index;
            index += 1;
            while index < bytes.len() {
                let next = bytes[index];
                if next.is_ascii_alphanumeric() || next == b'_' || next == b'$' {
                    index += 1;
                } else {
                    break;
                }
            }
            let len = index - start;
            if len >= MIN_REFERENCE_LEN {
                // ASCII-only scan: non-ASCII identifiers are skipped, same as the
                // regex the TypeScript extractor used.
                if let Ok(word) = std::str::from_utf8(&bytes[start..index]) {
                    if !local.contains(word)
                        && !COMMON_LOCAL_NAMES.contains(&word)
                        && seen.insert(word.to_owned())
                    {
                        references.push(word.to_owned());
                        if references.len() >= MAX_REFERENCES {
                            break;
                        }
                    }
                }
            }
        } else {
            index += 1;
        }
    }
    references
}

#[cfg(test)]
mod tests {
    use super::{extract, supports};

    #[test]
    fn typescript_definitions_carry_parent_names() {
        let source = "import { readFile } from 'fs'\n\nexport class Store {\n  async load(id: string) {}\n}\n\nexport function helper() {}\n";
        let symbols = extract(source, "typescript", true).expect("typescript grammar");
        assert!(symbols.definitions.iter().any(|d| d.name == "Store" && d.kind == "class"));
        assert!(symbols
            .definitions
            .iter()
            .any(|d| d.name == "load" && d.parent_name.as_deref() == Some("Store")));
        assert!(symbols.definitions.iter().any(|d| d.name == "helper" && d.kind == "function"));
        assert!(symbols.imports.iter().any(|line| line.contains("readFile")));
    }

    #[test]
    fn line_ranges_span_the_whole_definition() {
        let source = "fn outer() {\n    let a = 1;\n    let b = 2;\n}\n";
        let symbols = extract(source, "rust", true).expect("rust grammar");
        let outer = symbols.definitions.iter().find(|d| d.name == "outer").expect("outer");
        assert_eq!(outer.line_start, 1);
        assert_eq!(outer.line_end, 4);
    }

    #[test]
    fn references_exclude_local_definitions_and_common_names() {
        let source = "function alpha() {}\nalpha();\nbetaService.run(result);\n";
        let symbols = extract(source, "javascript", false).expect("javascript grammar");
        assert!(!symbols.references.iter().any(|r| r == "alpha"));
        assert!(symbols.references.iter().any(|r| r == "betaService"));
        assert!(!symbols.references.iter().any(|r| r == "result"));
    }

    #[test]
    fn unsupported_language_reports_none() {
        assert!(!supports("markdown"));
        assert!(extract("# Title", "markdown", true).is_none());
    }

    #[test]
    fn python_and_go_are_covered() {
        let python = extract("class Service:\n    def run(self):\n        pass\n", "python", true)
            .expect("python grammar");
        assert!(python.definitions.iter().any(|d| d.name == "Service"));
        assert!(python.definitions.iter().any(|d| d.name == "run"));

        let go = extract("package main\n\nfunc Run() {}\n", "go", true).expect("go grammar");
        assert!(go.definitions.iter().any(|d| d.name == "Run"));
    }
}
