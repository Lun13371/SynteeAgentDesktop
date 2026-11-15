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

use crate::symbols::{CallSite, FileSymbols, ImportDetail, SymbolDef};

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
    "using_directive",
    "namespace_use_declaration",
];

/// Cap on visited AST nodes. Large generated/minified files would otherwise
/// spend seconds walking a tree nobody reads.
const MAX_NODES: usize = 20_000;
/// Cap on extracted definitions — matches the lexical extractor.
const MAX_DEFINITIONS: usize = 300;
/// Cap on collected references.
const MAX_REFERENCES: usize = 200;
/// Cap on positioned call sites (project-map call edges).
const MAX_CALL_SITES: usize = 500;
/// Cap on structured imports.
const MAX_IMPORT_DETAILS: usize = 100;
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
        let mut symbols = walk(&tree, source, language_name, skip_references);
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

fn walk(tree: &tree_sitter::Tree, source: &str, language_name: &str, skip_references: bool) -> FileSymbols {
    let mut definitions: Vec<SymbolDef> = Vec::new();
    let mut imports: Vec<String> = Vec::new();
    let mut references: Vec<String> = Vec::new();
    let mut import_details: Vec<ImportDetail> = Vec::new();
    let mut call_sites: Vec<CallSite> = Vec::new();
    let mut seen_call_sites: HashSet<(String, usize, Option<String>)> = HashSet::new();
    let mut seen_references: HashSet<String> = HashSet::new();
    // Строки файла один раз: capture_doc ходит вверх от каждого определения.
    let lines: Vec<&str> = source.lines().collect();
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
                        doc: capture_doc(node, source, language_name, &lines),
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
            if import_details.len() < MAX_IMPORT_DETAILS {
                for detail in import_details_from_node(node, source) {
                    if import_details.len() >= MAX_IMPORT_DETAILS {
                        break;
                    }
                    import_details.push(detail);
                }
            }
            continue;
        }

        // Positioned call sites for the project map. Collected under the same
        // gate as references: outline-only callers pass skip_references=true
        // and should not pay for call extraction.
        if !skip_references && call_sites.len() < MAX_CALL_SITES && is_call_kind(kind) {
            if let Some(site) = call_site(node, source, parent.clone()) {
                let key = (site.name.clone(), site.line, site.parent_name.clone());
                if seen_call_sites.insert(key) {
                    call_sites.push(site);
                }
            }
        }

        // Bash `source ./lib.sh` / `. ./lib.sh` is an import, not a call.
        if !skip_references && kind == "command" && import_details.len() < MAX_IMPORT_DETAILS {
            if let Some(detail) = bash_source_import(node, source) {
                import_details.push(detail);
            }
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

    FileSymbols { definitions, imports, references, import_details, call_sites, truncated }
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

// ─── Call sites (project-map call edges) ─────────────────────────────────────

fn is_call_kind(kind: &str) -> bool {
    matches!(
        kind,
        "call_expression"
            | "call"
            | "new_expression"
            | "method_invocation"
            | "invocation_expression"
            | "function_call_expression"
            | "member_call_expression"
            | "macro_invocation"
            | "command"
    )
}

fn call_site(node: Node<'_>, source: &str, parent: Option<String>) -> Option<CallSite> {
    let callee = ["function", "constructor", "method", "macro", "name"]
        .iter()
        .find_map(|field| node.child_by_field_name(field))?;
    let (name, mut receiver) = callee_name(callee, source)?;
    if receiver.is_none() {
        // Java/C#/PHP/Ruby keep the object in a separate field.
        receiver = ["object", "receiver", "value"]
            .iter()
            .find_map(|field| node.child_by_field_name(field))
            .and_then(|n| node_text(n, source))
            .map(|t| t.trim().to_owned())
            .filter(|t| is_name_like(t));
    }
    Some(CallSite {
        name,
        line: node.start_position().row + 1,
        parent_name: parent,
        receiver,
    })
}

/// Callee text → (last segment, first segment). `store.load` → ("load",
/// Some("store")); `fmt::Println` → ("Println", Some("fmt")). Text-based so it
/// works across grammars with different member-node shapes.
fn callee_name(node: Node<'_>, source: &str) -> Option<(String, Option<String>)> {
    let text = node_text(node, source)?.trim();
    if text.is_empty() || text.len() > 200 {
        return None;
    }
    let base = text.split('(').next()?.trim();
    if base.contains('/') || base.contains('\\') {
        return None; // a path, not a name
    }
    let normalized = base.replace("::", ".").replace("->", ".");
    let mut parts = normalized.split('.').map(str::trim).filter(|p| !p.is_empty());
    let name = parts.next_back()?.to_owned();
    if !is_name_like(&name) {
        return None;
    }
    let receiver = parts.next().filter(|r| is_name_like(r)).map(str::to_owned);
    Some((name, receiver))
}

fn is_name_like(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 120
        && text.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

// ─── Structured imports ──────────────────────────────────────────────────────

fn import_details_from_node(node: Node<'_>, source: &str) -> Vec<ImportDetail> {
    let line = node.start_position().row + 1;
    let kind = node.kind();
    let Some(text) = node_text(node, source) else { return Vec::new() };
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }

    // Go import lists: one detail per spec.
    if kind == "import_declaration" {
        let specs = collect_nodes(node, "import_spec");
        if !specs.is_empty() {
            return specs
                .iter()
                .filter_map(|spec| {
                    let path = spec.child_by_field_name("path").and_then(|n| node_text(n, source))?;
                    let module = unquote(path);
                    if module.is_empty() {
                        return None;
                    }
                    let names = spec
                        .child_by_field_name("name")
                        .and_then(|n| node_text(n, source))
                        .map(|t| vec![t.trim().to_owned()])
                        .unwrap_or_default();
                    Some(ImportDetail { source: module, names, line })
                })
                .collect();
        }
    }

    // String-literal module source: JS/TS, C/C++ includes, require/include.
    if let Some(string_node) = find_string_descendant(node) {
        if let Some(raw) = node_text(string_node, source) {
            let module = unquote(raw);
            if !module.is_empty() {
                let names = collect_binding_identifiers(node, source);
                return vec![ImportDetail { source: module, names, line }];
            }
        }
    }

    // Path-based imports: Python, Rust, Java, C#, PHP use, mod/package.
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = strip_import_keywords(&collapsed);
    if cleaned.is_empty() {
        return Vec::new();
    }

    match kind {
        "import_from_statement" => {
            // from MODULE import NAME [, NAME…]
            if let Some(idx) = cleaned.find(" import ") {
                let module = cleaned[..idx].trim().to_owned();
                let names = cleaned[idx + " import ".len()..]
                    .split(',')
                    .flat_map(|n| {
                        n.trim()
                            .trim_matches(|c| c == '(' || c == ')')
                            .split(" as ")
                            .map(|part| part.trim().to_owned())
                            .collect::<Vec<_>>()
                    })
                    .filter(|n| !n.is_empty())
                    .collect();
                vec![ImportDetail { source: module, names, line }]
            } else {
                vec![ImportDetail { source: cleaned, names: Vec::new(), line }]
            }
        }
        "import_statement" => {
            // Python `import a.b, c` — one detail per module.
            cleaned
                .split(',')
                .map(|m| m.trim().split(" as ").next().unwrap_or("").trim().to_owned())
                .filter(|m| !m.is_empty())
                .map(|module| ImportDetail { source: module, names: Vec::new(), line })
                .collect()
        }
        "use_declaration" | "namespace_use_declaration" => {
            // Rust `use a::b::{C, D}` / PHP `use Foo\Bar;`
            let names = if let Some(open) = cleaned.find('{') {
                cleaned[open + 1..]
                    .trim_end_matches('}')
                    .split(',')
                    .map(|n| n.trim().split(" as ").next().unwrap_or("").trim().to_owned())
                    .filter(|n| !n.is_empty() && n != "*")
                    .collect()
            } else {
                last_path_segment(&cleaned).map(|n| vec![n]).unwrap_or_default()
            };
            vec![ImportDetail { source: cleaned, names, line }]
        }
        _ => {
            // Java `import a.b.C`, C# `using A.B`, `mod x`, `extern crate x`.
            let head = cleaned.split('{').next().unwrap_or("").trim().to_owned();
            let names = last_path_segment(&head).map(|n| vec![n]).unwrap_or_default();
            vec![ImportDetail { source: head, names, line }]
        }
    }
}

/// Bash `source ./lib.sh` / `. ./lib.sh`.
fn bash_source_import(node: Node<'_>, source: &str) -> Option<ImportDetail> {
    let name = node.child_by_field_name("name")?;
    let name_text = node_text(name, source)?.trim();
    if name_text != "source" && name_text != "." {
        return None;
    }
    let mut cursor = node.walk();
    let arg = node
        .children(&mut cursor)
        .find(|child| child.kind() != "command_name" && !child.is_extra())?;
    let module = unquote(node_text(arg, source)?);
    if module.is_empty() {
        return None;
    }
    Some(ImportDetail { source: module, names: Vec::new(), line: node.start_position().row + 1 })
}

fn find_string_descendant<'tree>(node: Node<'tree>) -> Option<Node<'tree>> {
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if matches!(
            current.kind(),
            "string"
                | "string_literal"
                | "interpreted_string_literal"
                | "raw_string_literal"
                | "system_lib_string"
                | "encapsed_string"
        ) {
            return Some(current);
        }
        for index in (0..current.child_count()).rev() {
            if let Some(child) = current.child(index) {
                stack.push(child);
            }
        }
    }
    None
}

