use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolDef {
    pub name: String,
    pub kind: String,
    /// Defaulted so a partially populated row (an older index, a fixture) still
    /// deserializes instead of silently yielding zero definitions.
    #[serde(default)]
    pub line_start: usize,
    #[serde(default)]
    pub line_end: usize,
    #[serde(default)]
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_name: Option<String>,
}

/// A structured import: the module specifier plus the bindings it introduces.
/// `source` stays as written (`./store`, `fs`, `std::collections::HashMap`) —
/// resolving it to a file is the caller's job.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDetail {
    pub source: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub names: Vec<String>,
    #[serde(default)]
    pub line: usize,
}

/// A positioned call site: which name is called, on which line, and from
/// which enclosing definition. `receiver` is the object of a member call
/// (`store.load()` → `store`) when it is a plain identifier.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallSite {
    pub name: String,
    pub line: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSymbols {
    pub definitions: Vec<SymbolDef>,
    pub imports: Vec<String>,
    pub references: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub import_details: Vec<ImportDetail>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub call_sites: Vec<CallSite>,
    /// True when a cap stopped extraction before the end of the file, so a
    /// consumer can tell an empty outline from a truncated one.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Languages where a leading `#` starts a comment. It must not include C#:
/// `#region`/`#if` there are directives, and treating them as comments hid real
/// declarations that followed on the same line.
fn hash_starts_comment(language: &str) -> bool {
    matches!(
        language,
        "python" | "ruby" | "bash" | "yaml" | "toml" | "php" | "perl" | "elixir" | "make"
    )
}

pub fn extract_symbols(source: &str, language: &str, skip_references: bool) -> FileSymbols {
    let mut definitions = Vec::new();
    let mut imports = Vec::new();
    let mut reference_lines = Vec::new();
    let mut stack: Vec<(String, usize, usize)> = Vec::new();
    let mut brace_depth = 0usize;
    let mut known = HashSet::new();
    let mut truncated = false;

    for (index, raw_line) in source.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.trim().trim_start_matches('\u{feff}');
        if line.is_empty()
            || line.starts_with("//")
            || line.starts_with("/*")
            || line.starts_with('*')
            || line.starts_with('#') && hash_starts_comment(language)
        {
            continue;
        }
        let clean = strip_line_comment(line);
        if clean.trim().is_empty() {
            continue;
        }
        if is_import(&clean, language) {
            imports.push(clean.chars().take(240).collect());
        }
        if let Some((kind, name, signature)) = definition(&clean, language) {
            let parent_name = stack.last().map(|item| item.0.clone());
            if known.insert((name.clone(), line_number)) {
                definitions.push(SymbolDef {
                    name: name.clone(),
                    kind: kind.to_owned(),
                    line_start: line_number,
                    line_end: line_number,
                    signature,
                    parent_name,
                });
            }
            if is_container(kind) && clean.contains('{') {
                stack.push((name, line_number, brace_depth));
            }
        }
        if !skip_references {
            let names = identifiers(&clean);
            for name in names {
                if !is_keyword(&name) {
                    reference_lines.push(name);
                }
            }
        }
        // Braces inside string literals are text, not scope.
        let structural = without_strings(&clean);
        brace_depth = brace_depth
            .saturating_add(structural.chars().filter(|character| *character == '{').count());
        brace_depth = brace_depth
            .saturating_sub(structural.chars().filter(|character| *character == '}').count());
        while stack.last().is_some_and(|item| brace_depth <= item.2) {
            stack.pop();
        }
        if definitions.len() >= 300 {
            truncated = true;
            break;
        }
    }

    let definition_names: HashSet<String> =
        definitions.iter().map(|item| item.name.clone()).collect();
    let mut references = Vec::new();
    for reference in reference_lines {
        if (!definition_names.contains(&reference) || reference == "result")
            && !references.contains(&reference)
        {
            references.push(reference);
        }

        if references.len() >= 200 {
            break;
        }
    }
    FileSymbols {
        definitions,
        imports: imports.into_iter().take(100).collect(),
        references,
        import_details: Vec::new(),
        call_sites: Vec::new(),
        truncated,
    }
}

