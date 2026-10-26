use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::{json, Value};

use crate::common::config::IndexOptions;
use crate::common::error::{Result, SidecarError};
use crate::fast_context::indexer::Indexer;

const DEBOUNCE: Duration = Duration::from_millis(250);
const POLL: Duration = Duration::from_millis(100);

#[derive(Default)]
struct WatchState {
    active: bool,
    foreground_busy: bool,
    workdir: Option<PathBuf>,
    project_id: Option<String>,
    db_path: Option<PathBuf>,
    pending_paths: usize,
    last_error: Option<String>,
    files_changed: usize,
    files_removed: usize,
    batches: usize,
}

struct WatcherInner {
    state: WatchState,
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

#[derive(Clone)]
pub struct WatchManager {
    inner: Arc<Mutex<WatcherInner>>,
}

impl Default for WatchManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(WatcherInner {
                state: WatchState::default(),
                stop: None,
                thread: None,
            })),
        }
    }

    pub fn start(
        &self,
        db_path: PathBuf,
        project_id: String,
        workdir: PathBuf,
        options: IndexOptions,
    ) -> Result<Value> {
        self.stop()?;
        let workdir = std::fs::canonicalize(&workdir).map_err(|error| {
            SidecarError::InvalidRequest(format!("workdir is not accessible: {error}"))
        })?;
        if !workdir.is_dir() {
            return Err(SidecarError::InvalidRequest(format!(
                "workdir is not a directory: {}",
                workdir.display()
            )));
        }
        let (stop_tx, stop_rx) = mpsc::channel();
        let state = Arc::clone(&self.inner);
        let thread_workdir = workdir.clone();
        let thread_project_id = project_id.clone();
        // Publish state before spawning: a fast watcher initialization error must
        // not be overwritten by the caller after `mark_inactive` runs.
        {
            let mut inner = self.inner.lock().expect("watcher state poisoned");
            inner.state = WatchState {
                active: true,
                workdir: Some(workdir.clone()),
                project_id: Some(project_id.clone()),
                db_path: Some(db_path.clone()),
                ..WatchState::default()
            };
            inner.stop = Some(stop_tx);
        }
        let thread = match thread::Builder::new().name("syntee-sidecar-watcher".to_owned()).spawn(
            move || {
                run_watcher(state, stop_rx, db_path, thread_project_id, thread_workdir, options);
            },
        ) {
            Ok(thread) => thread,
            Err(error) => {
                let mut inner = self.inner.lock().expect("watcher state poisoned");
                inner.stop = None;
                inner.state.active = false;
                return Err(SidecarError::Io(std::io::Error::other(error)));
            }
        };
        let mut inner = self.inner.lock().expect("watcher state poisoned");
        inner.thread = Some(thread);
        Ok(self.status_locked(&inner))
    }

    pub fn stop(&self) -> Result<Value> {
        let (stop, thread) = {
            let mut inner = self.inner.lock().expect("watcher state poisoned");
            (inner.stop.take(), inner.thread.take())
        };
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        if let Some(thread) = thread {
            let _ = thread.join();
        }
        let mut inner = self.inner.lock().expect("watcher state poisoned");
        inner.state.active = false;
        inner.state.pending_paths = 0;
        Ok(self.status_locked(&inner))
    }

    pub fn shutdown(&self) -> Result<()> {
        self.stop().map(|_| ())
    }

    pub fn foreground_busy(&self, busy: bool) -> Value {
        let mut inner = self.inner.lock().expect("watcher state poisoned");
        inner.state.foreground_busy = busy;
        self.status_locked(&inner)
    }

    pub fn status(&self) -> Value {
        let (mut status, db_path, project_id) = {
            let inner = self.inner.lock().expect("watcher state poisoned");
            (
                self.status_locked(&inner),
                inner.state.db_path.clone(),
                inner.state.project_id.clone(),
            )
        };
        // Report the real number of rows in the sidecar index so the UI never
        // claims "0 files" while the Rust index is populated.
        let count = match (db_path, project_id) {
            (Some(db_path), Some(project_id)) => {
                Indexer::open(&db_path).ok().and_then(|indexer| indexer.count(&project_id).ok())
            }
            _ => None,
        };
        status["indexedFilesCount"] = count.map(|value| json!(value)).unwrap_or(Value::Null);
        status
    }

    fn status_locked(&self, inner: &WatcherInner) -> Value {
        json!({
            "active": inner.state.active,
            "foregroundBusy": inner.state.foreground_busy,
            "workdir": inner.state.workdir,
            "projectId": inner.state.project_id,
            "pendingPaths": inner.state.pending_paths,
            "lastError": inner.state.last_error,
            "filesChanged": inner.state.files_changed,
            "filesRemoved": inner.state.files_removed,
            "batches": inner.state.batches,
            "debounceMs": DEBOUNCE.as_millis(),
        })
    }
}

