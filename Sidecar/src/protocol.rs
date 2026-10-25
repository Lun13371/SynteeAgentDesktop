use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default = "default_id")]
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

fn default_id() -> Value {
    Value::Null
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Value,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResponseError>,
}

#[derive(Debug, Serialize)]
pub struct ResponseError {
    pub code: String,
    pub message: String,
}

impl Response {
    pub fn success(id: Value, result: Value) -> Self {
        Self { id, ok: true, result: Some(result), error: None }
    }

    pub fn failure(id: Value, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id,
            ok: false,
            result: None,
            error: Some(ResponseError { code: code.into(), message: message.into() }),
        }
    }
}