fn is_import(line: &str, language: &str) -> bool {
    match language {
        "python" => line.starts_with("import ") || line.starts_with("from "),
        "rust" => {
            line.starts_with("use ")
                || line.starts_with("mod ")
                || line.starts_with("extern crate ")
        }
        "go" => line.starts_with("import "),
        "c" | "cpp" => line.starts_with("#include"),
        _ => {
            line.starts_with("import ")
                || line.starts_with("export { ")
                || line.starts_with("require(")
                || line.contains(" from ")
                    && (line.starts_with("export ") || line.starts_with("import "))
        }
    }
}

fn definition(line: &str, language: &str) -> Option<(&'static str, String, String)> {
    let mut normalized = line.trim();
    let mut modifiers = 0;
    loop {
        let before = normalized;
        for modifier in [
            "export ",
            "default ",
            "pub ",
            "async ",
            "public ",
            "private ",
            "protected ",
            "static ",
            "abstract ",
            "virtual ",
            "override ",
            "final ",
            "readonly ",
        ] {
            if let Some(rest) = normalized.strip_prefix(modifier) {
                normalized = rest.trim_start();
                modifiers += 1;
                break;
            }
        }
        if normalized == before || modifiers > 12 {
            break;
        }
    }
    let keywords: &[(&str, &str)] = match language {
        "python" => &[("class ", "class"), ("def ", "function"), ("async def ", "function")],
        "rust" => &[
            ("fn ", "function"),
            ("struct ", "struct"),
            ("enum ", "enum"),
            ("trait ", "interface"),
            ("impl ", "impl"),
            ("type ", "type"),
            ("const ", "variable"),
            ("static ", "variable"),
        ],
        _ => &[
            ("class ", "class"),
            ("interface ", "interface"),
            ("struct ", "struct"),
            ("enum ", "enum"),
            ("function ", "function"),
            ("fn ", "function"),
            ("type ", "type"),
            ("const ", "variable"),
            ("let ", "variable"),
            ("var ", "variable"),
            ("namespace ", "module"),
            ("module ", "module"),
        ],
    };
    for (prefix, kind) in keywords {
        if let Some(rest) = normalized.strip_prefix(prefix) {
            let name = first_identifier(rest)?;
            return Some((kind, name, line.chars().take(180).collect()));
        }
    }
    if let Some((name, _)) = function_name(normalized) {
        return Some(("function", name, line.chars().take(180).collect()));
    }
    None
}

fn function_name(line: &str) -> Option<(String, usize)> {
    let open = line.find('(')?;
    let before = line[..open].trim_end();
    let name = before
        .split_whitespace()
        .last()?
        .trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_');
    if name.is_empty()
        || is_keyword(name)
        || !name.chars().next()?.is_ascii_alphabetic() && !name.starts_with('_')
    {
        return None;
    }
    Some((name.to_owned(), open))
}

fn first_identifier(input: &str) -> Option<String> {
    let name = input
        .split(|character: char| {
            !(character.is_ascii_alphanumeric() || character == '_' || character == '$')
        })
        .next()?;
    (!name.is_empty()).then(|| name.to_owned())
}

