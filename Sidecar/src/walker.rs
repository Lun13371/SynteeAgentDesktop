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

/// One traversal, then a priority sort.
///
/// The previous implementation walked the whole tree twice — once for source
/// files and once for artifacts — so that source files could claim the cap
/// first. Collecting both in a single pass and ordering afterwards halves the
/// syscall count on every index request, which is what a warm re-index spends
/// most of its time on.
pub fn walk_project(root: &Path, options: &IndexOptions) -> WalkResult {
    let ignored: HashSet<&str> = options.ignore_dirs.iter().map(String::as_str).collect();
    let max_bytes = options.max_file_size_kb.saturating_mul(1024);

    let mut source = Vec::new();
    let mut artifacts = Vec::new();
    let mut had_errors = false;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(DEFAULT_MAX_DEPTH + 1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| !is_ignored(entry, &ignored));

    for item in walker {
        let entry = match item {
            Ok(entry) => entry,
            Err(_) => {
                had_errors = true;
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(language) = language_for_path(entry.path()) else { continue };
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                had_errors = true;
                continue;
            }
        };
        if metadata.len() > max_bytes {
            continue;
        }
        let file = SourceFile {
            path: entry.path().to_path_buf(),
            language: language.to_owned(),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
        };
        if is_artifact(language) || is_generated(entry.path()) {
            artifacts.push(file);
        } else {
            source.push(file);
        }
    }

    let total = source.len() + artifacts.len();
    let hit_cap = total > options.max_files;
    let mut files = source;
    files.extend(artifacts);
    if hit_cap {
        files.truncate(options.max_files);
    }
    WalkResult { files, hit_cap, complete: !hit_cap && !had_errors, had_errors }
}

/// Walk one subtree (a directory that appeared while the watcher was running).
pub fn walk_subtree(root: &Path, options: &IndexOptions) -> Vec<SourceFile> {
    let ignored: HashSet<&str> = options.ignore_dirs.iter().map(String::as_str).collect();
    let max_bytes = options.max_file_size_kb.saturating_mul(1024);
    let mut files = Vec::new();
    let walker = WalkDir::new(root)
        .follow_links(false)
        .max_depth(DEFAULT_MAX_DEPTH + 1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| !is_ignored(entry, &ignored));
    for item in walker {
        let Ok(entry) = item else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Some(language) = language_for_path(entry.path()) else { continue };
        let Ok(metadata) = entry.metadata() else { continue };
        if metadata.len() > max_bytes {
            continue;
        }
        files.push(SourceFile {
            path: entry.path().to_path_buf(),
            language: language.to_owned(),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
        if files.len() >= options.max_files {
            break;
        }
    }
    files
}

/// Drop the Windows extended-length prefix (`\\?\C:\…`, `\\?\UNC\server\…`).
///
/// `canonicalize` returns that form, which does not compare equal to the plain
/// path a directory walk produces. Mixing the two made every prefix check in the
/// incremental path fail silently — and would have stored duplicate index rows.
pub fn strip_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

/// Is `path` inside `workdir`? Case-insensitive and prefix-agnostic.
pub fn is_under(workdir: &Path, path: &Path) -> bool {
    let left = strip_verbatim_prefix(workdir);
    let right = strip_verbatim_prefix(path);
    let mut left_components = left.components();
    for component in right.components() {
        match left_components.next() {
            Some(expected) => {
                let expected = expected.as_os_str().to_string_lossy().to_lowercase();
                let actual = component.as_os_str().to_string_lossy().to_lowercase();
                if expected != actual {
                    return false;
                }
            }
            None => return true,
        }
    }
    left_components.next().is_none()
}

/// True when any component of `path` below `workdir` is an ignored directory.
pub fn is_in_ignored_dir(path: &Path, workdir: &Path, ignore_dirs: &[String]) -> bool {
    if !is_under(workdir, path) {
        return false;
    }
    strip_verbatim_prefix(path).components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|name| ignore_dirs.iter().any(|ignored| ignored == name))
            .unwrap_or(false)
    })
}

