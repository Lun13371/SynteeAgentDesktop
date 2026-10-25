//! Lexical retrieval over the sidecar index.
//!
//! Two phases on purpose:
//!
//! 1. [`rank`] scores every row using only the precomputed normalized columns
//!    (`search_path` / `search_names` / `search_body`). No JSON is parsed here,
//!    so a search over a few thousand files costs a few milliseconds.
//! 2. [`assemble`] loads and trims definitions for the winning files only.
//!
//! Ranking signals, in order of importance:
//!
//! * **field weight** — a name match beats a path match beats a mention in
//!   imports/references. Without this, a test file that merely *imports*
//!   `countTokens` ranked exactly like `tokens.rs` that defines it.
//! * **match level** — whole word > word prefix > arbitrary substring.
//! * **IDF** — a token that appears in every file says nothing; a rare token is
//!   the one that identifies the file.
//! * **structural importance** — source files over artifacts, definitions over
//!   empty files, shallow paths over deep ones.
//!
//! Every tie is broken deterministically (matched tokens, definition count,
//! path depth, path), so identical queries return identical order.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::config::{MAX_SEARCH_FILES, MAX_SEARCH_RESULT_BYTES, MAX_SEARCH_TOKENS};
use crate::db::IndexRow;
use crate::symbols::SymbolDef;
use crate::synonyms;
use crate::text::{contains_word, contains_word_prefix, is_stop_word, normalize, stem_variants};

/// How many definitions travel with one hit. The repo-map slice only prints a
/// dozen names, and the previous "all definitions of every file" payload hit the
/// 512 KB response cap with 25 of 50 requested files.
const MAX_DEFINITIONS_PER_HIT: usize = 12;
/// Rough JSON cost of one serialized `SymbolDef` (keys + numbers).
const DEFINITION_JSON_OVERHEAD: usize = 70;
/// Envelope cost of the result object itself.
const RESULT_JSON_OVERHEAD: usize = 200;

// Field weights: a definition name is the strongest evidence that a file is
// about the query; a mention in imports/references is the weakest.
const NAMES_WEIGHT: f64 = 3.0;
const PATH_WEIGHT: f64 = 1.7;
const BODY_WEIGHT: f64 = 0.9;
const PREFIX_FACTOR: f64 = 0.72;
const SUBSTRING_FACTOR: f64 = 0.45;
/// Stem/translation variants are weaker evidence than the literal token.
const VARIANT_FACTOR: f64 = 0.85;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MatchKind {
    /// Every query token matched at least one file.
    Exact,
    /// Some query tokens matched; the rest were unknown to the index.
    Partial,
    /// Nothing matched — the result is "structurally important files".
    Fallback,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub score: f64,
    pub definitions: Vec<SymbolDef>,
    /// How many query tokens this file matched.
    pub matched_tokens: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub slice: String,
    pub top_files: Vec<SearchHit>,
    pub indexed_files_count: usize,
    /// `exact` | `partial` | `fallback` — lets the caller tell a real match from
    /// a guess instead of presenting both as equally trustworthy.
    pub match_kind: MatchKind,
    /// Tokens the query was reduced to (after normalization/stemming/translation).
    pub query_tokens: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    #[serde(default = "default_max_files")]
    pub max_files: usize,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: usize,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self { max_files: default_max_files(), max_tokens: default_max_tokens() }
    }
}

fn default_max_files() -> usize {
    25
}

fn default_max_tokens() -> usize {
    4_000
}

/// One normalized query token plus every alternative spelling worth trying.
struct QueryToken {
    text: String,
    /// `text` first, then stem variants and English translations.
    variants: Vec<String>,
}

