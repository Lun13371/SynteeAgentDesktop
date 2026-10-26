//! Shared text normalization for indexing and retrieval.
//!
//! Indexing precomputes normalized columns (`search_path`, `search_names`,
//! `search_body`) once per file so a search never has to lowercase, split
//! camelCase or parse JSON per row. Both sides therefore have to agree on
//! exactly one normalization — hence this module.

/// Lowercase, split camelCase/snake_case boundaries and collapse punctuation so
/// `getUserById`, `user_id` and `user id` all normalize to `user by id`.
pub fn normalize(text: &str) -> String {
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

/// Build one normalized field from many raw fragments.
pub fn normalize_join<'a>(parts: impl IntoIterator<Item = &'a str>, max_chars: usize) -> String {
    let mut out = String::new();
    for part in parts {
        if out.len() >= max_chars {
            break;
        }
        let normalized = normalize(part);
        for word in normalized.split_whitespace() {
            if out.len() + word.len() + 1 > max_chars {
                return out;
            }
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(word);
        }
    }
    out
}

/// Whole-word containment in an already normalized haystack.
///
/// Substring matching alone ranks a file that merely contains `user` inside
/// `superuser` exactly like the file that defines `user`, which is what made
/// unrelated hits tie at identical scores.
pub fn contains_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut start = 0usize;
    while start + needle.len() <= haystack.len() {
        let Some(offset) = haystack[start..].find(needle) else { return false };
        let absolute = start + offset;
        let before_ok = absolute == 0 || bytes[absolute - 1] == b' ';
        let end = absolute + needle.len();
        let after_ok = end == haystack.len() || bytes[end] == b' ';
        if before_ok && after_ok {
            return true;
        }
        start = absolute + 1;
    }
    false
}

/// The needle starts a word but may continue it (`index` matches `indexer`).
pub fn contains_word_prefix(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() || haystack.len() < needle.len() {
        return false;
    }
    let bytes = haystack.as_bytes();
    let mut start = 0usize;
    while start + needle.len() <= haystack.len() {
        let Some(offset) = haystack[start..].find(needle) else { return false };
        let absolute = start + offset;
        if absolute == 0 || bytes[absolute - 1] == b' ' {
            return true;
        }
        start = absolute + 1;
    }
    false
}

const STEM_SUFFIXES: &[&str] = &[
    "ами", "ями", "ого", "ему", "ов", "ев", "ий", "ый", "ая", "ое", "ые", "ой", "ей", "ах", "ях",
    "ам", "ям", "ии", "ия", "а", "я", "ы", "и", "е", "у", "ю", "о", "ь", "ing", "ed", "es", "s",
    "tion", "ment", "ness", "able", "er", "ly",
];

/// Crude suffix stripping. It does not need to be linguistically correct: it
/// only produces extra variants to try, never replaces the original token.
pub fn stem_variants(token: &str) -> Vec<String> {
    let mut variants = Vec::new();
    for suffix in STEM_SUFFIXES {
        if let Some(stripped) = token.strip_suffix(suffix) {
            if stripped.chars().count() >= 3 {
                variants.push(stripped.to_owned());
            }
        }
    }
    variants
}

pub fn is_stop_word(token: &str) -> bool {
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
        "если",
        "ли",
        "бы",
        "же",
        "уже",
        "ещё",
        "еще",
        "при",
        "про",
        "без",
        "под",
        "над",
        "также",
        "только",
    ];
    STOP_WORDS.contains(&token)
}

#[cfg(test)]
mod tests {
    use super::{contains_word, contains_word_prefix, normalize, normalize_join, stem_variants};

    #[test]
    fn normalize_splits_camel_case_and_punctuation() {
        assert_eq!(normalize("getUserById"), "get user by id");
        assert_eq!(normalize("src/core/UserStore.ts"), "src core user store ts");
        assert_eq!(normalize("ОТРИСОВКА"), "отрисовка");
    }

    #[test]
    fn word_matching_does_not_confuse_substrings() {
        assert!(contains_word("get user by id", "user"));
        assert!(!contains_word("superuser cache", "user"));
        assert!(contains_word_prefix("indexer rust", "index"));
        assert!(!contains_word_prefix("reindex rust", "index"));
    }

    #[test]
    fn normalize_join_respects_the_char_budget() {
        let joined = normalize_join(["alphaBeta", "gamma"], 100);
        assert_eq!(joined, "alpha beta gamma");
        assert!(normalize_join(["alphaBeta", "gamma"], 8).len() <= 8);
    }

    #[test]
    fn stem_variants_cover_russian_and_english_plurals() {
        assert!(stem_variants("кеши").iter().any(|variant| variant == "кеш"));
        assert!(stem_variants("tokens").iter().any(|variant| variant == "token"));
    }
}
