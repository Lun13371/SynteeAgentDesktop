use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::common::config::PROTOCOL_VERSION;
use crate::common::error::{Result, SidecarError};
use crate::protocol::Request;
use crate::symbols::{ast, extract_symbols, language::language_for_path};
use crate::text::tokens;

pub struct CommandOutcome {
    pub result: Value,
    pub shutdown: bool,
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
            let db_ready = params.db_path.as_deref().map(|path| {
                rusqlite::Connection::open_with_flags(
                    path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
                )
                .is_ok()
            });
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
                    "foregroundBusy",
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
                ranking: "semantic: E5 cosine (onnx)",
            })?,
            shutdown: false,
        }),
        "foregroundBusy" => {
            let params: BusyParams = parse_params(request.params)?;
            // Semantic-индексатор памяти уступает фореграунду, пока флаг поднят.
            crate::semantic::set_foreground_busy(params.busy);
            Ok(CommandOutcome {
                result: json!({ "foregroundBusy": params.busy }),
                shutdown: false,
            })
        }
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