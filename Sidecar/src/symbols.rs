use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolDef {
    pub name: String,
    pub kind: String,
    pub line_start: usize,
    pub line_end: usize,
    pub signature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSymbols {
    pub definitions: Vec<SymbolDef>,
    pub imports: Vec<String>,
    pub references: Vec<String>,
}

pub fn extract_symbols(source: &str, language: &str, skip_references: bool) -> FileSymbols {
    let mut definitions = Vec::new();
    let mut imports = Vec::new();
    let mut reference_lines = Vec::new();
    let mut stack: Vec<(String, usize, usize)> = Vec::new();
    let mut brace_depth = 0usize;
    let mut known = HashSet::new();

    for (index, raw_line) in source.lines().enumerate() {
        let line_number = index + 1;
        let line = raw_line.trim().trim_start_matches('\u{feff}');
        if line.is_empty()
            || line.starts_with("//")
            || line.starts_with('#') && language != "c" && language != "cpp"
        {
            continue;
        }
        let clean = strip_line_comment(line);
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
        brace_depth =
            brace_depth.saturating_add(clean.chars().filter(|character| *character == '{').count());
        brace_depth =
            brace_depth.saturating_sub(clean.chars().filter(|character| *character == '}').count());
        while stack.last().is_some_and(|item| brace_depth <= item.2) {
            stack.pop();
        }
        if definitions.len() >= 300 {
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
    FileSymbols { definitions, imports: imports.into_iter().take(100).collect(), references }
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

fn strip_line_comment(line: &str) -> String {
    line.split_once("//").map_or_else(|| line.to_owned(), |(head, _)| head.to_owned())
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
}
