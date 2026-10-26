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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// Когда эмбеддер использовали в последний раз (мс от старта процесса).
static LAST_USE_MS: AtomicU64 = AtomicU64::new(0);

/// Сколько простое считать «модель больше не нужна».
///
/// Замер 26.10.2026: загруженная модель — 399 МБ RSS против 34 МБ без неё.
/// Перезагрузка стоит 1.26 с, поэтому выгружать сразу после ответа нельзя:
/// частые recall_memory платили бы за это каждый раз. Пять минут простоя —
/// хороший компромисс: цикл индексации идёт раз в 15 минут, всплески поиска
/// укладываются в окно, а в настоящем простое память возвращается.
///
/// `SYNTEE_SEMANTIC_IDLE_MS` переопределяет окно — нужно интеграционным тестам,
/// которые не могут ждать пять минут.
const DEFAULT_IDLE_UNLOAD_MS: u64 = 5 * 60 * 1000;

fn idle_unload_ms() -> u64 {
    std::env::var("SYNTEE_SEMANTIC_IDLE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_IDLE_UNLOAD_MS)
}

/// Как часто проверять простой.
const IDLE_CHECK_MS: u64 = 30 * 1000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Отмечает использование модели — сбрасывает таймер простоя.
fn touch_embedder() {
    LAST_USE_MS.store(now_ms(), Ordering::Relaxed);
}

/// Возвращает загруженный эмбеддер, загружая модель при первом обращении.
pub fn embedder(model_path: &Path, tokenizer_path: &Path) -> Result<Arc<E5Embedder>> {
    let mut slot = embedder_slot()
        .lock()
        .map_err(|_| SidecarError::Model("embedder cache poisoned".to_owned()))?;
    if let Some((cached_path, cached)) = slot.as_ref() {
        if cached_path == model_path {
            touch_embedder();
            return Ok(Arc::clone(cached));
        }
    }
    let loaded = Arc::new(E5Embedder::load(model_path, tokenizer_path)?);
    *slot = Some((model_path.to_path_buf(), Arc::clone(&loaded)));
    touch_embedder();
    Ok(loaded)
}

/// Освобождает модель (например, по команде `semanticUnload`).
///
/// Возвращает true, если что-то действительно выгрузили.
pub fn unload_embedder() -> bool {
    let Ok(mut slot) = embedder_slot().lock() else {
        return false;
    };
    let had_model = slot.is_some();
    *slot = None;
    LAST_USE_MS.store(0, Ordering::Relaxed);
    had_model
}

/// Есть ли сейчас загруженная модель (для статуса/диагностики).
pub fn embedder_loaded() -> bool {
    embedder_slot()
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false)
}

/// Запускает фоновый сторож, выгружающий модель после [`IDLE_UNLOAD_MS`].
///
/// Живёт в отдельном потоке: проверять простой на reader-потоке протокола
/// значит поставить выгрузку в очередь за 60-секундным циклом индексации.
pub fn start_idle_unloader() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("sidecar-idle-unload".to_owned())
        .spawn(|| {
            let idle_ms = idle_unload_ms();
            // Проверяем чаще окна, но не чаще раза в секунду — иначе короткое
            // окно (в тестах) не успевало бы сработать.
            let check_ms = IDLE_CHECK_MS.min(idle_ms.max(1_000) / 4).max(200);
            loop {
                std::thread::sleep(std::time::Duration::from_millis(check_ms));
                let last = LAST_USE_MS.load(Ordering::Relaxed);
                if last == 0 {
                    continue;
                }
                // Не выгружаем то, что прямо сейчас считается: инференс держит
                // Arc на эмбеддер, но окно простоя всё равно должно пройти.
                if now_ms().saturating_sub(last) < idle_ms {
                    continue;
                }
                if unload_embedder() {
                    eprintln!(
                        "[semantic] model unloaded after {}s idle (freed ~365 MB)",
                        idle_ms / 1000
                    );
                }
            }
        });
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
