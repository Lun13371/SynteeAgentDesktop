//! Типы semantic-подсистемы: источники индексации и их текстовая проекция.
//!
//! Тексты собираются ровно так же, как это делает lexical-канал recall_memory
//! (`chatSearch.ts` / `search.ts`): оба канала обязаны видеть один и тот же
//! корпус, иначе гибридный поиск смешивает несравнимые вещи.

use serde::{Deserialize, Serialize};

/// Источники semantic-индексации — зеркалят `SearchSourceName` из chatSearch.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticSource {
    Memory,
    Messages,
    Summaries,
    AgentLogs,
    Pinned,
}

impl SemanticSource {
    /// Порядок обхода в одном цикле индексации (как в TS `SEMANTIC_SOURCES`).
    pub const ALL: [SemanticSource; 5] = [
        SemanticSource::Memory,
        SemanticSource::Messages,
        SemanticSource::Summaries,
        SemanticSource::AgentLogs,
        SemanticSource::Pinned,
    ];

    /// Значение колонки `semantic_embeddings.source`.
    pub fn as_str(self) -> &'static str {
        match self {
            SemanticSource::Memory => "memory",
            SemanticSource::Messages => "messages",
            SemanticSource::Summaries => "summaries",
            SemanticSource::AgentLogs => "agent_logs",
            SemanticSource::Pinned => "pinned",
        }
    }

    /// Подзапрос с PK источника — для очистки осиротевших эмбеддингов.
    ///
    /// `summaries` ключуется по `chat_id`, `pinned` — по `message_id`; остальные
    /// по `id`. Это те же ключи, которыми индексатор пишет `source_id`.
    pub fn pk_subquery(self) -> &'static str {
        match self {
            SemanticSource::Memory => "(SELECT id FROM memory_items)",
            SemanticSource::Messages => "(SELECT id FROM messages)",
            SemanticSource::Summaries => "(SELECT chat_id FROM chat_summaries)",
            SemanticSource::AgentLogs => "(SELECT id FROM agent_logs)",
            SemanticSource::Pinned => "(SELECT message_id FROM pinned_messages)",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "memory" => Some(SemanticSource::Memory),
            "messages" => Some(SemanticSource::Messages),
            "summaries" => Some(SemanticSource::Summaries),
            "agent_logs" => Some(SemanticSource::AgentLogs),
            "pinned" => Some(SemanticSource::Pinned),
            _ => None,
        }
    }
}

/// Строка-кандидат на индексацию: PK источника + уже собранный текст.
#[derive(Debug, Clone)]
pub struct SourceRow {
    /// PK строки источника (memory_items.id / messages.id / chat_id / message_id).
    pub id: String,
    /// Текст для эмбеддинга (уже собранный, как в chatSearch).
    pub text: String,
}

/// Статистика одного источника за цикл.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct SourceStats {
    pub indexed: usize,
    pub skipped: usize,
    pub failed: usize,
}

/// Статистика одного источника вместе с именем — то, что уходит в протокол.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceReport {
    pub source: SemanticSource,
    #[serde(flatten)]
    pub stats: SourceStats,
    /// Сколько миллисекунд занял источник (для perf-логов).
    pub duration_ms: u64,
}

/// Результат semantic-поиска по одному кандидату.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticHit {
    pub source: SemanticSource,
    pub source_id: String,
    /// Cosine 0..1 (E5-векторы L2-normalized, поэтому это dot product).
    pub score: f64,
    /// Усечённый контент для отображения (как в chatSearch).
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<i64>,
    /// Полная строка memory_items — TS строит MemoryItem через rowToItem.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_row: Option<serde_json::Value>,
}

/// Лимит контента в выдаче — тот же, что `MAX_CONTENT_CHARS` в chatSearch.ts.
pub const SEMANTIC_MAX_CONTENT_CHARS: usize = 600;

/// Верхняя граница сканируемых строк на источник.
///
/// Cosine считается в Rust по BLOB-векторам, но скан всё равно обязан быть
/// bounded: memory — по importance, chat-источники — по recency (как в TS).
pub fn scan_cap(source: SemanticSource) -> usize {
    match source {
        SemanticSource::Memory => 4_000,
        SemanticSource::Messages => 10_000,
        SemanticSource::Summaries => 2_000,
        SemanticSource::AgentLogs => 3_000,
        SemanticSource::Pinned => 2_000,
    }
}

/// Усечение контента для выдачи.
pub fn truncate_content(text: &str) -> String {
    if text.chars().count() <= SEMANTIC_MAX_CONTENT_CHARS {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(SEMANTIC_MAX_CONTENT_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_roundtrip() {
        for source in SemanticSource::ALL {
            assert_eq!(SemanticSource::parse(source.as_str()), Some(source));
        }
        assert_eq!(SemanticSource::parse("unknown"), None);
    }

    #[test]
    fn truncate_keeps_short_text() {
        assert_eq!(truncate_content("short"), "short");
    }

    #[test]
    fn truncate_limits_long_text() {
        let long = "я".repeat(SEMANTIC_MAX_CONTENT_CHARS + 50);
        let cut = truncate_content(&long);
        assert_eq!(cut.chars().count(), SEMANTIC_MAX_CONTENT_CHARS + 1);
        assert!(cut.ends_with('…'));
    }
}