fn collect_nodes<'tree>(node: Node<'tree>, kind: &str) -> Vec<Node<'tree>> {
    let mut found = Vec::new();
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if current.kind() == kind {
            found.push(current);
            continue;
        }
        for index in (0..current.child_count()).rev() {
            if let Some(child) = current.child(index) {
                stack.push(child);
            }
        }
    }
    found
}

fn collect_binding_identifiers(node: Node<'_>, source: &str) -> Vec<String> {
    const IMPORT_KEYWORDS: &[&str] = &[
        "import", "from", "as", "use", "type", "require", "include", "pub", "mod",
        "crate", "extern", "package", "namespace", "using", "default", "static",
    ];
    let mut names = Vec::new();
    let mut seen = HashSet::new();
    let mut stack = vec![node];
    while let Some(current) = stack.pop() {
        if is_identifier_kind(current.kind()) {
            if let Some(text) = node_text(current, source) {
                let name = text.trim();
                if !name.is_empty()
                    && !IMPORT_KEYWORDS.contains(&name)
                    && seen.insert(name.to_owned())
                {
                    names.push(name.to_owned());
                    if names.len() >= 50 {
                        break;
                    }
                }
            }
        }
        for index in (0..current.child_count()).rev() {
            if let Some(child) = current.child(index) {
                stack.push(child);
            }
        }
    }
    names
}