impl QueryToken {
    fn new(text: String) -> Self {
        let mut variants = vec![text.clone()];
        for variant in stem_variants(&text) {
            if !variants.contains(&variant) {
                variants.push(variant);
            }
        }
        for translated in synonyms::translations(&text) {
            let translated = translated.to_string();
            if !variants.contains(&translated) {
                variants.push(translated.clone());
            }
            for variant in stem_variants(&translated) {
                if !variants.contains(&variant) {
                    variants.push(variant);
                }
            }
        }
        // Stemming can also land on a dictionary entry: "кеши" → "кеш" → cache.
        for existing in variants.clone() {
            for translated in synonyms::translations(&existing) {
                let translated = translated.to_string();
                if !variants.contains(&translated) {
                    variants.push(translated);
                }
            }
        }
        Self { text, variants }
    }
}

/// A file that survived ranking, with the score and match count that got it there.
#[derive(Debug, Clone)]
pub struct ScoredFile {
    pub path: String,
    pub score: f64,
    pub matched_tokens: usize,
    /// Index into the row slice `rank` was called with.
    pub row_index: usize,
}

#[derive(Debug, Clone)]
pub struct RankResult {
    pub files: Vec<ScoredFile>,
    pub match_kind: MatchKind,
    pub tokens: Vec<String>,
}

fn query_tokens(query: &str) -> Vec<QueryToken> {
    let mut tokens: Vec<QueryToken> = Vec::new();
    for raw in normalize(query).split_whitespace() {
        if raw.chars().count() < 2 || is_stop_word(raw) {
            continue;
        }
        if !tokens.iter().any(|existing| existing.text == raw) {
            tokens.push(QueryToken::new(raw.to_owned()));
        }
    }
    tokens.truncate(24);
    tokens
}

/// Every spelling worth trying for a query, flattened. Used by the FTS
/// accelerator, which matches whole tokens only.
pub fn fts_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for token in query_tokens(query) {
        for variant in token.variants {
            if variant.chars().count() >= 2 && !terms.contains(&variant) {
                terms.push(variant);
            }
        }
    }
    terms.truncate(48);
    terms
}

/// Score a single row against one token. Returns 0.0 when nothing matches.
fn token_strength(row: &IndexRow, token: &QueryToken) -> f64 {
    let mut best = 0.0_f64;
    for (index, variant) in token.variants.iter().enumerate() {
        let factor = if index == 0 { 1.0 } else { VARIANT_FACTOR };
        let names = field_score(&row.search_names, variant, NAMES_WEIGHT);
        if names > 0.0 {
            best = best.max(names * factor);
            // A name hit is the strongest signal available for this token.
            continue;
        }
        let path = field_score(&row.search_path, variant, PATH_WEIGHT);
        if path > 0.0 {
            best = best.max(path * factor);
            continue;
        }
        let body = field_score(&row.search_body, variant, BODY_WEIGHT);
        if body > 0.0 {
            best = best.max(body * factor);
        }
    }
    best
}

