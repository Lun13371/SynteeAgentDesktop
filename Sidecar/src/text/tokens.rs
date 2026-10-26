//! Token counting — cl100k_base BPE, the encoding used by [OI]/Anthropic/Gemini
//! request accounting in this app.
//!
//! The TypeScript side used `js-tiktoken` (pure JS BPE). Encoding 200-300k tokens
//! of chat history took 0.5-2s of CPU **on the main thread**, blocking IPC and
//! rendering. The same cl100k_base tables compiled into native code are roughly
//! an order of magnitude faster and keep the main thread free.
//!
//! Parity matters: both implementations use the same merge table, so token
//! counts are identical for the same input. Special-token spellings such as
//! `<|endoftext|>` are counted as ordinary text — that mirrors the
//! `encode(text, [], ['all'])` call the JS side used, where no special token is
//! allowed to match and therefore none can throw.

use tiktoken_rs::{cl100k_base_singleton, CoreBPE};

/// Maximum characters accepted by a single truncate request.
/// Guards against a caller accidentally streaming a whole repository through the
/// protocol; the JSONL reader caps lines at 4 MiB anyway.
pub const MAX_TRUNCATE_CHARS: usize = 2 * 1024 * 1024;

fn bpe() -> &'static CoreBPE {
    cl100k_base_singleton()
}

/// Exact token count for a single string.
pub fn count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    bpe().encode_ordinary(text).len()
}

/// Exact token counts for many strings. One protocol round-trip instead of N.
pub fn count_batch(texts: &[String]) -> Vec<usize> {
    let encoder = bpe();
    texts
        .iter()
        .map(|text| if text.is_empty() { 0 } else { encoder.encode_ordinary(text).len() })
        .collect()
}

/// Result of cutting a string down to a token budget.
#[derive(Debug, Clone)]
pub struct Truncation {
    pub text: String,
    pub tokens: usize,
    pub truncated: bool,
}

/// Cut `text` so that it contains at most `max_tokens` tokens.
///
/// The cut happens on a token boundary, so the decoded result may end with a
/// partial UTF-8 sequence. That tail is dropped instead of being returned as
/// U+FFFD, which keeps the output valid text for every caller.
pub fn truncate(text: &str, max_tokens: usize) -> Truncation {
    if text.is_empty() {
        return Truncation { text: String::new(), tokens: 0, truncated: false };
    }
    let encoder = bpe();
    let tokens = encoder.encode_ordinary(text);
    if tokens.len() <= max_tokens {
        return Truncation { text: text.to_owned(), tokens: tokens.len(), truncated: false };
    }
    let kept = &tokens[..max_tokens];
    let mut decoded = encoder.decode(kept).unwrap_or_default();
    // A token boundary can split a multi-byte character; drop the broken tail.
    while decoded.ends_with('\u{FFFD}') {
        decoded.pop();
    }
    // Re-count: dropping the replacement character cannot add tokens, but the
    // reported number must describe the text we actually return.
    let final_tokens = if decoded.is_empty() { 0 } else { encoder.encode_ordinary(&decoded).len() };
    Truncation { text: decoded, tokens: final_tokens, truncated: true }
}

#[cfg(test)]
mod tests {
    use super::{count, count_batch, truncate};

    #[test]
    fn counts_match_known_cl100k_values() {
        assert_eq!(count(""), 0);
        assert_eq!(count("hello world"), 2);
        // "Hello, world!" is 4 tokens in cl100k_base.
        assert_eq!(count("Hello, world!"), 4);
    }

    #[test]
    fn special_token_spellings_are_counted_as_text() {
        // Must not panic and must match js-tiktoken's `encode(text, [], ['all'])`,
        // which the TypeScript regression test pins at 8 tokens for this string.
        assert_eq!(count("ordinary text <|endoftext|>"), 8);
    }

    #[test]
    fn batch_matches_single_counts() {
        let texts = vec!["".to_owned(), "hello world".to_owned(), "Привет, мир".to_owned()];
        let batch = count_batch(&texts);
        assert_eq!(batch, texts.iter().map(|text| count(text)).collect::<Vec<_>>());
    }

    #[test]
    fn truncate_respects_budget_and_stays_valid_utf8() {
        let text = "Привет мир, это проверка обрезки по токенам. ".repeat(20);
        let result = truncate(&text, 10);
        assert!(result.truncated);
        assert!(result.tokens <= 10);
        assert!(count(&result.text) <= 10);
        assert!(!result.text.contains('\u{FFFD}'));
    }

    #[test]
    fn truncate_returns_input_when_under_budget() {
        let result = truncate("short", 100);
        assert!(!result.truncated);
        assert_eq!(result.text, "short");
        assert_eq!(result.tokens, 1);
    }
}
