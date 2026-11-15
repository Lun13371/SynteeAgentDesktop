//! E5-эмбеддинги: ONNX-инференс (`ort`) + XLM-R токенизация (`tokenizers`).
//!
//! Паритет с JS-эталоном (`@huggingface/transformers`, `feature-extraction`):
//!   - текст подаётся как `"{prefix}: {text}"` (E5 обучена с этими префиксами);
//!   - токенизация тем же `tokenizer.json` со special-токенами, truncate 512;
//!   - входы `input_ids` / `attention_mask` / `token_type_ids` (нули);
//!   - pooling `mean` по attention_mask, затем L2-нормализация.
//!
//! Любое расхождение здесь означает несовместимость векторов с уже
//! проиндексированными — поэтому паритет закреплён тестом
//! `tests/semantic-parity.test.cjs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use ort::environment::Environment;
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::Tokenizer;

use crate::common::error::{Result, SidecarError};

/// Размерность E5-вектора (multilingual-e5-small).
pub const E5_DIM: usize = 384;
/// Идентификатор модели в HuggingFace-кэше.
pub const E5_MODEL: &str = "Xenova/multilingual-e5-small";
/// Точность весов: q8 → `model_quantized.onnx` (~113 МБ вместо 448 МБ fp32).
pub const E5_DTYPE: &str = "q8";
/// Тег для колонки `semantic_embeddings.model`.
///
/// Отдельный от JS-тега `@q8`: он фиксирует, ЧЕМ посчитан вектор. Даже при
/// идеальном паритете смешивать индексы разных реализаций нельзя — при
/// малейшем расхождении поиск тихо деградирует вместо явной ошибки.
pub const E5_MODEL_TAG: &str = "Xenova/multilingual-e5-small@q8-rust";

/// Потоки ONNX. Два — как было в JS-пайплайне (`intraOpNumThreads: 2`).
///
/// ⚠️ По умолчанию onnxruntime берёт потоков столько же, сколько ядер, и
/// фоновая индексация выжирала до 5 ядер (cpuUserMs 489% в 10-секундном
/// сэмпле). Фоновая задаче не нужен весь CPU: он нужен интерфейсу.
const INTRA_OP_THREADS: usize = 2;
const INTER_OP_THREADS: usize = 1;

/// Потоки эмбеддера переопределяются средой SYNTEE_SEMANTIC_THREADS (1..16).
/// Sidecar спавнится из TS со значением 4: догрев карты идёт заметно быстрее,
/// а политика «уступить foreground» остаётся на стороне планировщика TS.
fn semantic_intra_threads() -> usize {
    std::env::var("SYNTEE_SEMANTIC_THREADS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&t| (1..=16).contains(&t))
        .unwrap_or(INTRA_OP_THREADS)
}

/// Где считать E5-инференс.
///
/// `SYNTEE_SEMANTIC_DEVICE`: `auto` (по умолчанию) — сначала DirectML, при
/// неудаче CPU; `cpu` — всегда CPU; `gpu`/`directml` — DirectML с откатом на
/// CPU, если адаптера нет. DirectML — нативный GPU-бэкенд Windows: любая
/// DX12-карта (NVIDIA/AMD/Intel), никакого CUDA-тулкита. Ограничение против
/// «жрёт видяху во время игры»: у GPU нет аналога BELOW_NORMAL-приоритета,
/// поэтому авто-режим включается осознанно.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticDevice {
    Auto,
    Cpu,
    Gpu,
}

fn semantic_device() -> SemanticDevice {
    let value = std::env::var("SYNTEE_SEMANTIC_DEVICE").unwrap_or_default();
    match value.trim() {
        "cpu" => SemanticDevice::Cpu,
        "gpu" | "directml" | "dml" => SemanticDevice::Gpu,
        _ => SemanticDevice::Auto,
    }
}

/// Провайдер, которым реально поднята последняя сессия (`directml`/`cpu`),
/// `unknown` — пока модель не загружена. Отдаётся в `health`, чтобы настройки
/// показывали, что выбрал авто-режим.
static ACTIVE_DEVICE: OnceLock<&'static str> = OnceLock::new();

pub fn active_device() -> &'static str {
    ACTIVE_DEVICE.get().copied().unwrap_or("unknown")
}

/// Лимит токенов на вход — `model_max_length` E5 (позиционных эмбеддингов 514).
const MAX_TOKENS: usize = 512;

