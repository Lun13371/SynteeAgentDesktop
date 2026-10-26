use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::fast_context::ast;
use crate::common::config::{IndexOptions, PROTOCOL_VERSION};
use crate::common::error::{Result, SidecarError};
use crate::fast_context::indexer::Indexer;
use crate::fast_context::language::language_for_path;
use crate::protocol::Request;
use crate::fast_context::search::SearchOptions;
use crate::fast_context::symbols::extract_symbols;
use crate::text::tokens;
use crate::fast_context::watcher::WatchManager;

pub struct CommandOutcome {
    pub result: Value,
    pub shutdown: bool,
}

static WATCHER: OnceLock<WatchManager> = OnceLock::new();

fn watcher() -> &'static WatchManager {
    WATCHER.get_or_init(WatchManager::new)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexParams {
    db_path: PathBuf,
    project_id: String,
    workdir: PathBuf,
    #[serde(default)]
    options: IndexOptions,
    /// Skip the pass when the index was written more recently than this.
    /// `get_fast_context` uses it so a query does not re-walk the project that
    /// the watcher is already keeping current.
    #[serde(default)]
    max_age_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPathsParams {
    db_path: PathBuf,
    project_id: String,
    workdir: PathBuf,
    changed_paths: Vec<PathBuf>,
    #[serde(default)]
    options: IndexOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    db_path: PathBuf,
    project_id: String,
    query: String,
    #[serde(flatten)]
    options: SearchOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectParams {
    db_path: PathBuf,
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchParams {
    db_path: PathBuf,
    project_id: String,
    workdir: PathBuf,
    #[serde(default)]
    options: IndexOptions,
}

#[derive(Debug, Deserialize)]
struct BusyParams {
    busy: bool,
}

#[derive(Debug, Deserialize)]
struct TokensCountParams {
    text: String,
}

#[derive(Debug, Deserialize)]
struct TokensBatchParams {
    texts: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokensTruncateParams {
    text: String,
    max_tokens: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SymbolsParams {
    path: PathBuf,
    /// Pre-read source. When absent the sidecar reads the file itself, which
    /// keeps a caller that already has the text from paying for a second read.
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    skip_references: bool,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HealthParams {
    db_path: Option<PathBuf>,
}

// ─── Semantic (E5 embeddings) ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticEmbedParams {
    model_path: PathBuf,
    tokenizer_path: PathBuf,
    texts: Vec<String>,
    /// "query" — поисковый запрос, "passage" — индексируемый документ.
    #[serde(default = "default_prefix")]
    prefix: String,
}

fn default_prefix() -> String {
    "passage".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticIndexParams {
    db_path: PathBuf,
    model_path: PathBuf,
    tokenizer_path: PathBuf,
    #[serde(default)]
    options: crate::semantic::IndexRunOptions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticSearchParams {
    db_path: PathBuf,
    model_path: PathBuf,
    tokenizer_path: PathBuf,
    #[serde(flatten)]
    options: crate::semantic::SearchOptions,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    protocol_version: u32,
    methods: Vec<&'static str>,
    parser_backend: &'static str,
    /// What ranking actually does, so a client can log/verify the backend.
    ranking: &'static str,
}

pub fn dispatch(request: Request) -> Result<CommandOutcome> {
    match request.method.as_str() {
        "health" => {
            let params: HealthParams = parse_params(request.params)?;
            let db_ready = params.db_path.as_deref().map(|path| Indexer::open(path).is_ok());
            Ok(CommandOutcome {
                result: json!({
                    "status": if db_ready != Some(false) { "ok" } else { "degraded" },
                    "protocolVersion": PROTOCOL_VERSION,
                    "dbReady": db_ready.unwrap_or(false),
                }),

                shutdown: false,
            })
        }
        "capabilities" => Ok(CommandOutcome {
            result: serde_json::to_value(Capabilities {
                protocol_version: PROTOCOL_VERSION,
                methods: vec![
                    "health",
                    "capabilities",
                    "index",
                    "indexChangedPaths",
                    "search",
                    "clear",
                    "startWatching",
                    "stopWatching",
                    "foregroundBusy",
                    "status",
                    "tokensCount",
                    "tokensCountBatch",
                    "tokensTruncate",
                    "symbols",
                    "semanticEmbed",
                    "semanticIndex",
                    "semanticSearch",
                    "semanticUnload",
                    "shutdown",
                ],
                parser_backend: "tree-sitter (native) + lexical fallback",
                ranking: "field-weighted + idf + ru-en synonyms + graph rank; semantic: E5 cosine (onnx)",
            })?,
            shutdown: false,
        }),
        "index" => {
            let params: IndexParams = parse_params(request.params)?;
            let result = Indexer::open(&params.db_path)?.index(
                &params.project_id,
                &params.workdir,
                &params.options,
                params.max_age_ms,
            )?;
            Ok(CommandOutcome { result: serde_json::to_value(result)?, shutdown: false })
        }
        "indexChangedPaths" => {
            let params: ChangedPathsParams = parse_params(request.params)?;
            let result = Indexer::open(&params.db_path)?.index_changed_paths(
                &params.project_id,
                &params.workdir,
                &params.changed_paths,
                &params.options,
            )?;
            Ok(CommandOutcome { result: serde_json::to_value(result)?, shutdown: false })
        }
        "search" => {
            let params: SearchParams = parse_params(request.params)?;
            let result = Indexer::open(&params.db_path)?.search(
                &params.project_id,
                &params.query,
                &params.options,
            )?;
            Ok(CommandOutcome { result: serde_json::to_value(result)?, shutdown: false })
        }
        "clear" => {
            let params: ProjectParams = parse_params(request.params)?;
            let removed = Indexer::open(&params.db_path)?.clear(&params.project_id)?;
            Ok(CommandOutcome { result: json!({ "removed": removed }), shutdown: false })
        }
        "startWatching" => {
            let params: WatchParams = parse_params(request.params)?;
            Ok(CommandOutcome {
                result: watcher().start(
                    params.db_path,
                    params.project_id,
                    params.workdir,
                    params.options,
                )?,
                shutdown: false,
            })
        }
        "stopWatching" => Ok(CommandOutcome { result: watcher().stop()?, shutdown: false }),
        "foregroundBusy" => {
            let params: BusyParams = parse_params(request.params)?;
            // Один флаг на все фоновые задачи: watcher файлового индекса и
            // semantic-индексатор памяти уступают фореграунду одинаково.
            crate::semantic::set_foreground_busy(params.busy);
            Ok(CommandOutcome { result: watcher().foreground_busy(params.busy), shutdown: false })
        }
        "status" => Ok(CommandOutcome { result: watcher().status(), shutdown: false }),
        "tokensCount" => {
            let params: TokensCountParams = parse_params(request.params)?;
            Ok(CommandOutcome {
                result: json!({ "tokens": tokens::count(&params.text) }),
                shutdown: false,
            })
        }
        "tokensCountBatch" => {
            let params: TokensBatchParams = parse_params(request.params)?;
            Ok(CommandOutcome {
                result: json!({ "tokens": tokens::count_batch(&params.texts) }),
                shutdown: false,
            })
        }
        "tokensTruncate" => {
            let params: TokensTruncateParams = parse_params(request.params)?;
            if params.text.len() > tokens::MAX_TRUNCATE_CHARS {
                return Err(SidecarError::InvalidRequest(format!(
                    "text exceeds {} characters",
                    tokens::MAX_TRUNCATE_CHARS
                )));
            }
            let truncation = tokens::truncate(&params.text, params.max_tokens);
            Ok(CommandOutcome {
                result: json!({
                    "text": truncation.text,
                    "tokens": truncation.tokens,
                    "truncated": truncation.truncated,
                }),
                shutdown: false,
            })
        }
        "symbols" => {
            let params: SymbolsParams = parse_params(request.params)?;
            let language = language_for_path(&params.path);
            let Some(language) = language else {
                return Ok(CommandOutcome {
                    result: json!({
                        "definitions": [],
                        "imports": [],
                        "references": [],
                        "language": null,
                        "parser": null,
                        "supported": false,
                    }),
                    shutdown: false,
                });
            };
            let source = match params.content {
                Some(content) => content,
                None => std::fs::read_to_string(&params.path).map_err(SidecarError::Io)?,
            };
            // Native tree-sitter where a grammar exists; the lexical scanner is
            // the fallback for formats no Rust grammar covers (markdown, yaml, …).
            let (symbols, parser) = match ast::extract(&source, language, params.skip_references) {
                Some(symbols) => (symbols, "tree-sitter"),
                None => (extract_symbols(&source, language, params.skip_references), "lexical"),
            };
            Ok(CommandOutcome {
                result: json!({
                    "definitions": symbols.definitions,
                    "imports": symbols.imports,
                    "references": symbols.references,
                    "truncated": symbols.truncated,
                    "language": language,
                    "parser": parser,
                    "supported": true,
                }),
                shutdown: false,
            })
        }
        "shutdown" => {
            watcher().shutdown()?;
            crate::semantic::unload_embedder();
            Ok(CommandOutcome { result: json!({ "status": "shutting_down" }), shutdown: true })
        }
        "semanticEmbed" => {
            let params: SemanticEmbedParams = parse_params(request.params)?;
            let embedder = crate::semantic::embedder(&params.model_path, &params.tokenizer_path)?;
            let prefix = match params.prefix.as_str() {
                "query" => crate::semantic::embed::EmbedPrefix::Query,
                "passage" => crate::semantic::embed::EmbedPrefix::Passage,
                other => {
                    return Err(SidecarError::InvalidRequest(format!(
                        "unknown prefix: {other}"
                    )))
                }
            };
            let vectors = embedder.embed_batch(&params.texts, prefix)?;
            Ok(CommandOutcome {
                result: json!({
                    "model": crate::semantic::E5_MODEL_TAG,
                    "dim": crate::semantic::E5_DIM,
                    "vectors": vectors,
                }),
                shutdown: false,
            })
        }
        "semanticIndex" => {
            let params: SemanticIndexParams = parse_params(request.params)?;
            let embedder = crate::semantic::embedder(&params.model_path, &params.tokenizer_path)?;
            let report = crate::semantic::run_cycle(&params.db_path, &embedder, &params.options)?;
            Ok(CommandOutcome { result: serde_json::to_value(report)?, shutdown: false })
        }
        "semanticSearch" => {
            let params: SemanticSearchParams = parse_params(request.params)?;
            let embedder = crate::semantic::embedder(&params.model_path, &params.tokenizer_path)?;
            let hits = crate::semantic::search(&params.db_path, &embedder, &params.options)?;
            Ok(CommandOutcome {
                result: json!({
                    "model": crate::semantic::E5_MODEL_TAG,
                    "hits": hits,
                }),
                shutdown: false,
            })
        }
        "semanticUnload" => {
            let unloaded = crate::semantic::unload_embedder();
            Ok(CommandOutcome {
                result: json!({ "status": if unloaded { "unloaded" } else { "idle" } }),
                shutdown: false,
            })
        }
        other => Err(SidecarError::UnsupportedMethod(other.to_owned())),
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|error| SidecarError::InvalidRequest(error.to_string()))
}