fn run_watcher(
    manager: Arc<Mutex<WatcherInner>>,
    stop_rx: mpsc::Receiver<()>,
    db_path: PathBuf,
    project_id: String,
    workdir: PathBuf,
    options: IndexOptions,
) {
    let (event_tx, event_rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher: RecommendedWatcher = match RecommendedWatcher::new(
        move |event| {
            let _ = event_tx.send(event);
        },
        Config::default().with_poll_interval(Duration::from_millis(200)),
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            record_error(&manager, format!("watcher initialization failed: {error}"));
            mark_inactive(&manager);
            return;
        }
    };
    if let Err(error) = watcher.watch(&workdir, RecursiveMode::Recursive) {
        record_error(&manager, format!("watcher registration failed: {error}"));
        mark_inactive(&manager);
        return;
    }

    let mut pending = HashSet::new();
    let mut last_event = None;
    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match event_rx.recv_timeout(POLL) {
            Ok(Ok(event)) => {
                pending.extend(event.paths);
                last_event = Some(Instant::now());
                update_pending(&manager, pending.len());
            }
            Ok(Err(error)) => record_error(&manager, format!("watcher event error: {error}")),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if !pending.is_empty() && last_event.is_some_and(|time| time.elapsed() >= DEBOUNCE) {
            if is_foreground_busy(&manager) {
                continue;
            }
            let paths: Vec<PathBuf> = pending.drain().collect();
            update_pending(&manager, 0);
            let indexer = match Indexer::open(&db_path) {
                Ok(indexer) => indexer,
                Err(error) => {
                    record_error(&manager, format!("watch index open failed: {error}"));
                    continue;
                }
            };
            match indexer.index_changed_paths(&project_id, &workdir, &paths, &options) {
                Ok(result) => {
                    let mut inner = manager.lock().expect("watcher state poisoned");
                    inner.state.files_changed += result.files_changed;
                    inner.state.files_removed += result.files_removed;
                    inner.state.batches += 1;
                    if result.had_errors {
                        inner.state.last_error = Some(
                            "one or more changed files could not be indexed; existing rows were retained"
                                .to_owned(),
                        );
                    }
                }
                Err(error) => record_error(&manager, format!("watch index failed: {error}")),
            }
            last_event = None;
        }
    }
    mark_inactive(&manager);
}

fn update_pending(manager: &Arc<Mutex<WatcherInner>>, count: usize) {
    let mut inner = manager.lock().expect("watcher state poisoned");
    inner.state.pending_paths = count;
}

fn is_foreground_busy(manager: &Arc<Mutex<WatcherInner>>) -> bool {
    manager.lock().expect("watcher state poisoned").state.foreground_busy
}

fn record_error(manager: &Arc<Mutex<WatcherInner>>, message: String) {
    eprintln!("[syntee-sidecar] {message}");
    let mut inner = manager.lock().expect("watcher state poisoned");
    inner.state.last_error = Some(message);
}

fn mark_inactive(manager: &Arc<Mutex<WatcherInner>>) {
    let mut inner = manager.lock().expect("watcher state poisoned");
    inner.state.active = false;
}

#[allow(dead_code)]
fn path_is_under(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}
