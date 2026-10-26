use std::path::Path;

/// Language identifiers intentionally match the TypeScript fast-context index.
pub fn language_for_path(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match extension.as_str() {
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "ts" => "typescript",
        "tsx" => "tsx",
        "py" => "python",
        "rs" => "rust",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "hpp" | "cc" | "cxx" => "cpp",
        "java" => "java",
        "cs" => "c_sharp",
        "rb" => "ruby",
        "php" => "php",
        "swift" => "swift",
        "kt" => "kotlin",
        "scala" => "scala",
        "lua" => "lua",
        "bash" | "sh" => "bash",
        "dart" => "dart",
        "ex" | "exs" => "elixir",
        "md" | "mdx" => "markdown",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        _ => return None,
    })
}

pub fn is_indexable(path: &Path, max_bytes: u64) -> bool {
    let Some(extension) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    if matches!(extension.to_ascii_lowercase().as_str(), "lock" | "log") {
        return false;
    }
    path.metadata().map(|metadata| metadata.len() <= max_bytes).unwrap_or(false)
}