fn unquote(text: &str) -> String {
    let t = text.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'\'' && last == b'\'')
            || (first == b'"' && last == b'"')
            || (first == b'`' && last == b'`')
            || (first == b'<' && last == b'>')
        {
            return t[1..t.len() - 1].to_owned();
        }
    }
    t.to_owned()
}

fn strip_import_keywords(text: &str) -> String {
    const KEYWORDS: &[&str] = &[
        "import", "from", "use", "using", "require", "require_once", "include",
        "include_once", "extern", "crate", "mod", "package", "namespace", "pub", "static",
    ];
    let mut rest = text.trim().trim_end_matches(';').trim();
    loop {
        let before = rest;
        for keyword in KEYWORDS {
            if let Some(tail) = rest.strip_prefix(keyword) {
                if tail.starts_with(char::is_whitespace) {
                    rest = tail.trim_start();
                    break;
                }
            }
        }
        if rest == before {
            break;
        }
    }
    rest.to_owned()
}

fn last_path_segment(path: &str) -> Option<String> {
    let normalized = path.replace("::", ".").replace('\\', ".");
    normalized
        .rsplit('.')
        .next()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty() && s != "*")
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

// ─── Doc-контекст определения ────────────────────────────────────────────────

/// Cap of the captured doc text: it goes into a semantic-search document which
/// is short by design (MAX_DOC_CHARS on the caller side too).
const MAX_DOC_CHARS: usize = 240;

