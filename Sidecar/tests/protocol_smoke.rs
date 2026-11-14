use serde_json::json;
use syntee_sidecar::commands::dispatch;
use syntee_sidecar::protocol::{Request, Response};

#[test]
fn health_reports_protocol_version() {
    let outcome =
        dispatch(Request { id: json!(1), method: "health".to_owned(), params: json!({}) }).unwrap();
    assert!(outcome.result["status"] == "ok" || outcome.result["status"] == "degraded");
    assert_eq!(outcome.result["protocolVersion"], 1);
    assert!(!outcome.shutdown);
}

#[test]
fn capabilities_expose_shared_commands() {
    let outcome =
        dispatch(Request { id: json!(1), method: "capabilities".to_owned(), params: json!({}) })
            .unwrap();
    let methods = outcome.result["methods"].as_array().unwrap();
    for method in [
        "health",
        "capabilities",
        "foregroundBusy",
        "tokensCount",
        "tokensCountBatch",
        "tokensTruncate",
        "symbols",
        "semanticEmbed",
        "semanticIndex",
        "semanticSearch",
        "semanticUnload",
        "shutdown",
    ] {
        assert!(methods.iter().any(|value| value == method));
    }
    assert_eq!(outcome.result["parserBackend"], "tree-sitter (native) + lexical fallback");
    assert!(outcome.result["ranking"].as_str().unwrap().contains("E5"));
}

#[test]
fn tokens_methods_match_cl100k_and_truncate() {
    let counted = dispatch(Request {
        id: json!(1),
        method: "tokensCount".to_owned(),
        params: json!({"text": "Hello, world!"}),
    })
    .unwrap();
    assert_eq!(counted.result["tokens"], 4);

    let batch = dispatch(Request {
        id: json!(2),
        method: "tokensCountBatch".to_owned(),
        params: json!({"texts": ["", "hello world"]}),
    })
    .unwrap();
    assert_eq!(batch.result["tokens"], json!([0, 2]));

    let truncated = dispatch(Request {
        id: json!(3),
        method: "tokensTruncate".to_owned(),
        params: json!({"text": "one two three four five six", "maxTokens": 3}),
    })
    .unwrap();
    assert_eq!(truncated.result["truncated"], true);
    assert!(truncated.result["tokens"].as_u64().unwrap() <= 3);
}

#[test]
fn symbols_use_tree_sitter_for_supported_languages() {
    let root = std::env::temp_dir().join(format!("syntee-sidecar-symbols-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("store.ts");
    std::fs::write(&file, "export class Store {\n  async load() {}\n}\n").unwrap();

    let outcome = dispatch(Request {
        id: json!(1),
        method: "symbols".to_owned(),
        params: json!({"path": file, "skipReferences": true}),
    })
    .unwrap();
    assert_eq!(outcome.result["parser"], "tree-sitter");
    assert_eq!(outcome.result["language"], "typescript");
    let definitions = outcome.result["definitions"].as_array().unwrap();
    assert!(definitions.iter().any(|d| d["name"] == "Store" && d["kind"] == "class"));
    assert!(definitions.iter().any(|d| d["name"] == "load" && d["parentName"] == "Store"));

    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn foreground_busy_is_wire_compatible() {
    let busy = dispatch(Request {
        id: json!(3),
        method: "foregroundBusy".to_owned(),
        params: json!({"busy": true}),
    })
    .unwrap();
    assert_eq!(busy.result["foregroundBusy"], true);
    let _ = dispatch(Request {
        id: json!(4),
        method: "foregroundBusy".to_owned(),
        params: json!({"busy": false}),
    })
    .unwrap();
}

#[test]
fn shutdown_is_explicit() {
    let outcome =
        dispatch(Request { id: json!(2), method: "shutdown".to_owned(), params: json!({}) })
            .unwrap();
    assert!(outcome.shutdown);
}

#[test]
fn response_result_and_params_are_wire_compatible() {
    let request: Request = serde_json::from_value(json!({
        "id": "x",
        "method": "health",
        "params": {"dbPath": "syntee.db"}
    }))
    .unwrap();
    assert_eq!(request.method, "health");
    let response = Response::success(json!("x"), json!({"protocolVersion": 1}));
    let encoded = serde_json::to_value(response).unwrap();
    assert!(encoded.get("result").is_some());
    assert!(encoded.get("result").unwrap().get("protocolVersion").is_some());
}

#[test]
fn removed_fast_context_methods_are_unsupported() {
    for method in ["index", "search", "clear", "startWatching", "stopWatching", "status"] {
        let error = dispatch(Request {
            id: json!(1),
            method: method.to_owned(),
            params: json!({}),
        })
        .err()
        .expect("removed method must fail");
        assert!(matches!(error, syntee_sidecar::common::error::SidecarError::UnsupportedMethod(_)));
    }
}