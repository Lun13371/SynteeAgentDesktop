//! Native tree-sitter symbol extraction.
//!
//! Grammars are compiled into the sidecar: parsing happens in a process that
//! is already dedicated to CPU-heavy work, and the caller just gets symbols
//! back over the JSONL protocol.
//!
//! Scope: languages with a maintained Rust grammar crate. Everything else
//! (markdown, yaml, toml, …) keeps the lexical scanner in `lexical.rs`, so the
//! module reports `None` instead of pretending to understand the file.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use tree_sitter::{Language, Node, Parser};

use crate::symbols::{FileSymbols, SymbolDef};

/// Node kinds that represent a definition.
///
/// Two entries are deliberately absent: `arrow_function` and
/// `function_expression`. Their `name` field is the *first parameter*, so
/// `const load = async (id) => {}` used to be reported as a definition called
/// `id`. The `variable_declarator` that wraps them carries the real name.
const DEFINITION_NODE_TYPES: &[&str] = &[
    // functions / methods
    "function_declaration",
    "function_definition",
    "function_item",
    "method_definition",
    "method_declaration",
    "function_declarator",
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
    // variables and fields
    "variable_declaration",
    "lexical_declaration",
    "variable_declarator",
    "const_declaration",
    "const_item",
    "static_variable_declaration",
    "static_item",
    "let_declaration",
    "init_declarator",
    "field_declaration",
    "public_field_definition",
    "property_declaration",
    // go
    "type_spec",
    "const_spec",
    "var_spec",
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

thread_local! {
    /// One parser per language per thread. `Parser::new()` + `set_language` on
    /// every file is cheap per call but adds up over a full index pass.
    static PARSERS: RefCell<HashMap<String, Parser>> = RefCell::new(HashMap::new());
}

/// Parse `source` and extract definitions/imports/references.
///
/// Returns `None` when the language has no native grammar or the parser cannot
/// be created; an empty `FileSymbols` is a valid "parsed, found nothing".
pub fn extract(source: &str, language_name: &str, skip_references: bool) -> Option<FileSymbols> {
    let grammar = language(language_name)?;
    PARSERS.with(|cell| -> Option<FileSymbols> {
        let mut parsers = cell.borrow_mut();
        if !parsers.contains_key(language_name) {
            let mut parser = Parser::new();
            parser.set_language(&grammar).ok()?;
            parsers.insert(language_name.to_owned(), parser);
        }
        let parser = parsers.get_mut(language_name)?;
        let tree = parser.parse(source, None)?;
        let mut symbols = walk(&tree, source, skip_references);
        symbols.imports.truncate(100);
        Some(symbols)
    })
}

/// Where the walk currently is. It decides whether a variable declaration is a
/// definition worth reporting or just a local inside a function body.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Scope {
    Top,
    Container,
    Function,
}