/// Build the path stored in `search_path`: relative to the workdir, so every
/// file does not share the same useless absolute prefix.
pub fn relative_path(workdir: &Path, path: &Path) -> String {
    let workdir = strip_verbatim_prefix(workdir);
    let path = strip_verbatim_prefix(path);
    path.strip_prefix(&workdir).unwrap_or(&path).to_string_lossy().replace('\\', "/")
}

fn is_artifact(language: &str) -> bool {
    matches!(language, "json" | "yaml" | "toml" | "markdown")
}

/// Generated files that would otherwise flood the source list: declaration
/// bundles, minified builds and source maps carry no information a reader needs.
fn is_generated(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else { return false };
    let name = name.to_ascii_lowercase();
    name.ends_with(".d.ts")
        || name.ends_with(".min.js")
        || name.ends_with(".min.css")
        || name.ends_with(".map")
        || name.ends_with(".generated.ts")
        || name.ends_with(".g.dart")
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
    use super::{is_in_ignored_dir, is_under, strip_verbatim_prefix, walk_project, walk_subtree};
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

    #[test]
    fn generated_declaration_bundles_are_not_source_files() {
        let root =
            std::env::temp_dir().join(format!("syntee-sidecar-generated-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("chat.store.d.ts"), "export declare const x: number").unwrap();
        std::fs::write(root.join("chat.store.ts"), "export const x = 1").unwrap();
        let options = IndexOptions { max_files: 10, ..IndexOptions::default() };
        let result = walk_project(&root, &options);
        assert_eq!(result.files.len(), 2);
        // The declaration bundle sorts last so a cap drops it first.
        assert_eq!(result.files[0].path.file_name().unwrap(), "chat.store.ts");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn ignored_directories_are_skipped_by_the_walk() {
        let root =
            std::env::temp_dir().join(format!("syntee-sidecar-ignore-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "module.exports = 1").unwrap();
        std::fs::write(root.join("src/app.ts"), "export const app = 1").unwrap();
        let options = IndexOptions::default();
        let result = walk_project(&root, &options);
        assert_eq!(result.files.len(), 1);
        assert!(
            result.files[0].path.ends_with("src/app.ts")
                || result.files[0].path.ends_with("src\\app.ts")
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn verbatim_prefixes_and_containment_survive_canonicalize() {
        let plain = std::path::Path::new(r"C:\Projects\SynteeAgentDesktop");
        let verbatim =
            std::path::Path::new(r"\\?\C:\Projects\SynteeAgentDesktop\src\main\index.ts");
        assert_eq!(
            strip_verbatim_prefix(verbatim).to_string_lossy(),
            r"C:\Projects\SynteeAgentDesktop\src\main\index.ts"
        );
        // The case that used to fail: canonicalized path vs plain workdir.
        assert!(is_under(plain, verbatim));
        assert!(is_under(plain, plain));
        assert!(!is_under(plain, std::path::Path::new(r"C:\Other\proj\a.ts")));
        assert!(!is_under(std::path::Path::new(r"C:\Projects\SynteeAgentDesktop\src"), plain));
    }

    #[test]
    fn subtree_walk_and_ignored_dir_detection() {
        let root =
            std::env::temp_dir().join(format!("syntee-sidecar-subtree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::create_dir_all(root.join("feature")).unwrap();
        std::fs::write(root.join("dist/bundle.js"), "1").unwrap();
        std::fs::write(root.join("feature/a.ts"), "export const a = 1").unwrap();
        std::fs::write(root.join("feature/b.ts"), "export const b = 1").unwrap();
        let options = IndexOptions::default();
        let files = walk_subtree(&root.join("feature"), &options);
        assert_eq!(files.len(), 2);
        assert!(is_in_ignored_dir(&root.join("dist/bundle.js"), &root, &options.ignore_dirs));
        assert!(!is_in_ignored_dir(&root.join("feature/a.ts"), &root, &options.ignore_dirs));
        let _ = std::fs::remove_dir_all(root);
    }
}
