use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_PROTOCOL_LINE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_SEARCH_FILES: usize = 200;
pub const MAX_SEARCH_TOKENS: usize = 20_000;
pub const MAX_SEARCH_RESULT_BYTES: usize = 512 * 1024;
pub const DEFAULT_MAX_FILES: usize = 5_000;
pub const DEFAULT_MAX_FILE_SIZE_KB: u64 = 1_500;
pub const DEFAULT_MAX_DEPTH: usize = 12;

pub fn default_ignore_dirs() -> Vec<String> {
    [
        "node_modules",
        "dist",
        "out",
        ".git",
        "__pycache__",
        ".venv",
        "build",
        ".next",
        "coverage",
        ".cache",
        ".turbo",
        ".parcel-cache",
        "target",
        ".gradle",
        ".idea",
        ".vscode",
        ".hermes",
        ".mimocode",
        ".playwright-mcp",
        ".planning",
        "logs",
        "tmp",
        "tmp_out",
        ".opencode",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexOptions {
    #[serde(default = "default_max_files")]
    pub max_files: usize,
    #[serde(default = "default_max_file_size_kb")]
    pub max_file_size_kb: u64,
    #[serde(default = "default_ignore_dirs")]
    pub ignore_dirs: Vec<String>,
    #[serde(default)]
    pub skip_references: bool,
}

fn default_max_files() -> usize {
    DEFAULT_MAX_FILES
}

fn default_max_file_size_kb() -> u64 {
    DEFAULT_MAX_FILE_SIZE_KB
}

impl Default for IndexOptions {
    fn default() -> Self {
        Self {
            max_files: DEFAULT_MAX_FILES,
            max_file_size_kb: DEFAULT_MAX_FILE_SIZE_KB,
            ignore_dirs: default_ignore_dirs(),
            skip_references: false,
        }
    }
}