fn walk(tree: &tree_sitter::Tree, source: &str, skip_references: bool) -> FileSymbols {
    let mut definitions: Vec<SymbolDef> = Vec::new();
    let mut imports: Vec<String> = Vec::new();
    let mut references: Vec<String> = Vec::new();
    let mut seen_references: HashSet<String> = HashSet::new();
    // (node, parent container name, scope) — explicit stack, no recursion, so a
    // deeply nested file cannot blow the sidecar's stack.
    let mut stack: Vec<(Node<'_>, Option<String>, Scope)> =
        vec![(tree.root_node(), None, Scope::Top)];
    let mut visited = 0usize;
    let mut truncated = false;

    while let Some((node, parent, scope)) = stack.pop() {
        if visited >= MAX_NODES || definitions.len() >= MAX_DEFINITIONS {
            truncated = true;
            break;
        }
        visited += 1;
        let kind = node.kind();

        // Strings and comments are not code. Scanning raw text for identifiers
        // used to put words from comments and string literals into `references`,
        // which then became bogus graph edges.
        if is_non_code(kind) {
            continue;
        }

        if DEFINITION_NODE_TYPES.contains(&kind) {
            if let Some(name) = node_name(node, source) {
                let reportable = match kind {
                    // `const x = 1` inside a function body is a local, not a
                    // symbol the repo map should list.
                    "variable_declarator" | "let_declaration" | "init_declarator" => {
                        scope != Scope::Function
                    }
                    _ => true,
                };
                if reportable {
                    let is_container = CONTAINER_NODE_TYPES.contains(&kind);
                    definitions.push(SymbolDef {
                        name: name.clone(),
                        kind: kind_category(kind).to_owned(),
                        line_start: node.start_position().row + 1,
                        line_end: node.end_position().row + 1,
                        signature: signature(node, source),
                        parent_name: parent.clone(),
                    });
                    let child_scope = if is_container { Scope::Container } else { Scope::Function };
                    push_children(&mut stack, node, Some(name), child_scope);
                    continue;
                }
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

        if !skip_references && is_identifier_kind(kind) && references.len() < MAX_REFERENCES * 2 {
            if let Some(text) = node_text(node, source) {
                let name = text.trim();
                if name.chars().count() >= MIN_REFERENCE_LEN
                    && !COMMON_LOCAL_NAMES.contains(&name)
                    && seen_references.insert(name.to_owned())
                {
                    references.push(name.to_owned());
                }
            }
        }

        push_children(&mut stack, node, parent, scope);
    }

    // A definition is not a reference to itself.
    let local: HashSet<&str> = definitions.iter().map(|item| item.name.as_str()).collect();
    references.retain(|reference| !local.contains(reference.as_str()));
    references.truncate(MAX_REFERENCES);

    FileSymbols { definitions, imports, references, truncated }
}

fn push_children<'tree>(
    stack: &mut Vec<(Node<'tree>, Option<String>, Scope)>,
    node: Node<'tree>,
    parent: Option<String>,
    scope: Scope,
) {
    // Reverse order so the stack yields children left-to-right.
    for index in (0..node.child_count()).rev() {
        if let Some(child) = node.child(index) {
            stack.push((child, parent.clone(), scope));
        }
    }
}

fn node_text<'a>(node: Node<'_>, source: &'a str) -> Option<&'a str> {
    node.utf8_text(source.as_bytes()).ok()
}

fn is_non_code(kind: &str) -> bool {
    matches!(
        kind,
        "comment"
            | "line_comment"
            | "block_comment"
            | "documentation_comment"
            | "string"
            | "string_literal"
            | "raw_string_literal"
            | "interpreted_string_literal"
            | "template_string"
            | "char_literal"
            | "heredoc_body"
            | "regex"
            | "regex_pattern"
    )
}

fn is_identifier_kind(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "property_identifier"
            | "type_identifier"
            | "field_identifier"
            | "shorthand_property_identifier"
            | "namespace_identifier"
            | "constant"
    )
}

/// Definition name: the reliable `name` field first, then a declarator chain,
/// then any identifier child.
fn node_name(node: Node<'_>, source: &str) -> Option<String> {
    for field in ["name", "declarator", "key"] {
        if let Some(child) = node.child_by_field_name(field) {
            if let Some(name) = declarator_name(child, source) {
                return Some(name);
            }
        }
    }
    for index in 0..node.child_count() {
        let Some(child) = node.child(index) else { break };
        if is_identifier_kind(child.kind()) {
            if let Some(name) = declarator_name(child, source) {
                return Some(name);
            }
        }
    }
    None
}

/// Resolve a declarator down to a bare identifier.
///
/// `void use() {}` in C++ exposes a `function_declarator` whose text is `use()`;
/// taking that text verbatim made the definition name `use()`.
fn declarator_name(node: Node<'_>, source: &str) -> Option<String> {
    if is_identifier_kind(node.kind())
        || matches!(node.kind(), "constructor" | "destructor_name" | "operator_name")
    {
        return node_text(node, source).map(|text| text.trim().chars().take(120).collect());
    }
    if node.kind() == "qualified_identifier" {
        if let Some(child) = node.child_by_field_name("name") {
            return declarator_name(child, source);
        }
    }
    if let Some(child) = node.child_by_field_name("declarator") {
        return declarator_name(child, source);
    }
    if let Some(child) = node.child_by_field_name("name") {
        return declarator_name(child, source);
    }
    for index in 0..node.child_count() {
        let Some(child) = node.child(index) else { break };
        if matches!(
            child.kind(),
            "parameter_list"
                | "template_argument_list"
                | "template_parameter_list"
                | "type_parameters"
        ) {
            continue;
        }
        if let Some(name) = declarator_name(child, source) {
            return Some(name);
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
    } else if kind.contains("field") || kind.contains("property") || kind.contains("declarator") {
        "field"
    } else {
        "definition"
    }
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