fn field_score(field: &str, needle: &str, weight: f64) -> f64 {
    if field.is_empty() || needle.is_empty() {
        return 0.0;
    }
    if contains_word(field, needle) {
        return weight;
    }
    if contains_word_prefix(field, needle) {
        return weight * PREFIX_FACTOR;
    }
    if field.contains(needle) {
        return weight * SUBSTRING_FACTOR;
    }
    0.0
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

fn importance(row: &IndexRow) -> f64 {
    source_priority(row.lang.as_deref())
        + row.definitions_count.min(40) as f64 * 0.05
        + 1.0 / (1.0 + path_depth(&row.file_path) as f64)
}

/// Phase 1: rank rows without touching `symbols_json`.
pub fn rank(rows: &[IndexRow], query: &str, max_files: usize) -> RankResult {
    let tokens = query_tokens(query);
    let limit = max_files.clamp(1, MAX_SEARCH_FILES);
    if rows.is_empty() {
        return RankResult {
            files: Vec::new(),
            match_kind: MatchKind::Fallback,
            tokens: tokens.into_iter().map(|token| token.text).collect(),
        };
    }
    let token_texts: Vec<String> = tokens.iter().map(|token| token.text.clone()).collect();

    if tokens.is_empty() {
        // No query: a stable "most important files" listing.
        let mut files: Vec<ScoredFile> = rows
            .iter()
            .enumerate()
            .map(|(index, row)| ScoredFile {
                path: row.file_path.clone(),
                score: row.ranked_score + importance(row),
                matched_tokens: 0,
                row_index: index,
            })
            .collect();
        sort_scored(&mut files, rows);
        files.truncate(limit);
        return RankResult { files, match_kind: MatchKind::Partial, tokens: token_texts };
    }

    // Document frequency per token: a token present in every file carries no
    // information, a token present in two files is the one that identifies them.
    let total = rows.len() as f64;
    let mut idf = Vec::with_capacity(tokens.len());
    for token in &tokens {
        let document_frequency =
            rows.iter().filter(|row| token_strength(row, token) > 0.0).count() as f64;
        idf.push((1.0 + total / (1.0 + document_frequency)).ln());
    }

    let max_possible: f64 =
        tokens.iter().zip(&idf).map(|(_, idf)| NAMES_WEIGHT * idf).sum::<f64>().max(f64::EPSILON);

    let mut hits: Vec<ScoredFile> = Vec::new();
    let mut fallback: Vec<ScoredFile> = Vec::new();
    let mut matched_any_token = vec![false; tokens.len()];
    let mut matched_token_count = 0usize;

    for (index, row) in rows.iter().enumerate() {
        let mut weighted = 0.0_f64;
        let mut matched = 0usize;
        for (token_index, token) in tokens.iter().enumerate() {
            let strength = token_strength(row, token);
            if strength > 0.0 {
                matched += 1;
                weighted += strength * idf[token_index];
                matched_any_token[token_index] = true;
                matched_token_count += 1;
            }
        }
        let base = row.ranked_score + importance(row);
        if matched == 0 {
            fallback.push(ScoredFile {
                path: row.file_path.clone(),
                score: base,
                matched_tokens: 0,
                row_index: index,
            });
            continue;
        }
        let coverage = (weighted / max_possible).clamp(0.0, 1.0);
        hits.push(ScoredFile {
            path: row.file_path.clone(),
            score: coverage * 60.0 + matched as f64 + base,
            matched_tokens: matched,
            row_index: index,
        });
    }

    let match_kind = if matched_token_count == 0 {
        MatchKind::Fallback
    } else if matched_any_token.iter().all(|matched| *matched) {
        MatchKind::Exact
    } else {
        MatchKind::Partial
    };

    if hits.is_empty() {
        sort_scored(&mut fallback, rows);
        fallback.truncate(limit);
        return RankResult { files: fallback, match_kind, tokens: token_texts };
    }
    sort_scored(&mut hits, rows);
    hits.truncate(limit);
    RankResult { files: hits, match_kind, tokens: token_texts }
}

fn sort_scored(files: &mut [ScoredFile], rows: &[IndexRow]) {
    files.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| right.matched_tokens.cmp(&left.matched_tokens))
            .then_with(|| {
                let left_row = &rows[left.row_index];
                let right_row = &rows[right.row_index];
                right_row
                    .definitions_count
                    .cmp(&left_row.definitions_count)
                    .then_with(|| path_depth(&left.path).cmp(&path_depth(&right.path)))
            })
            .then_with(|| left.path.cmp(&right.path))
    });
}