/// Префикс E5: асимметричный формат (query ищет по passage).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedPrefix {
    Query,
    Passage,
}

impl EmbedPrefix {
    fn as_str(self) -> &'static str {
        match self {
            EmbedPrefix::Query => "query",
            EmbedPrefix::Passage => "passage",
        }
    }
}

/// Готовый к работе E5-эмбеддер.
///
/// `Session::run` требует `&mut self`, поэтому сессия под мьютексом. Инференс
/// сериализуется — это осознанно: параллельные прогоны на одном CPU только
/// конкурируют за те же ядра.
pub struct E5Embedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    /// Путь модели — нужен, чтобы пересобрать сессию на CPU при откате DML.
    model_path: PathBuf,
    /// Активен ли DirectML; снимается при первой ошибке инференса (fallback).
    dml: AtomicBool,
}

/// ONNX-окружение — одно на процесс и живёт до конца работы sidecar.
///
/// ⚠️ `ort::init().build()` разрешён только ОДИН раз за процесс: повторный
/// вызов падает с «only one environment is allowed per process». Поэтому
/// окружение нельзя создавать внутри [`E5Embedder::load`] — иначе после
/// `semanticUnload` модель уже не загрузить. Держим его глобально, а выгрузка
/// освобождает только сессию и токенизатор (это и есть ~365 МБ).
static ENVIRONMENT: OnceLock<Environment> = OnceLock::new();

fn shared_environment() -> Result<&'static Environment> {
    if let Some(environment) = ENVIRONMENT.get() {
        return Ok(environment);
    }
    let environment = ort::init()
        .with_name("syntee-sidecar")
        .build()
        .map_err(|error| SidecarError::Model(format!("onnx environment: {error}")))?;
    // Гонка двух первых загрузок: проигравший отбрасывает своё окружение.
    let _ = ENVIRONMENT.set(environment);
    ENVIRONMENT
        .get()
        .ok_or_else(|| SidecarError::Model("onnx environment unavailable".to_owned()))
}

/// Поднимает ONNX-сессию под выбранный провайдер.
///
/// DML запрашивается и для `Gpu`, и для `Auto`; не поднявшаяся GPU-сессия —
/// не ошибка, а откат на CPU: сломанный слой семантики хуже медленного.
/// DirectML EP требует отключённого memory pattern (ограничение EP).
/// Возвращает `(сессия, работает ли DirectML)`.
fn build_session(
    environment: &Environment,
    model_path: &Path,
    device: SemanticDevice,
) -> Result<(Session, bool)> {
    if device != SemanticDevice::Cpu {
        match build_session_inner(environment, model_path, true) {
            Ok(session) => return Ok((session, true)),
            Err(error) => {
                eprintln!(
                    "[semantic] DirectML недоступен ({error}); откат на CPU"
                );
            }
        }
    }
    let session = build_session_inner(environment, model_path, false)?;
    Ok((session, false))
}

fn build_session_inner(
    environment: &Environment,
    model_path: &Path,
    dml: bool,
) -> Result<Session> {
    let mut builder = Session::builder(environment)
        .map_err(|error| SidecarError::Model(format!("session builder: {error}")))?
        .with_intra_threads(semantic_intra_threads())
        .map_err(|error| SidecarError::Model(format!("intra threads: {error}")))?
        .with_inter_threads(INTER_OP_THREADS)
        .map_err(|error| SidecarError::Model(format!("inter threads: {error}")))?;
    // Арена процессора держит освобождённые блоки под себя: в простое это
    // десятки мегабайт «мусора», которые видно в RSS. Для одного короткого
    // прогона на текст аллокатор и так дешёвый.
    if let Ok(next) = builder.clone().with_config_entry("session.use_env_allocators", "0") {
        builder = next;
    }
    if dml {
        builder = builder
            .with_execution_providers([ort::ep::DirectML::default().build()])
            .map_err(|error| SidecarError::Model(format!("directml provider: {error}")))?
            .with_memory_pattern(false)
            .map_err(|error| SidecarError::Model(format!("memory pattern: {error}")))?;
    }
    builder
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|error| SidecarError::Model(format!("optimization level: {error}")))?
        // Сессионный пул: тот же отказ от busy-wait + FTZ (ключи ORT;
        // дублируют глобальные настройки — покрывают оба вида пула).
        .with_config_entry("session.intra_op.allow_spinning", "0")
        .map_err(|error| SidecarError::Model(format!("intra spinning: {error}")))?
        .with_config_entry("session.set_denormal_as_zero", "1")
        .map_err(|error| SidecarError::Model(format!("denormal as zero: {error}")))?
        .commit_from_file(model_path)
        .map_err(|error| SidecarError::Model(format!("load model: {error}")))
}

