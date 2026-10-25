use serde::{Deserialize, Serialize};

use crate::config::{MAX_SEARCH_FILES, MAX_SEARCH_RESULT_BYTES, MAX_SEARCH_TOKENS};
use crate::db::IndexRow;
use crate::symbols::SymbolDef;

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub score: f64,
    pub definitions: Vec<SymbolDef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub slice: String,
    pub top_files: Vec<SearchHit>,
    pub indexed_files_count: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default = "default_max_files")]
    pub max_files: usize,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
}

fn default_max_files() -> usize {
    25
}
fn default_max_tokens() -> usize {
    4_000
}

pub fn search(rows: &[IndexRow], query: &str, options: &SearchOptions) -> SearchResult {
    let tokens = query_tokens(query);
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut fallback: Vec<SearchHit> = Vec::new();

    for row in rows {
        let haystack = normalize(&format!(
            "{} {}",
            row.file_path,
            row.symbols_json.as_deref().unwrap_or_default()
        ));
        let definitions =
            row.symbols_json.as_deref().and_then(parse_definitions).unwrap_or_default();
        let source_priority = source_priority(row.lang.as_deref());
        let importance = source_priority
            + definitions.len().min(40) as f64 * 0.05
            + 1.0 / (1.0 + path_depth(&row.file_path) as f64);

        let matched = tokens.iter().filter(|token| token_matches(&haystack, token)).count();
        if tokens.is_empty() {
            let score = row.ranked_score + row.relevance_boost.min(5.0) * 1.5 + importance;
            hits.push(SearchHit { path: row.file_path.clone(), score, definitions });
            continue;
        }
        if matched > 0 {
            let coverage = matched as f64 / tokens.len() as f64;
            let score = coverage * 30.0
                + matched as f64
                + row.ranked_score
                + row.relevance_boost.min(5.0) * 1.5
                + importance;
            hits.push(SearchHit {
                path: row.file_path.clone(),
                score,
                definitions: definitions.clone(),
            });
        }
        fallback.push(SearchHit {
            path: row.file_path.clone(),
            score: importance + row.ranked_score,
            definitions,
        });
    }

    // A lexical miss must not turn into "no files at all": fall back to the most
    // structurally important files so the LLM still receives a repo map slice.
    if hits.is_empty() && !fallback.is_empty() {
        fallback.sort_by(|left, right| right.score.total_cmp(&left.score));
        hits = fallback;
    }

    hits.sort_by(|left, right| right.score.total_cmp(&left.score));
    hits.truncate(options.max_files.min(MAX_SEARCH_FILES));

    let token_budget = options.max_tokens.min(MAX_SEARCH_TOKENS);
    let byte_budget = token_budget.saturating_mul(4).min(MAX_SEARCH_RESULT_BYTES);
    let mut slice = String::new();
    let mut result_hits = Vec::with_capacity(hits.len());
    for hit in hits {
        let line = format!("{}\n", format_definitions(&hit));
        if slice.len().saturating_add(line.len()) > byte_budget {
            break;
        }
        let mut candidate_hits = result_hits.clone();
        candidate_hits.push(hit.clone());
        let candidate = SearchResult {
            slice: format!("{slice}{line}"),
            top_files: candidate_hits,
            indexed_files_count: rows.len(),
        };
        if serde_json::to_vec(&candidate)
            .map(|value| value.len() > MAX_SEARCH_RESULT_BYTES)
            .unwrap_or(true)
        {
            break;
        }
        slice.push_str(&line);
        result_hits.push(hit);
    }
    SearchResult { slice, top_files: result_hits, indexed_files_count: rows.len() }
}

fn source_priority(lang: Option<&str>) -> f64 {
    match lang {
        Some("json" | "yaml" | "toml" | "markdown") => 0.0,
        _ => 12.0,
    }
}

fn path_depth(path: &str) -> usize {
    path.chars().filter(|character| *character == '/' || *character == '\\').count()
}

/// Lowercase, split camelCase/snake_case boundaries and collapse punctuation so
/// substring matching works for `getUserById`, `user_id` and `user id` alike.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 4);
    let mut previous_is_lower_or_digit = false;
    for character in text.chars() {
        if character.is_alphanumeric() {
            if character.is_uppercase() && previous_is_lower_or_digit {
                out.push(' ');
            }
            for lowered in character.to_lowercase() {
                out.push(lowered);
            }
            previous_is_lower_or_digit = !character.is_uppercase();
        } else {
            out.push(' ');
            previous_is_lower_or_digit = false;
        }
    }
    out
}

fn query_tokens(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    for raw in normalize(query).split_whitespace() {
        if raw.len() < 2 || is_stop_word(raw) {
            continue;
        }
        if !tokens.iter().any(|existing| existing == raw) {
            tokens.push(raw.to_owned());
        }
    }
    tokens.truncate(24);
    tokens
}

fn token_matches(haystack: &str, token: &str) -> bool {
    if haystack.contains(token) {
        return true;
    }
    for variant in stem_variants(token) {
        if haystack.contains(&variant) {
            return true;
        }
    }
    false
}

