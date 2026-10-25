use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::ast;
use crate::config::IndexOptions;
use crate::db::{Database, UpsertEntry};
use crate::error::{Result, SidecarError};
use crate::hashing::quick_hash;
use crate::search::{self, SearchOptions, SearchResult};
use crate::symbols::{self, FileSymbols};
use crate::walker::{self, walk_project, SourceFile};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub files_found: usize,
    pub files_changed: usize,
    pub files_removed: usize,
    pub hit_cap: bool,
    pub complete: bool,
    pub had_errors: bool,
    /// The pass was skipped because the index was still fresh (`maxAgeMs`).
    pub skipped: bool,
}

/// Parse one file with the best available backend.
///
/// Native tree-sitter where a grammar exists, the lexical scanner for formats no
/// Rust grammar covers (markdown, yaml, toml). Keeping this in one place is what
/// makes the *index* use tree-sitter too — before, only the on-demand `symbols`
/// command did, while everything the search ranked came from the lexical scanner.
pub fn parse_symbols(source: &str, language: &str, skip_references: bool) -> FileSymbols {
    match ast::extract(source, language, skip_references) {
        Some(symbols) => symbols,
        None => symbols::extract_symbols(source, language, skip_references),
    }
}

struct PendingFile {
    file: SourceFile,
    relative_path: String,
    hash: u32,
    symbols: FileSymbols,
}

/// A changed file that still has to be read and parsed.
struct RawPending {
    file: SourceFile,
    relative_path: String,
    hash: u32,
}