impl E5Embedder {
    /// Загружает модель и токенизатор с диска.
    ///
    /// Пути приходят из TS: sidecar не знает про `userData` и кэш HF — он не
    /// должен зависеть от раскладки приложения.
    pub fn load(model_path: &Path, tokenizer_path: &Path) -> Result<Self> {
        if !model_path.is_file() {
            return Err(SidecarError::Model(format!(
                "model file not found: {}",
                model_path.display()
            )));
        }
        if !tokenizer_path.is_file() {
            return Err(SidecarError::Model(format!(
                "tokenizer file not found: {}",
                tokenizer_path.display()
            )));
        }

        let environment = shared_environment()?;
        let device = semantic_device();
        let (session, dml) = build_session(environment, model_path, device)?;
        // Лог фактического выбора: auto может откатиться на CPU.
        eprintln!(
            "[semantic] device: {} → {}",
            match device {
                SemanticDevice::Auto => "auto",
                SemanticDevice::Cpu => "cpu",
                SemanticDevice::Gpu => "gpu",
            },
            if dml { "directml" } else { "cpu" }
        );
        let _ = ACTIVE_DEVICE.set(if dml { "directml" } else { "cpu" });

        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|error| SidecarError::Model(format!("load tokenizer: {error}")))?;

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            model_path: model_path.to_path_buf(),
            dml: AtomicBool::new(dml),
        })
    }

    /// Считает эмбеддинг одного текста.
    ///
    /// Это батч из одного элемента: [1, seq] — та же математика, что и раньше,
    /// но единый путь инференса с откатом DirectML→CPU.
    pub fn embed(&self, text: &str, prefix: EmbedPrefix) -> Result<Vec<f32>> {
        let mut out = self.embed_batch(&[text.to_string()], prefix)?;
        Ok(out.pop().expect("single text embedded"))
    }

    /// Считает эмбеддинги пачки текстов. На DirectML тексты среза паддятся к
    /// общей длине и гоняются ОДНИМ сеансом [B, L] — в разы меньше запусков
    /// модели, чем по-текстовый [1, seq]. На CPU срез всегда один текст —
    /// вектор не зависит от соседей (см. комментарий про q8-квантизацию ниже).
    ///
    /// Срезы ограничены бюджетом токенов (B×L ≤ MAX_BATCH_TOKENS) и числом
    /// текстов, чтобы hidden-тензор [B, L, 384] не пиковал в сотни мегабайт.
    pub fn embed_batch(&self, texts: &[String], prefix: EmbedPrefix) -> Result<Vec<Vec<f32>>> {
        let mut encoded: Vec<(Vec<i64>, Vec<i64>)> = Vec::with_capacity(texts.len());
        for text in texts {
            let prompt = format!("{}: {}", prefix.as_str(), text);
            let encoding = self
                .tokenizer
                .encode(prompt, true)
                .map_err(|error| SidecarError::Model(format!("tokenize: {error}")))?;
            let mut ids: Vec<i64> = encoding.get_ids().iter().map(|v| i64::from(*v)).collect();
            let mut mask: Vec<i64> = encoding
                .get_attention_mask()
                .iter()
                .map(|v| i64::from(*v))
                .collect();
            if ids.len() > MAX_TOKENS {
                ids.truncate(MAX_TOKENS);
                mask.truncate(MAX_TOKENS);
            }
            if ids.is_empty() {
                return Err(SidecarError::Model("empty token sequence".to_owned()));
            }
            encoded.push((ids, mask));
        }

        // Сортировка индексов по длине перед нарезкой: в срез попадают тексты
        // близкой длины, паддинг внутри среза минимален. Смешанный срез паддил
        // каждую короткую строку до самой длинной — до 2-4× лишних вычислений
        // на паддинг. Порядок результатов восстанавливается по исходным
        // индексам, mean-pool отрезает падд по маске.
        //
        // ⚠️ Батчинг разрешён только на DirectML. У q8-модели DynamicQuantize
        // считает scale по ВСЕМУ тензору: соседние тексты в срезе меняют
        // квантование каждой строки — вектор текста зависит от состава батча
        // (замер 16.11.2026: same-text cosine 0.996-0.998 против single-run).
        // Это ломало паритет с JS-эталоном и детерминизм «тот же хэш — тот же
        // вектор», поэтому на CPU срез = один текст [1, len] без паддинга —
        // ровно как в JS. На GPU арифметика fp и так отличается от CPU
        // (пользователь осознанно включил GPU), батчинг даёт 3×.
        let mut order: Vec<usize> = (0..encoded.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(encoded[i].0.len()));

        let mut out: Vec<Option<Vec<f32>>> = (0..encoded.len()).map(|_| None).collect();
        let batch_cap = if self.dml.load(Ordering::Relaxed) { MAX_BATCH_TEXTS } else { 1 };
        let mut index = 0;
        while index < order.len() {
            // Срез: сумма длин в бюджете токенов; минимум 1 текст в срезе.
            let mut end = index;
            let mut budget = 0usize;
            while end < order.len() && end - index < batch_cap {
                let len = encoded[order[end]].0.len().max(1);
                if end > index && budget + len > MAX_BATCH_TOKENS {
                    break;
                }
                budget += len;
                end += 1;
            }
            let slice = &order[index..end];
            let seq = slice.iter().map(|&i| encoded[i].0.len()).max().unwrap_or(1).max(1);
            let batch = slice.len();

            let mut input_ids = Vec::with_capacity(batch * seq);
            let mut attention = Vec::with_capacity(batch * seq);
            let mut token_types = Vec::with_capacity(batch * seq);
            for &orig in slice {
                let (ids, mask) = &encoded[orig];
                input_ids.extend_from_slice(ids);
                attention.extend_from_slice(mask);
                token_types.extend(std::iter::repeat(0i64).take(seq));
                let pad = seq - ids.len();
                input_ids.extend(std::iter::repeat(0i64).take(pad));
                attention.extend(std::iter::repeat(0i64).take(pad));
            }

            let hidden = self.run_batch(batch, seq, input_ids, attention, token_types)?;

            // Mean-pool по строкам: base строки в плоском [B, L, H] = row*L*H;
            // падд-позиции отрезаны длиной реального текста (len < L).
            for (row, &orig) in slice.iter().enumerate() {
                let (ids, mask) = &encoded[orig];
                let len = ids.len();
                let row_base = row * seq * E5_DIM;
                let flat = &hidden[row_base..row_base + len * E5_DIM];
                out[orig] = Some(mean_pool_normalized(flat, mask, len));
            }

            index = end;
        }
        Ok(out.into_iter().map(|v| v.expect("every text embedded")).collect())
    }

    /// Один прогон батча [B, L]: тензоры → инференс → плоский hidden [B·L·H].
    ///
    /// При ошибке инференса на DirectML (устаревший драйвер, отвалившееся
    /// устройство, не хватило VRAM) сессия один раз пересобирается на CPU:
    /// индексация не должна умирать из-за видеопамяти.
    fn run_batch(
        &self,
        batch: usize,
        seq: usize,
        input_ids: Vec<i64>,
        attention: Vec<i64>,
        token_types: Vec<i64>,
    ) -> Result<Vec<f32>> {
        let shape = vec![batch as i64, seq as i64];
        let mut session = self
            .session
            .lock()
            .map_err(|_| SidecarError::Model("session lock poisoned".to_owned()))?;
        let hidden = match run_locked(&mut session, &shape, &input_ids, &attention, &token_types) {
            Ok(hidden) => hidden,
            Err(error) => {
                if !self.dml.swap(false, Ordering::SeqCst) {
                    return Err(error);
                }
                eprintln!(
                    "[semantic] инференс на DirectML упал ({error}); пересобираю сессию на CPU"
                );
                let environment = shared_environment()?;
                let (fresh, _) = build_session(environment, &self.model_path, SemanticDevice::Cpu)?;
                *session = fresh;
                run_locked(&mut session, &shape, &input_ids, &attention, &token_types)?
            }
        };
        Ok(hidden)
    }
}