/// `@decorator` (py/ts/java/kotlin), `#[...]` (rust/php), `[Attr]` (C#).
fn is_decorator_line(line: &str) -> bool {
    line.starts_with('@')
        || line.starts_with("#[")
        || (line.starts_with('[') && line.ends_with(']') && line.len() > 2)
}

/// Текст строки-документации, если это она. None — строка не комментарий.
/// Обычные `//` тоже включаем: чаще всего это пояснение к коду под ними.
fn doc_comment_text(line: &str, language_name: &str) -> Option<String> {
    if line.starts_with("///") {
        return Some(line[3..].trim().to_string());
    }
    if line.starts_with("//") {
        return Some(line[2..].trim().to_string());
    }
    if line.starts_with("/*") || line.starts_with('*') {
        let t = line
            .trim_start_matches("/*")
            .trim_start_matches('*')
            .trim_end_matches("*/")
            .trim();
        return Some(t.to_string());
    }
    if line.starts_with('#') && !line.starts_with("#[") && crate::symbols::lexical::hash_starts_comment(language_name) {
        return Some(line.trim_start_matches('#').trim().to_string());
    }
    None
}

/// Docstring питон-функции/класса: первый string-statement в теле.
fn python_docstring(node: Node<'_>, source: &str) -> Option<String> {
    let body = node.child_by_field_name("body")?;
    let first = body.child(0)?;
    let stmt = if first.kind() == "expression_statement" { first.child(0)? } else { first };
    if stmt.kind() != "string" {
        return None;
    }
    let text = node_text(stmt, source)?.trim().to_string();
    let stripped = text
        .strip_prefix("\"\"\"")
        .or_else(|| text.strip_prefix("'''"))
        .unwrap_or(&text);
    let stripped = stripped
        .strip_suffix("\"\"\"")
        .or_else(|| stripped.strip_suffix("'''"))
        .unwrap_or(stripped);
    let joined = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.is_empty() {
        None
    } else {
        Some(joined.chars().take(MAX_DOC_CHARS).collect())
    }
}