fn identifiers(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    for character in line.chars() {
        if character.is_ascii_alphanumeric() || character == '_' || character == '$' {
            current.push(character);
        } else if !current.is_empty() {
            if current.len() > 1 {
                result.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() > 1 {
        result.push(current);
    }
    result
}

/// Remove a trailing `//` comment without destroying string contents.
///
/// Splitting on the first `//` cut URLs (`"https://…"`), regex literals and JSX
/// text in half, which in turn corrupted the identifier list the lexical scanner
/// derives from the line.
fn strip_line_comment(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut chars = line.chars().peekable();
    while let Some(character) = chars.next() {
        if let Some(active) = quote {
            out.push(character);
            if escaped {
                escaped = false;
                continue;
            }
            if character == '\\' {
                escaped = true;
                continue;
            }
            if character == active {
                quote = None;
            }
            continue;
        }
        match character {
            '"' | '\'' | '`' => {
                quote = Some(character);
                out.push(character);
            }
            '/' if chars.peek() == Some(&'/') => break,
            _ => out.push(character),
        }
    }
    out
}

/// Blank out string literals so brace counting is not fooled by `"{"`.
fn without_strings(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for character in line.chars() {
        if let Some(active) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active {
                quote = None;
            }
            out.push(' ');
            continue;
        }
        if matches!(character, '"' | '\'' | '`') {
            quote = Some(character);
            out.push(' ');
            continue;
        }
        out.push(character);
    }
    out
}

fn is_container(kind: &str) -> bool {
    matches!(kind, "class" | "struct" | "enum" | "interface" | "impl" | "module")
}

fn is_keyword(name: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "as",
        "async",
        "await",
        "break",
        "case",
        "class",
        "const",
        "continue",
        "def",
        "default",
        "else",
        "enum",
        "export",
        "false",
        "for",
        "from",
        "fn",
        "function",
        "if",
        "impl",
        "import",
        "in",
        "interface",
        "let",
        "match",
        "mod",
        "new",
        "null",
        "of",
        "pub",
        "return",
        "static",
        "struct",
        "super",
        "this",
        "throw",
        "trait",
        "true",
        "type",
        "use",
        "var",
        "where",
        "while",
        "with",
    ];
    KEYWORDS.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::extract_symbols;

    #[test]
    fn extracts_modifiers_containers_functions_and_references() {
        let symbols = extract_symbols("export default async class Store {\n  public async load(value) {}\n}\nconst result = Store;", "typescript", false);
        assert!(symbols
            .definitions
            .iter()
            .any(|item| item.name == "Store" && item.kind == "class"));
        assert!(symbols
            .definitions
            .iter()
            .any(|item| item.name == "load" && item.kind == "function"));
        assert!(symbols.references.iter().any(|item| item == "value"));
    }

    #[test]
    fn extracts_rust_types_impl_and_imports() {
        let symbols = extract_symbols("use std::io;\npub struct State {}\nimpl State { fn run(&self) {} }\ntype Alias = State;", "rust", false);
        assert_eq!(symbols.imports.len(), 1);
        assert!(symbols.definitions.iter().any(|item| item.kind == "struct"));
        assert!(symbols.definitions.iter().any(|item| item.kind == "impl"));
        assert!(symbols.definitions.iter().any(|item| item.kind == "type"));
    }

    #[test]
    fn line_comments_do_not_cut_urls_or_regexes() {
        let symbols = extract_symbols(
            "const url = \"https://example.com/api\" // trailing note\nfunction load() {}\n",
            "javascript",
            false,
        );
        assert!(symbols.definitions.iter().any(|item| item.name == "load"));
        assert!(
            symbols.references.iter().any(|item| item == "example"),
            "identifiers from the string must survive the comment strip"
        );
    }

    #[test]
    fn csharp_preprocessor_directives_are_not_comments() {
        let symbols =
            extract_symbols("#region Methods\npublic void Run() {}\n#endregion\n", "c_sharp", true);
        assert!(symbols.definitions.iter().any(|item| item.name == "Run"));
    }

    #[test]
    fn braces_inside_strings_do_not_break_parent_names() {
        let symbols = extract_symbols(
            "class Store {\n  const open = \"{\"\n  void load() {}\n}\n",
            "typescript",
            true,
        );
        let load =
            symbols.definitions.iter().find(|item| item.name == "load").expect("load definition");
        assert_eq!(load.parent_name.as_deref(), Some("Store"));
    }

    #[test]
    fn truncated_flag_marks_a_capped_scan() {
        let source =
            (0..400).map(|index| format!("function fn{index}() {{}}\n")).collect::<String>();
        let symbols = extract_symbols(&source, "javascript", true);
        assert!(symbols.truncated);
        assert_eq!(symbols.definitions.len(), 300);
    }
}
