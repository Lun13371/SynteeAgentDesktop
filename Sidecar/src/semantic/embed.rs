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

use std::path::Path;
use std::sync::Mutex;

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
    /// Environment обязан жить дольше сессии: он владеет ONNX-рантаймом.
    _environment: Environment,
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

        let environment = ort::init()
            .with_name("syntee-sidecar")
            .build()
            .map_err(|error| SidecarError::Model(format!("onnx environment: {error}")))?;

        let session = Session::builder(&environment)
            .map_err(|error| SidecarError::Model(format!("session builder: {error}")))?
            .with_intra_threads(INTRA_OP_THREADS)
            .map_err(|error| SidecarError::Model(format!("intra threads: {error}")))?
            .with_inter_threads(INTER_OP_THREADS)
            .map_err(|error| SidecarError::Model(format!("inter threads: {error}")))?
            .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
            .map_err(|error| SidecarError::Model(format!("optimization level: {error}")))?
            .commit_from_file(model_path)
            .map_err(|error| SidecarError::Model(format!("load model: {error}")))?;

        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|error| SidecarError::Model(format!("load tokenizer: {error}")))?;

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            _environment: environment,
        })
    }

    /// Считает эмбеддинг одного текста.
    pub fn embed(&self, text: &str, prefix: EmbedPrefix) -> Result<Vec<f32>> {
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
        let seq = ids.len();
        if seq == 0 {
            return Err(SidecarError::Model("empty token sequence".to_owned()));
        }
        let token_types = vec![0i64; seq];
        let shape = vec![1i64, seq as i64];

        let input_ids = Tensor::from_array((shape.clone(), ids))
            .map_err(|error| SidecarError::Model(format!("input_ids tensor: {error}")))?;
        let attention = Tensor::from_array((shape.clone(), mask.clone()))
            .map_err(|error| SidecarError::Model(format!("attention_mask tensor: {error}")))?;
        let token_type_ids = Tensor::from_array((shape, token_types))
            .map_err(|error| SidecarError::Model(format!("token_type_ids tensor: {error}")))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| SidecarError::Model("session lock poisoned".to_owned()))?;
        let outputs = session
            .run(ort::inputs![
                "input_ids" => input_ids,
                "attention_mask" => attention,
                "token_type_ids" => token_type_ids,
            ])
            .map_err(|error| SidecarError::Model(format!("inference: {error}")))?;

        let vector = {
            let (_, hidden) = outputs["last_hidden_state"]
                .try_extract_tensor::<f32>()
                .map_err(|error| SidecarError::Model(format!("extract output: {error}")))?;
            mean_pool_normalized(hidden, &mask, seq)
        };

        Ok(vector)
    }

    /// Считает эмбеддинги пачки текстов (последовательно, один сеанс модели).
    pub fn embed_batch(&self, texts: &[String], prefix: EmbedPrefix) -> Result<Vec<Vec<f32>>> {
        let mut out = Vec::with_capacity(texts.len());
        for text in texts {
            out.push(self.embed(text, prefix)?);
        }
        Ok(out)
    }
}

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