/// Собрать doc-контекст: комментарии-документация и декораторы подряд над
/// определением (до пустой строки или кода) + docstring для Python.
/// Порядок — как в исходнике: комментарии, декораторы, docstring.
fn capture_doc(node: Node<'_>, source: &str, language_name: &str, lines: &[&str]) -> Option<String> {
    let mut decorators: Vec<String> = Vec::new();
    let mut comments: Vec<String> = Vec::new();
    let mut row = node.start_position().row;
    while row > 0 {
        row -= 1;
        let Some(raw) = lines.get(row) else { break };
        let line = raw.trim();
        if line.is_empty() {
            break;
        }
        if is_decorator_line(line) {
            decorators.push(line.to_owned());
            continue;
        }
        if let Some(text) = doc_comment_text(line, language_name) {
            if !text.is_empty() {
                comments.push(text);
            }
            continue;
        }
        break;
    }
    // Собрано снизу вверх — разворачиваем в порядок исходника.
    let mut parts: Vec<String> = Vec::new();
    parts.extend(comments.into_iter().rev());
    parts.extend(decorators.into_iter().rev());
    if language_name == "python" {
        if let Some(docstring) = python_docstring(node, source) {
            parts.push(docstring);
        }
    }
    let joined = parts.join(" ");
    let joined = joined.trim();
    if joined.is_empty() {
        None
    } else {
        Some(joined.chars().take(MAX_DOC_CHARS).collect())
    }
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

    #[test]
    fn call_sites_carry_position_parent_and_receiver() {
        let source = "import { load } from './store'\n\nfunction alpha() {\n  load(1)\n  betaService.run(2)\n}\n\nbetaService.stop()\n";
        let symbols = extract(source, "typescript", false).expect("typescript grammar");
        let load = symbols.call_sites.iter().find(|c| c.name == "load").expect("load call");
        assert_eq!(load.parent_name.as_deref(), Some("alpha"));
        assert_eq!(load.line, 4);
        assert!(load.receiver.is_none());
        let run = symbols.call_sites.iter().find(|c| c.name == "run").expect("run call");
        assert_eq!(run.parent_name.as_deref(), Some("alpha"));
        assert_eq!(run.receiver.as_deref(), Some("betaService"));
        let stop = symbols.call_sites.iter().find(|c| c.name == "stop").expect("stop call");
        assert!(stop.parent_name.is_none());
        assert_eq!(stop.receiver.as_deref(), Some("betaService"));
    }

    #[test]
    fn call_sites_inside_methods_and_arrow_functions() {
        let source = "class Store {\n  async load(id) {\n    helper(id)\n  }\n}\n\nconst run = async () => {\n  helper(2)\n}\n";
        let symbols = extract(source, "typescript", false).expect("typescript grammar");
        let calls: Vec<_> = symbols.call_sites.iter().filter(|c| c.name == "helper").collect();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().any(|c| c.parent_name.as_deref() == Some("load")));
        assert!(calls.iter().any(|c| c.parent_name.as_deref() == Some("run")));
    }

    #[test]
    fn call_sites_skipped_when_references_skipped() {
        let source = "function alpha() { beta() }\n";
        let symbols = extract(source, "typescript", true).expect("typescript grammar");
        assert!(symbols.call_sites.is_empty());
    }

    #[test]
    fn python_calls_and_imports() {
        let source = "from pkg.store import load, save as persist\nimport os.path\n\ndef alpha():\n    load(1)\n    os.path.join('a')\n";
        let symbols = extract(source, "python", false).expect("python grammar");
        let from = symbols.import_details.iter().find(|i| i.source == "pkg.store").expect("from import");
        assert!(from.names.contains(&"load".to_owned()));
        assert!(from.names.contains(&"persist".to_owned()));
        assert!(symbols.import_details.iter().any(|i| i.source == "os.path"));
        let load = symbols.call_sites.iter().find(|c| c.name == "load").expect("load call");
        assert_eq!(load.parent_name.as_deref(), Some("alpha"));
        let join = symbols.call_sites.iter().find(|c| c.name == "join").expect("join call");
        assert_eq!(join.receiver.as_deref(), Some("os"));
    }

    #[test]
    fn typescript_import_details() {
        let source = "import { readFile, writeFile as wf } from 'fs'\nimport path from 'path'\nimport * as utils from './utils'\nimport './side-effect'\n";
        let symbols = extract(source, "typescript", true).expect("typescript grammar");
        let fs = symbols.import_details.iter().find(|i| i.source == "fs").expect("fs import");
        assert!(fs.names.contains(&"readFile".to_owned()));
        assert!(fs.names.contains(&"wf".to_owned()));
        let path = symbols.import_details.iter().find(|i| i.source == "path").expect("path import");
        assert!(path.names.contains(&"path".to_owned()));
        let utils = symbols.import_details.iter().find(|i| i.source == "./utils").expect("utils import");
        assert!(utils.names.contains(&"utils".to_owned()));
        let side = symbols.import_details.iter().find(|i| i.source == "./side-effect").expect("side-effect import");
        assert!(side.names.is_empty());
    }

    #[test]
    fn rust_go_c_import_details() {
        let rust = extract("use std::collections::HashMap;\nuse crate::store::{Store, load};\nmod helpers;\n", "rust", true)
            .expect("rust grammar");
        let std = rust.import_details.iter().find(|i| i.source.contains("std::collections")).expect("std import");
        assert!(std.names.contains(&"HashMap".to_owned()));
        let crate_import = rust.import_details.iter().find(|i| i.source.contains("crate::store")).expect("crate import");
        assert!(crate_import.names.contains(&"Store".to_owned()));
        assert!(crate_import.names.contains(&"load".to_owned()));
        assert!(rust.import_details.iter().any(|i| i.source == "helpers"));

        let go = extract("package main\n\nimport (\n  \"fmt\"\n  f \"os\"\n)\n", "go", true).expect("go grammar");
        assert!(go.import_details.iter().any(|i| i.source == "fmt"));
        let os = go.import_details.iter().find(|i| i.source == "os").expect("os import");
        assert!(os.names.contains(&"f".to_owned()));

        let c = extract("#include <stdio.h>\n#include \"local.h\"\n", "c", true).expect("c grammar");
        assert!(c.import_details.iter().any(|i| i.source == "stdio.h"));
        assert!(c.import_details.iter().any(|i| i.source == "local.h"));
    }

    #[test]
    fn bash_source_is_an_import() {
        let symbols = extract("source ./lib.sh\n. ./other.sh\necho hi\n", "bash", false).expect("bash grammar");
        assert!(symbols.import_details.iter().any(|i| i.source == "./lib.sh"));
        assert!(symbols.import_details.iter().any(|i| i.source == "./other.sh"));
    }

    #[test]
    fn python_definition_carries_docstring_and_decorator() {
        let source = "# Логин пользователя\n@router.post(\"/login\")\nasync def login(req: LoginRequest):\n    \"\"\"Логин по email и паролю, выдача токенов.\"\"\"\n    return authorize(req)\n";
        let symbols = extract(source, "python", true).expect("python grammar");
        let login = symbols.definitions.iter().find(|d| d.name == "login").expect("login");
        let doc = login.doc.as_deref().expect("doc captured");
        assert!(doc.contains("@router.post"), "decorator in doc: {doc}");
        assert!(doc.contains("Логин по email"), "docstring in doc: {doc}");
        assert!(doc.contains("Логин пользователя"), "comment above in doc: {doc}");
    }

    #[test]
    fn python_definition_without_doc_has_none() {
        let source = "def alpha(x):\n    return x + 1\n";
        let symbols = extract(source, "python", true).expect("python grammar");
        let alpha = symbols.definitions.iter().find(|d| d.name == "alpha").expect("alpha");
        assert!(alpha.doc.is_none(), "нечего захватывать — doc пуст: {:?}", alpha.doc);
    }

    #[test]
    fn typescript_definition_carries_jsdoc() {
        let source = "/**\n * Does the thing well\n * @param id user id\n */\nexport function doThing(id: string) {}\n";
        let symbols = extract(source, "typescript", true).expect("ts grammar");
        let def = symbols.definitions.iter().find(|d| d.name == "doThing").expect("doThing");
        let doc = def.doc.as_deref().expect("doc captured");
        assert!(doc.contains("Does the thing well"), "JSDoc text in doc: {doc}");
    }

    #[test]
    fn csharp_definition_carries_xml_doc_and_attribute() {
        let source = "public class AuthController {\n  /// <summary>Логин по email</summary>\n  [HttpPost(\"/login\")]\n  public IActionResult Login(LoginRequest req) { return Ok(); }\n}\n";
        let symbols = extract(source, "c_sharp", true).expect("csharp grammar");
        let def = symbols.definitions.iter().find(|d| d.name == "Login").expect("Login");
        let doc = def.doc.as_deref().unwrap_or("");
        assert!(doc.contains("Логин по email"), "XML doc in doc: {doc}");
    }
}
