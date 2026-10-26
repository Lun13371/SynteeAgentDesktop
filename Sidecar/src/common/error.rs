use thiserror::Error;

pub type Result<T> = std::result::Result<T, SidecarError>;

#[derive(Debug, Error)]
pub enum SidecarError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("invalid request: {0}")]
    InvalidRequest(String),

    #[error("unsupported method: {0}")]
    UnsupportedMethod(String),

    #[error("model error: {0}")]
    Model(String),
}