/// Phase 2: attach trimmed definitions and build the repo-map slice.
pub fn assemble(
    rows: &[IndexRow],
    definitions: &HashMap<String, Vec<SymbolDef>>,
    ranked: &RankResult,
    options: &SearchOptions,
) -> SearchResult {
    let tokens = query_tokens(&ranked.tokens.join(" "));
    let token_budget = options.max_tokens.min(MAX_SEARCH_TOKENS);
    let byte_budget = token_budget.saturating_mul(4).min(MAX_SEARCH_RESULT_BYTES);

    let mut slice = String::new();
    let mut top_files: Vec<SearchHit> = Vec::new();
    let mut estimated_json = RESULT_JSON_OVERHEAD;

    for scored in &ranked.files {
        let row = &rows[scored.row_index];
        let raw = definitions.get(&scored.path).cloned().unwrap_or_else(|| {
            row.symbols_json.as_deref().and_then(parse_definitions).unwrap_or_default()
        });
        let trimmed = trim_definitions(raw, &tokens);
        let hit = SearchHit {
            path: scored.path.clone(),
            score: scored.score,
            definitions: trimmed,
            matched_tokens: scored.matched_tokens,
        };
        let line = format!("{}\n", format_definitions(&hit));
        let hit_json = 80
            + hit.path.len()
            + hit
                .definitions
                .iter()
                .map(|definition| {
                    DEFINITION_JSON_OVERHEAD + definition.name.len() + definition.signature.len()
                })
                .sum::<usize>();
        let slice_full = slice.len() + line.len() > byte_budget;
        let json_full = estimated_json + hit_json > MAX_SEARCH_RESULT_BYTES;
        if !top_files.is_empty() && (slice_full || json_full) {
            break;
        }
        slice.push_str(&line);
        estimated_json += hit_json;
        top_files.push(hit);
    }

    let mut result = SearchResult {
        slice,
        top_files,
        indexed_files_count: rows.len(),
        match_kind: ranked.match_kind,
        query_tokens: ranked.tokens.clone(),
    };
    // The estimate above is deliberately conservative; verify once and drop
    // trailing hits until the payload really fits.
    while serde_json::to_vec(&result)
        .map(|value| value.len() > MAX_SEARCH_RESULT_BYTES)
        .unwrap_or(false)
    {
        if result.top_files.pop().is_none() {
            break;
        }
        result.slice =
            result.top_files.iter().map(|hit| format!("{}\n", format_definitions(hit))).collect();
    }
    result
}

/// Convenience wrapper for callers that already hold definitions inline.
pub fn search(rows: &[IndexRow], query: &str, options: &SearchOptions) -> SearchResult {
    let ranked = rank(rows, query, options.max_files);
    let definitions: HashMap<String, Vec<SymbolDef>> = rows
        .iter()
        .filter_map(|row| {
            let parsed = row.symbols_json.as_deref().and_then(parse_definitions)?;
            Some((row.file_path.clone(), parsed))
        })
        .collect();
    assemble(rows, &definitions, &ranked, options)
}