fn stem_variants(token: &str) -> Vec<String> {
    const SUFFIXES: &[&str] = &[
        "ами", "ями", "ого", "ему", "ов", "ев", "ий", "ый", "ая", "ое", "ые", "ой", "ей", "ах",
        "ях", "ам", "ям", "ии", "ия", "а", "я", "ы", "и", "е", "у", "ю", "о", "ь", "ing", "ed",
        "es", "s", "tion", "ment", "ness", "able", "er", "ly",
    ];
    let mut variants = Vec::new();
    for suffix in SUFFIXES {
        if let Some(stripped) = token.strip_suffix(suffix) {
            if stripped.len() >= 3 {
                variants.push(stripped.to_owned());
            }
        }
    }
    variants
}

fn is_stop_word(token: &str) -> bool {
    const STOP_WORDS: &[&str] = &[
        "the",
        "and",
        "for",
        "with",
        "how",
        "what",
        "where",
        "when",
        "who",
        "which",
        "does",
        "did",
        "are",
        "was",
        "were",
        "this",
        "that",
        "these",
        "those",
        "you",
        "your",
        "from",
        "into",
        "about",
        "please",
        "show",
        "find",
        "give",
        "get",
        "all",
        "not",
        "but",
        "its",
        "как",
        "что",
        "где",
        "кто",
        "чем",
        "для",
        "из",
        "на",
        "по",
        "не",
        "но",
        "или",
        "это",
        "его",
        "её",
        "их",
        "мне",
        "меня",
        "все",
        "всё",
        "так",
        "там",
        "тут",
        "когда",
        "чтобы",
        "работает",
        "работают",
        "найти",
        "покажи",
        "дай",
        "сделай",
        "сделать",
        "нужно",
        "можно",
    ];
    STOP_WORDS.contains(&token)
}

fn parse_definitions(json: &str) -> Option<Vec<SymbolDef>> {
    #[derive(Deserialize)]
    struct Symbols {
        #[serde(rename = "d")]
        definitions: Vec<SymbolDef>,
    }
    serde_json::from_str::<Symbols>(json).ok().map(|value| value.definitions)
}

fn format_definitions(hit: &SearchHit) -> String {
    let names = hit
        .definitions
        .iter()
        .take(24)
        .map(|definition| format!("{} {}", definition.kind, definition.name))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{}: {}", hit.path, names)
}

#[cfg(test)]
mod tests {
    use super::{search, SearchOptions};
    use crate::config::{MAX_SEARCH_FILES, MAX_SEARCH_RESULT_BYTES, MAX_SEARCH_TOKENS};
    use crate::db::IndexRow;

    fn row(path: &str, lang: &str, symbols: &str) -> IndexRow {
        IndexRow {
            file_path: path.to_owned(),
            lang: Some(lang.to_owned()),
            symbols_json: Some(symbols.to_owned()),
            size: 1,
            content_hash: 1,
            ranked_score: 0.0,
            relevance_boost: 0.0,
        }
    }

    #[test]
    fn search_clamps_requested_caps() {
        let rows = (0..500)
            .map(|index| row(&format!("src/file_{index}.rs"), "rust", ""))
            .collect::<Vec<_>>();
        let result =
            search(&rows, "", &SearchOptions { max_files: usize::MAX, max_tokens: usize::MAX });
        assert!(result.top_files.len() <= MAX_SEARCH_FILES);
        assert!(result.slice.len() <= MAX_SEARCH_TOKENS * 4);
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_SEARCH_RESULT_BYTES);
        assert_eq!(result.indexed_files_count, 500);
    }

    #[test]
    fn source_matches_rank_ahead_of_artifact_matches() {
        let rows = vec![
            row(
                "assets/minecraft/lang/en_us.json",
                "json",
                r#"{"d":[{"name":"render pipeline"}]}"#,
            ),
            row("src/RenderPipeline.java", "java", r#"{"d":[{"name":"render pipeline"}]}"#),
        ];
        let result =
            search(&rows, "render pipeline", &SearchOptions { max_files: 2, max_tokens: 1000 });
        assert_eq!(result.top_files[0].path, "src/RenderPipeline.java");
    }

    #[test]
    fn search_matches_cyrillic_case_insensitively() {
        let rows = vec![row("src/Render.ts", "typescript", r#"{"d":[{"name":"Отрисовка"}]}"#)];
        let result = search(&rows, "ОТРИСОВКА", &SearchOptions { max_files: 1, max_tokens: 1000 });
        assert_eq!(result.top_files.len(), 1);
    }

    #[test]
    fn camel_case_query_tokens_match_symbol_names() {
        let rows = vec![
            row(
                "src/core/module/ModuleManager.java",
                "java",
                r#"{"d":[{"name":"ModuleManager"}]}"#,
            ),
            row("assets/minecraft/lang/en_us.json", "json", r#"{"d":[]}"#),
        ];
        let result =
            search(&rows, "module manager", &SearchOptions { max_files: 5, max_tokens: 1000 });
        assert_eq!(result.top_files[0].path, "src/core/module/ModuleManager.java");
    }

    #[test]
    fn unmatched_query_falls_back_to_important_source_files() {
        let rows = vec![
            row("assets/minecraft/lang/en_us.json", "json", r#"{"d":[]}"#),
            row(
                "src/core/module/Module.java",
                "java",
                r#"{"d":[{"name":"Module"},{"name":"onTick"}]}"#,
            ),
        ];
        let result =
            search(&rows, "как работают модули", &SearchOptions { max_files: 5, max_tokens: 1000 });
        assert_eq!(result.top_files.len(), 2);
        assert_eq!(result.top_files[0].path, "src/core/module/Module.java");
    }
}
