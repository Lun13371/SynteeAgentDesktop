use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::IndexOptions;
use crate::db::Database;
use crate::error::{Result, SidecarError};
use crate::hashing::quick_hash;
use crate::search::{search, SearchOptions, SearchResult};
use crate::symbols::extract_symbols;
use crate::walker::walk_project;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub files_found: usize,
    pub files_changed: usize,
    pub files_removed: usize,
    pub hit_cap: bool,
    pub complete: bool,
    pub had_errors: bool,
}

pub struct Indexer {
    database: Database,
}

impl Indexer {
    pub fn open(db_path: &Path) -> Result<Self> {
        Ok(Self { database: Database::open(db_path)? })
    }

    pub fn index(
        &self,
        project_id: &str,
        workdir: &Path,
        options: &IndexOptions,
    ) -> Result<IndexResult> {
        if !workdir.is_dir() {
            return Err(SidecarError::InvalidRequest(format!(
                "workdir is not a directory: {}",
                workdir.display()
            )));
        }
        let mut walk = walk_project(workdir, options);
        let mut changed = 0;
        let mut seen = HashSet::with_capacity(walk.files.len());
        for file in &walk.files {
            let path = file.path.to_string_lossy().to_string();
            seen.insert(path.clone());
            let hash = quick_hash(&file.path, file.size);
            if self
                .database
                .existing_hash(project_id, &path)?
                .is_some_and(|(size, old_hash)| size == file.size && old_hash == hash)
            {
                continue;
            }
            let source = match fs::read_to_string(&file.path) {
                Ok(source) => source,
                Err(_) => {
                    walk.had_errors = true;
                    walk.complete = false;
                    continue;
                }
            };
            let symbols = extract_symbols(&source, &file.language, options.skip_references);
            self.database.upsert_file(project_id, file, hash, &symbols)?;
            changed += 1;
        }
        let files_removed = if walk.complete && !walk.had_errors {
            self.database.delete_missing(project_id, &seen.iter().cloned().collect::<Vec<_>>())?
        } else if walk.hit_cap && !walk.had_errors {
            // A cap is a deterministic subset. Stale artifact rows from earlier
            // runs must not survive it, otherwise JSON/localization noise keeps
            // competing with the freshly prioritized source files.
            self.database
                .delete_missing_artifacts(project_id, &seen.iter().cloned().collect::<Vec<_>>())?
        } else {
            0
        };
        Ok(IndexResult {
            files_found: walk.files.len(),
            files_changed: changed,
            files_removed,
            hit_cap: walk.hit_cap,
            complete: walk.complete,
            had_errors: walk.had_errors,
        })
    }

    pub fn index_changed_paths(
        &self,
        project_id: &str,
        workdir: &Path,
        changed_paths: &[PathBuf],
        options: &IndexOptions,
    ) -> Result<IndexResult> {
        let mut files_changed = 0;
        let mut files_removed = 0;
        let mut had_errors = false;
        let mut files_found = 0;
        let mut seen = HashSet::new();
        for path in changed_paths {
            let normalized = if path.is_absolute() { path.clone() } else { workdir.join(path) };
            let path = normalized.canonicalize().unwrap_or(normalized);
            let path_string = path.to_string_lossy().to_string();
            if !path.starts_with(workdir) {
                continue;
            }
            if path.is_dir() {
                continue;
            }
            if !path.exists() {
                if self.database.delete_file(project_id, &path_string)? {
                    files_removed += 1;
                }
                continue;
            }
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
            let source = match fs::read_to_string(&path) {
                Ok(source) => source,
                Err(error) => {
                    had_errors = true;
                    eprintln!("[syntee-sidecar] read failed for {}: {error}", path.display());
                    continue;
                }
            };
            let source_file = crate::walker::SourceFile {
                path: path.clone(),
                language: language.to_owned(),
                size: metadata.len(),
                modified_ms: crate::walker::modified_ms(&metadata),
            };
            let hash = quick_hash(&path, metadata.len());
            if self
                .database
                .existing_hash(project_id, &path_string)?
                .is_some_and(|(size, old_hash)| size == metadata.len() && old_hash == hash)
            {
                continue;
            }
            let symbols = extract_symbols(&source, language, options.skip_references);
            self.database.upsert_file(project_id, &source_file, hash, &symbols)?;
            seen.insert(path_string);
            files_changed += 1;
        }
        Ok(IndexResult {
            files_found,
            files_changed,
            files_removed,
            hit_cap: false,
            complete: !had_errors,
            had_errors,
        })
    }

    pub fn search(
        &self,
        project_id: &str,
        query: &str,
        options: &SearchOptions,
    ) -> Result<SearchResult> {
        Ok(search(&self.database.rows(project_id)?, query, options))
    }

    pub fn count(&self, project_id: &str) -> Result<usize> {
        self.database.count(project_id)
    }

    pub fn clear(&self, project_id: &str) -> Result<usize> {
        self.database.clear(project_id).map_err(Into::into)
    }
}