/// Блокирует сессию, гоняет батч и забирает `last_hidden_state` во владение.
fn run_locked(
    session: &mut Session,
    shape: &[i64],
    input_ids: &[i64],
    attention: &[i64],
    token_types: &[i64],
) -> Result<Vec<f32>> {
    let shape = shape.to_vec();
    let input_ids = Tensor::from_array((shape.clone(), input_ids.to_vec()))
        .map_err(|error| SidecarError::Model(format!("input_ids tensor: {error}")))?;
    let attention = Tensor::from_array((shape.clone(), attention.to_vec()))
        .map_err(|error| SidecarError::Model(format!("attention tensor: {error}")))?;
    let token_type_ids = Tensor::from_array((shape, token_types.to_vec()))
        .map_err(|error| SidecarError::Model(format!("token_type_ids tensor: {error}")))?;

    let outputs = session
        .run(ort::inputs![
            "input_ids" => input_ids,
            "attention_mask" => attention,
            "token_type_ids" => token_type_ids,
        ])
        .map_err(|error| SidecarError::Model(format!("inference: {error}")))?;
    let (_, hidden) = outputs["last_hidden_state"]
        .try_extract_tensor::<f32>()
        .map_err(|error| SidecarError::Model(format!("extract output: {error}")))?;
    Ok(hidden.to_vec())
}

