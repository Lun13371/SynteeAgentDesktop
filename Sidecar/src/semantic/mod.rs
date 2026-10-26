//! Semantic-подсистема: E5-эмбеддинги памяти.
//!
//! Перенесена из TS (`src/core/memory/semanticIndex.ts`) целиком: индексация
//! пяти источников recall_memory в таблицу `semantic_embeddings` и cosine-поиск
//! по ним.
//!
//! Причина переезда — ONNX-инференс в main-процессе блокировал event loop
//! кусками по ~400 мс (замер 26.10.2026: 1.7 ядра, eventLoopP95 400+ мс), из-за
//! чего фризил весь UI. В отдельном процессе это физически невозможно.
//!
//! Раскладка:
//!   - `embed`  — загрузка модели, токенизация, инференс, pooling;
//!   - `store`  — доступ к `syntee.db` (WAL + busy_timeout);
//!   - `index`  — фоновый цикл индексации источников;
//!   - `search` — cosine-ранжирование со scope/kind-фильтрами;
//!   - `types`  — источники, статистика, форма выдачи.

pub mod embed;
pub mod index;
pub mod search;
pub mod store;
pub mod types;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::common::error::{Result, SidecarError};

pub use embed::{E5Embedder, E5_DIM, E5_MODEL, E5_MODEL_TAG};
pub use index::{run_cycle, CycleReport, IndexRunOptions};
pub use search::{search, SearchOptions};
pub use types::{SemanticHit, SemanticSource};

/// «Пользователь сейчас работает» — общий флаг для фоновых задач sidecar.
///
/// Выставляется командой `foregroundBusy` (её же использует watcher файлового
/// индекса). Пока флаг поднят, semantic-индексация спит: раньше она этого не
/// делала и выжирала CPU прямо во время набора текста.
static FOREGROUND_BUSY: AtomicBool = AtomicBool::new(false);

/// Обновляет флаг занятости.
pub fn set_foreground_busy(busy: bool) {
    FOREGROUND_BUSY.store(busy, Ordering::Relaxed);
}

/// Текущее значение флага.
pub fn foreground_busy() -> bool {
    FOREGROUND_BUSY.load(Ordering::Relaxed)
}

/// Кэш загруженной модели: путь → эмбеддер.
///
/// Загрузка ONNX-сессии занимает сотни миллисекунд и ~113 МБ RSS, поэтому
/// модель грузится один раз на процесс и переиспользуется всеми вызовами
/// (индексация + поиск). Смена пути (другая версия модели) перезагружает её.
static EMBEDDER: OnceLock<Mutex<Option<(PathBuf, Arc<E5Embedder>)>>> = OnceLock::new();

fn embedder_slot() -> &'static Mutex<Option<(PathBuf, Arc<E5Embedder>)>> {
    EMBEDDER.get_or_init(|| Mutex::new(None))
}

/// Возвращает загруженный эмбеддер, загружая модель при первом обращении.
pub fn embedder(model_path: &Path, tokenizer_path: &Path) -> Result<Arc<E5Embedder>> {
    let mut slot = embedder_slot()
        .lock()
        .map_err(|_| SidecarError::Model("embedder cache poisoned".to_owned()))?;
    if let Some((cached_path, cached)) = slot.as_ref() {
        if cached_path == model_path {
            return Ok(Arc::clone(cached));
        }
    }
    let loaded = Arc::new(E5Embedder::load(model_path, tokenizer_path)?);
    *slot = Some((model_path.to_path_buf(), Arc::clone(&loaded)));
    Ok(loaded)
}

/// Освобождает модель (например, по команде `semanticUnload`).
pub fn unload_embedder() {
    if let Ok(mut slot) = embedder_slot().lock() {
        *slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_flag_roundtrip() {
        set_foreground_busy(true);
        assert!(foreground_busy());
        set_foreground_busy(false);
        assert!(!foreground_busy());
    }

    #[test]
    fn missing_model_reports_model_error() {
        match E5Embedder::load(Path::new("nope.onnx"), Path::new("nope.json")) {
            Ok(_) => panic!("loading a missing model must fail"),
            Err(error) => assert!(matches!(error, SidecarError::Model(_))),
        }
    }
}
