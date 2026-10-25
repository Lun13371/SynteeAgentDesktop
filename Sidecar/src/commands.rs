use std::path::PathBuf;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::{IndexOptions, PROTOCOL_VERSION};
use crate::error::{Result, SidecarError};
use crate::indexer::Indexer;
use crate::protocol::Request;
use crate::search::SearchOptions;
use crate::watcher::WatchManager;

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

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HealthParams {
    db_path: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    protocol_version: u32,
    methods: Vec<&'static str>,
    parser_backend: &'static str,
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
                    "shutdown",
                ],
                parser_backend: "rust-lexical-structural-parser",
            })?,
            shutdown: false,
        }),
        "index" => {
            let params: IndexParams = parse_params(request.params)?;
            let result = Indexer::open(&params.db_path)?.index(
                &params.project_id,
                &params.workdir,
                &params.options,
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
            Ok(CommandOutcome { result: watcher().foreground_busy(params.busy), shutdown: false })
        }
        "status" => Ok(CommandOutcome { result: watcher().status(), shutdown: false }),
        "shutdown" => {
            watcher().shutdown()?;
            Ok(CommandOutcome { result: json!({ "status": "shutting_down" }), shutdown: true })
        }
        other => Err(SidecarError::UnsupportedMethod(other.to_owned())),
    }
}

fn parse_params<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|error| SidecarError::InvalidRequest(error.to_string()))
}