/// Бюджет токенов одного сеанса модели (B×L). 8192 при L≤512 — компромисс
/// между утилизацией батчинга и пиком памяти hidden-тензора. На CPU не
/// действует: там срез всегда один текст.
const MAX_BATCH_TOKENS: usize = 8192;
/// С отсортированными по длине срезами паддинг не растёт с B — можно брать
/// больше текстов на прогон: меньше накладных расходов на session.run.
/// Только DirectML; CPU ограничен единицей ради паритета с JS-эталоном.
const MAX_BATCH_TEXTS: usize = 64;

/// Mean-pooling по attention_mask + L2-нормализация.
///
/// Ровно то, что делает `{ pooling: 'mean', normalize: true }` в
/// transformers.js: сумма по непустым токенам, деление на их количество,
/// затем деление на длину вектора.
fn mean_pool_normalized(hidden: &[f32], mask: &[i64], seq: usize) -> Vec<f32> {
    let mut acc = vec![0f32; E5_DIM];
    let mut counted = 0f32;
    for token in 0..seq {
        if mask.get(token).copied().unwrap_or(0) == 0 {
            continue;
        }
        let base = token * E5_DIM;
        if base + E5_DIM > hidden.len() {
            break;
        }
        for dim in 0..E5_DIM {
            acc[dim] += hidden[base + dim];
        }
        counted += 1.0;
    }
    if counted > 0.0 {
        for value in acc.iter_mut() {
            *value /= counted;
        }
    }
    let norm = acc.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in acc.iter_mut() {
            *value /= norm;
        }
    }
    acc
}

/// Косинус двух L2-нормализованных векторов = dot product.
pub fn cosine(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0f64;
    for i in 0..a.len() {
        dot += f64::from(a[i]) * f64::from(b[i]);
    }
    dot
}

/// BLOB ↔ вектор: `semantic_embeddings.embedding` хранит f32 little-endian.
pub fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// Обратное к [`vector_to_blob`]. Битый BLOB (не кратный 4) даёт пустой вектор.
pub fn blob_to_vector(blob: &[u8]) -> Vec<f32> {
    if blob.len() % 4 != 0 {
        return Vec::new();
    }
    blob.chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mean_pool_averages_masked_tokens() {
        // 2 токена по 384, маска только на первом.
        let mut hidden = vec![0f32; 2 * E5_DIM];
        for (dim, value) in hidden.iter_mut().enumerate().take(E5_DIM) {
            *value = 1.0;
            let _ = dim;
        }
        let mask = vec![1i64, 0];
        let vector = mean_pool_normalized(&hidden, &mask, 2);
        // Один токен из единиц → после нормализации 1/sqrt(384) на измерение.
        let expected = 1.0f32 / (E5_DIM as f32).sqrt();
        assert!((vector[0] - expected).abs() < 1e-6);
        let norm: f32 = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
    }

    #[test]
    fn blob_roundtrip() {
        let vector = vec![0.5f32, -1.25, 3.0];
        let blob = vector_to_blob(&vector);
        assert_eq!(blob_to_vector(&blob), vector);
        assert!(blob_to_vector(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn cosine_of_identical_is_one() {
        let vector = vec![0.6f32, 0.8];
        assert!((cosine(&vector, &vector) - 1.0).abs() < 1e-6);
    }
}