/// Keep the definitions the query is actually about, in relevance order.
fn trim_definitions(definitions: Vec<SymbolDef>, tokens: &[QueryToken]) -> Vec<SymbolDef> {
    if definitions.len() <= MAX_DEFINITIONS_PER_HIT {
        return definitions;
    }
    let mut scored: Vec<(f64, usize, SymbolDef)> = definitions
        .into_iter()
        .enumerate()
        .map(|(index, definition)| {
            let name = normalize(&definition.name);
            let mut score = 0.0_f64;
            for token in tokens {
                for variant in &token.variants {
                    if contains_word(&name, variant) {
                        score += 3.0;
                    } else if contains_word_prefix(&name, variant) {
                        score += 2.0;
                    } else if name.contains(variant.as_str()) {
                        score += 1.0;
                    }
                }
            }
            // Container declarations anchor a file even without a name hit.
            if definition.parent_name.is_none()
                && matches!(definition.kind.as_str(), "class" | "struct" | "interface" | "module")
            {
                score += 0.5;
            }
            (score, index, definition)
        })
        .collect();
    scored.sort_by(|left, right| right.0.total_cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    scored.into_iter().take(MAX_DEFINITIONS_PER_HIT).map(|(_, _, definition)| definition).collect()
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
        .take(MAX_DEFINITIONS_PER_HIT)
        .map(|definition| {
            format!("L{} {} {}", definition.line_start, definition.kind, definition.name)
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("{}: {}", hit.path, names)
}

#[cfg(test)]
mod tests {
    use super::{rank, search, MatchKind, SearchOptions};
    use crate::config::{MAX_SEARCH_FILES, MAX_SEARCH_RESULT_BYTES, MAX_SEARCH_TOKENS};
    use crate::db::IndexRow;

    fn row(path: &str, lang: &str, symbols: &str) -> IndexRow {
        IndexRow {
            file_path: path.to_owned(),
            lang: Some(lang.to_owned()),
            symbols_json: Some(symbols.to_owned()),
            search_path: String::new(),
            search_names: String::new(),
            search_body: String::new(),
            definitions_count: 0,
            ranked_score: 0.0,
        }
        .with_derived_search_fields()
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
        assert_eq!(result.match_kind, MatchKind::Exact);
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
    fn unknown_query_falls_back_to_important_source_files() {
        let rows = vec![
            row("assets/minecraft/lang/en_us.json", "json", r#"{"d":[]}"#),
            row(
                "src/core/module/Module.java",
                "java",
                r#"{"d":[{"name":"Module"},{"name":"onTick"}]}"#,
            ),
        ];
        let result = search(
            &rows,
            "совершеннослучайноеслово",
            &SearchOptions { max_files: 5, max_tokens: 1000 },
        );
        assert_eq!(result.match_kind, MatchKind::Fallback);
        assert_eq!(result.top_files[0].path, "src/core/module/Module.java");
    }

    #[test]
    fn russian_plural_reaches_the_english_identifier() {
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
        assert_eq!(result.match_kind, MatchKind::Exact);
        assert_eq!(result.top_files[0].path, "src/core/module/Module.java");
    }

    #[test]
    fn definition_owners_outrank_files_that_only_mention_the_name() {
        let rows = vec![
            row(
                "tests/tokens-rust-parity.test.cjs",
                "javascript",
                r#"{"d":[],"r":["countTokens","tokenizer"]}"#,
            ),
            row(
                "Sidecar/src/tokens.rs",
                "rust",
                r#"{"d":[{"name":"count_tokens","kind":"function","lineStart":26,"lineEnd":32}]}"#,
            ),
        ];
        let result =
            search(&rows, "token counting", &SearchOptions { max_files: 2, max_tokens: 1000 });
        assert_eq!(result.top_files[0].path, "Sidecar/src/tokens.rs");
    }

    #[test]
    fn russian_query_finds_english_code_through_the_dictionary() {
        let rows = vec![
            row("src/cache/store.ts", "typescript", r#"{"d":[{"name":"cacheStore"}]}"#),
            row("src/ui/button.tsx", "tsx", r#"{"d":[{"name":"Button"}]}"#),
        ];
        let result =
            search(&rows, "кеш хранилище", &SearchOptions { max_files: 5, max_tokens: 1000 });
        assert_eq!(result.top_files[0].path, "src/cache/store.ts");
        assert_ne!(result.match_kind, MatchKind::Fallback);
    }

    #[test]
    fn ties_are_broken_deterministically() {
        let rows = vec![
            row("src/b/search.rs", "rust", r#"{"d":[{"name":"search"}]}"#),
            row("src/a/search.rs", "rust", r#"{"d":[{"name":"search"}]}"#),
        ];
        let first = search(&rows, "search", &SearchOptions { max_files: 5, max_tokens: 1000 });
        let second = search(&rows, "search", &SearchOptions { max_files: 5, max_tokens: 1000 });
        assert_eq!(first.top_files[0].path, second.top_files[0].path);
    }

    #[test]
    fn definitions_are_trimmed_per_hit() {
        let definitions = (0..40)
            .map(|index| {
                format!(
                    r#"{{"name":"symbol_{index}","kind":"function","lineStart":{index},"lineEnd":{index}}}"#
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let rows = vec![row("src/big.ts", "typescript", &format!(r#"{{"d":[{definitions}]}}"#))];
        let result = search(&rows, "symbol", &SearchOptions { max_files: 1, max_tokens: 4000 });
        assert_eq!(result.top_files[0].definitions.len(), 12);
    }

    #[test]
    fn empty_query_ranks_by_structural_importance() {
        let rows = vec![
            row("assets/data.json", "json", r#"{"d":[]}"#),
            row("src/core/engine.rs", "rust", r#"{"d":[{"name":"Engine"}]}"#),
        ];
        let ranked = rank(&rows, "", 5);
        assert_eq!(ranked.files[0].path, "src/core/engine.rs");
    }
}
