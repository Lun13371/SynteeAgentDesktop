use std::collections::HashSet;
use std::path::{Path, PathBuf};

use walkdir::{DirEntry, WalkDir};

use crate::config::{IndexOptions, DEFAULT_MAX_DEPTH};
use crate::language::language_for_path;

#[derive(Debug, Clone)]
pub struct SourceFile {
    pub path: PathBuf,
    pub language: String,
    pub size: u64,
    pub modified_ms: i64,
}

#[derive(Debug, Default)]
pub struct WalkResult {
    pub files: Vec<SourceFile>,
    pub hit_cap: bool,
    pub complete: bool,
    pub had_errors: bool,
}

pub fn walk_project(root: &Path, options: &IndexOptions) -> WalkResult {
    let ignored: HashSet<&str> = options.ignore_dirs.iter().map(String::as_str).collect();
    let max_bytes = options.max_file_size_kb.saturating_mul(1024);

    // Source code gets the cap first; large localization/config trees must not
    // crowd all implementation files out of the searchable index.
    let mut source = walk_category(root, &ignored, max_bytes, options.max_files, false);
    let remaining = options.max_files.saturating_sub(source.files.len());
    if !source.hit_cap {
        let artifacts = walk_category(root, &ignored, max_bytes, remaining, true);
        source.hit_cap |= artifacts.hit_cap;
        source.complete &= artifacts.complete;
        source.had_errors |= artifacts.had_errors;
        source.files.extend(artifacts.files);
    }
    source
}

fn walk_category(
    root: &Path,
    ignored: &HashSet<&str>,
    max_bytes: u64,
    max_files: usize,
    artifacts: bool,
) -> WalkResult {
    let mut result = WalkResult { complete: true, ..WalkResult::default() };
    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(DEFAULT_MAX_DEPTH + 1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| !is_ignored(entry, ignored));

    for item in walker {
        let entry = match item {
            Ok(entry) => entry,
            Err(_) => {
                result.had_errors = true;
                result.complete = false;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(language) = language_for_path(entry.path()) else { continue };
        if is_artifact(language) != artifacts {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                result.had_errors = true;
                result.complete = false;
                continue;
            }
        };
        if metadata.len() > max_bytes {
            continue;
        }
        if result.files.len() >= max_files {
            result.hit_cap = true;
            result.complete = false;
            break;
        }
        result.files.push(SourceFile {
            path: entry.path().to_path_buf(),
            language: language.to_owned(),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }
    result
}

fn is_artifact(language: &str) -> bool {
    matches!(language, "json" | "yaml" | "toml" | "markdown")
}

fn is_ignored(entry: &DirEntry, ignored: &HashSet<&str>) -> bool {
    entry.file_type().is_dir()
        && entry.file_name().to_str().map(|name| ignored.contains(name)).unwrap_or(false)
}

pub fn modified_ms(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::walk_project;
    use crate::config::IndexOptions;

    #[test]
    fn file_cap_marks_walk_incomplete() {
        let root = std::env::temp_dir().join(format!("syntee-sidecar-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("one.rs"), "fn one() {}").unwrap();
        std::fs::write(root.join("two.rs"), "fn two() {}").unwrap();
        let options = IndexOptions { max_files: 1, ..IndexOptions::default() };
        let result = walk_project(&root, &options);
        assert!(result.hit_cap);
        assert!(!result.complete);
        assert!(!result.had_errors);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn directories_after_file_cap_do_not_mark_walk_incomplete() {
        let root =
            std::env::temp_dir().join(format!("syntee-sidecar-walk-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("z-dir")).unwrap();
        std::fs::write(root.join("a.rs"), "fn one() {}").unwrap();
        let options = IndexOptions { max_files: 1, ..IndexOptions::default() };
        let result = walk_project(&root, &options);
        assert_eq!(result.files.len(), 1);
        assert!(!result.hit_cap);
        assert!(result.complete);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn source_files_get_priority_over_earlier_sorted_json_assets() {
        let root =
            std::env::temp_dir().join(format!("syntee-sidecar-priority-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("assets/minecraft/lang")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("assets/minecraft/lang/a.json"), "{\"hello\":\"world\"}").unwrap();
        std::fs::write(root.join("src/RenderPipeline.java"), "class RenderPipeline {}").unwrap();

        let options = IndexOptions { max_files: 1, ..IndexOptions::default() };
        let result = walk_project(&root, &options);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].path.file_name().unwrap(), "RenderPipeline.java");
        assert!(result.hit_cap);
        assert!(!result.complete);
        let _ = std::fs::remove_dir_all(root);
    }
}