/// Parse changed files in parallel.
///
/// Switching the index to tree-sitter means a full AST per file, which made a
/// cold index of a thousand files a multi-second operation when done inline.
/// Parsing is pure CPU work with no shared state, so it scales with cores; each
/// worker thread keeps its own parser via the thread-local cache in `ast`.
/// Returns the parsed files plus whether any read failed.
fn parse_parallel(files: Vec<RawPending>, skip_references: bool) -> (Vec<PendingFile>, bool) {
    if files.is_empty() {
        return (Vec::new(), false);
    }
    let workers = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(4)
        .clamp(1, 8)
        .min(files.len());

    let parse_one = |item: &RawPending| -> Option<PendingFile> {
        let source = fs::read_to_string(&item.file.path).ok()?;
        Some(PendingFile {
            file: item.file.clone(),
            relative_path: item.relative_path.clone(),
            hash: item.hash,
            symbols: parse_symbols(&source, &item.file.language, skip_references),
        })
    };

    let mut ordered: Vec<(usize, Option<PendingFile>)> = if workers == 1 {
        files.iter().enumerate().map(|(index, item)| (index, parse_one(item))).collect()
    } else {
        let chunk_size = files.len().div_ceil(workers);
        let chunks: Vec<Vec<(usize, Option<PendingFile>)>> = std::thread::scope(|scope| {
            let handles: Vec<_> = files
                .chunks(chunk_size)
                .enumerate()
                .map(|(chunk_index, chunk)| {
                    scope.spawn(move || {
                        chunk
                            .iter()
                            .enumerate()
                            .map(|(offset, item)| {
                                (chunk_index * chunk_size + offset, parse_one(item))
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles.into_iter().map(|handle| handle.join().unwrap_or_default()).collect()
        });
        chunks.into_iter().flatten().collect()
    };

    ordered.sort_by_key(|(index, _)| *index);
    let mut had_errors = false;
    let mut parsed = Vec::with_capacity(files.len());
    for (_, item) in ordered {
        match item {
            Some(pending) => parsed.push(pending),
            None => had_errors = true,
        }
    }
    (parsed, had_errors)
}

pub struct Indexer {
    database: Database,
}

impl Indexer {
    pub fn open(db_path: &Path) -> Result<Self> {
        Ok(Self { database: Database::open(db_path)? })
    }

    /// Full pass.
    ///
    /// `max_age_ms` makes the pass a no-op when the index was written recently:
    /// `get_fast_context` used to re-walk the entire project on every call even
    /// though the watcher keeps the index current.
    pub fn index(
        &self,
        project_id: &str,
        workdir: &Path,
        options: &IndexOptions,
        max_age_ms: u64,
    ) -> Result<IndexResult> {
        if !workdir.is_dir() {
            return Err(SidecarError::InvalidRequest(format!(
                "workdir is not a directory: {}",
                workdir.display()
            )));
        }
        if max_age_ms > 0 {
            let last = self.database.last_index_ms(project_id)?;
            if last > 0 && now_ms().saturating_sub(last) < max_age_ms as i64 {
                return Ok(IndexResult {
                    files_found: self.database.count(project_id)?,
                    files_changed: 0,
                    files_removed: 0,
                    hit_cap: false,
                    complete: true,
                    had_errors: false,
                    skipped: true,
                });
            }
        }

        let walk = walk_project(workdir, options);
        let snapshot = self.database.snapshot(project_id)?;
        let mut seen: HashSet<String> = HashSet::with_capacity(walk.files.len());
        let mut raw: Vec<RawPending> = Vec::new();
        let mut had_errors = walk.had_errors;

        for file in &walk.files {
            let path = file.path.to_string_lossy().to_string();
            seen.insert(path.clone());
            let previous = snapshot.get(&path).copied();
            // Unchanged timestamp and size: skip without opening the file at all.
            if previous.is_some_and(|previous| {
                previous.size == file.size && previous.mtime == file.modified_ms
            }) {
                continue;
            }
            let hash = quick_hash(&file.path, file.size);
            // Same content, new timestamp (touch/checkout): only the mtime moves.
            if previous
                .is_some_and(|previous| previous.size == file.size && previous.content_hash == hash)
            {
                self.database.touch(project_id, &path, file.modified_ms)?;
                continue;
            }
            raw.push(RawPending {
                file: file.clone(),
                relative_path: walker::relative_path(workdir, &file.path),
                hash,
            });
        }

        let (pending, read_errors) = parse_parallel(raw, options.skip_references);
        had_errors |= read_errors;

        let maintain_fts = self.database.fts_ready(project_id)?;
        {
            let entries: Vec<UpsertEntry<'_>> = pending
                .iter()
                .map(|item| UpsertEntry {
                    file: &item.file,
                    relative_path: &item.relative_path,
                    hash: item.hash,
                    symbols: &item.symbols,
                })
                .collect();
            self.database.upsert_files(project_id, &entries, maintain_fts)?;
        }

        let files_removed = if walk.complete && !had_errors {
            self.database.delete_missing(project_id, &seen)?
        } else if walk.hit_cap && !had_errors {
            // A cap is a deterministic subset. Stale artifact rows from earlier
            // runs must not survive it, otherwise JSON/localization noise keeps
            // competing with the freshly prioritized source files.
            self.database.delete_missing_artifacts(project_id, &seen)?
        } else {
            0
        };

        if !pending.is_empty() || files_removed > 0 {
            self.database.recompute_rank(project_id)?;
        }
        self.database.mark_indexed(project_id, walk.files.len())?;
        // A project that grew past the scan threshold gets its FTS mirror built
        // once; smaller ones keep relying on the full scan.
        self.database.enable_fts_if_large(project_id)?;

        Ok(IndexResult {
            files_found: walk.files.len(),
            files_changed: pending.len(),
            files_removed,
            hit_cap: walk.hit_cap,
            complete: walk.complete && !had_errors,
            had_errors,
            skipped: false,
        })
    }

    /// Incremental pass for the paths a watcher reported.
    pub fn index_changed_paths(
        &self,
        project_id: &str,
        workdir: &Path,
        changed_paths: &[PathBuf],
        options: &IndexOptions,
    ) -> Result<IndexResult> {
        let mut files_removed = 0usize;
        let mut had_errors = false;
        let mut targets: Vec<PathBuf> = Vec::new();
        let mut seen_dirs: HashSet<PathBuf> = HashSet::new();

        for path in changed_paths {
            let normalized = if path.is_absolute() { path.clone() } else { workdir.join(path) };
            // `canonicalize` returns a `\\?\` path on Windows; storing that form
            // would duplicate every row the full walk wrote under the plain path.
            let path =
                walker::strip_verbatim_prefix(&normalized.canonicalize().unwrap_or(normalized));
            if !walker::is_under(workdir, &path) {
                continue;
            }
            // The full walk honours ignore_dirs; the incremental path used to
            // index dist/ and node_modules/ edits that the walk deliberately skips.
            if walker::is_in_ignored_dir(&path, workdir, &options.ignore_dirs) {
                continue;
            }
            if path.is_dir() {
                // A directory that appeared while watching: index what is inside.
                if seen_dirs.insert(path.clone()) {
                    for file in walker::walk_subtree(&path, options) {
                        targets.push(file.path);
                    }
                }
                continue;
            }
            if !path.exists() {
                let path_string = path.to_string_lossy().to_string();
                if self.database.delete_file(project_id, &path_string)? {
                    files_removed += 1;
                }
                // A removed directory arrives as one event for the directory
                // itself; its rows have to go too.
                files_removed += self.database.delete_prefix(project_id, &path_string)?;
                continue;
            }
            targets.push(path);
        }

        targets.sort();
        targets.dedup();

        let snapshot = self.database.snapshot(project_id)?;
        let mut raw: Vec<RawPending> = Vec::new();
        let mut files_found = 0usize;

        for path in targets {
            let Some(language) = crate::language::language_for_path(&path) else { continue };
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    had_errors = true;
                    eprintln!("[syntee-sidecar] metadata failed for {}: {error}", path.display());
                    continue;
                }
            };
            if metadata.len() > options.max_file_size_kb.saturating_mul(1024) {
                continue;
            }
            files_found += 1;
            let path_string = path.to_string_lossy().to_string();
            let modified_ms = walker::modified_ms(&metadata);
            let previous = snapshot.get(&path_string).copied();
            if previous.is_some_and(|previous| {
                previous.size == metadata.len() && previous.mtime == modified_ms
            }) {
                continue;
            }
            let hash = quick_hash(&path, metadata.len());
            if previous.is_some_and(|previous| {
                previous.size == metadata.len() && previous.content_hash == hash
            }) {
                self.database.touch(project_id, &path_string, modified_ms)?;
                continue;
            }
            raw.push(RawPending {
                file: SourceFile {
                    path: path.clone(),
                    language: language.to_owned(),
                    size: metadata.len(),
                    modified_ms,
                },
                relative_path: walker::relative_path(workdir, &path),
                hash,
            });
        }

        let (pending, read_errors) = parse_parallel(raw, options.skip_references);
        had_errors |= read_errors;

        {
            let entries: Vec<UpsertEntry<'_>> = pending
                .iter()
                .map(|item| UpsertEntry {
                    file: &item.file,
                    relative_path: &item.relative_path,
                    hash: item.hash,
                    symbols: &item.symbols,
                })
                .collect();
            let maintain_fts = self.database.fts_ready(project_id)?;
            self.database.upsert_files(project_id, &entries, maintain_fts)?;
        }
        if !pending.is_empty() || files_removed > 0 {
            self.database.recompute_rank(project_id)?;
        }
        self.database.enable_fts_if_large(project_id)?;

        Ok(IndexResult {
            files_found,
            files_changed: pending.len(),
            files_removed,
            hit_cap: false,
            complete: !had_errors,
            had_errors,
            skipped: false,
        })
    }

    /// Two-phase search: rank without touching `symbols_json`, then load
    /// definitions for the winning files only.
    pub fn search(
        &self,
        project_id: &str,
        query: &str,
        options: &SearchOptions,
    ) -> Result<SearchResult> {
        let rows = self.database.scan_rows(project_id)?;
        let indexed_files_count = rows.len();
        // Large projects narrow the candidate set with FTS first; small ones just
        // scan, which is both faster and higher-recall. `None` = scan.
        let candidates = self.database.fts_candidates(project_id, &search::fts_terms(query));
        let rows = match candidates {
            Some(paths) => {
                let wanted: HashSet<String> = paths.into_iter().collect();
                rows.into_iter().filter(|row| wanted.contains(&row.file_path)).collect::<Vec<_>>()
            }
            None => rows,
        };
        let ranked = search::rank(&rows, query, options.max_files);
        let paths: Vec<String> = ranked.files.iter().map(|file| file.path.clone()).collect();
        let definitions = self.database.definitions_for(project_id, &paths)?;
        let mut result = search::assemble(&rows, &definitions, &ranked, options);
        result.indexed_files_count = indexed_files_count;
        Ok(result)
    }

    pub fn count(&self, project_id: &str) -> Result<usize> {
        self.database.count(project_id)
    }

    pub fn clear(&self, project_id: &str) -> Result<usize> {
        self.database.clear(project_id)
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}
