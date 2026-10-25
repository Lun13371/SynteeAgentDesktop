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
fn capabilities_expose_rust_watcher_commands() {
    let outcome =
        dispatch(Request { id: json!(1), method: "capabilities".to_owned(), params: json!({}) })
            .unwrap();
    let methods = outcome.result["methods"].as_array().unwrap();
    for method in ["startWatching", "stopWatching", "foregroundBusy", "status", "shutdown"] {
        assert!(methods.iter().any(|value| value == method));
    }
    assert_eq!(outcome.result["parserBackend"], "rust-lexical-structural-parser");
}

#[test]
fn watcher_status_and_busy_are_wire_compatible() {
    let status =
        dispatch(Request { id: json!(2), method: "status".to_owned(), params: json!({}) }).unwrap();
    assert_eq!(status.result["active"], false);
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
        "params": {"dbPath": "syntee.db", "projectId": "p", "workdir": ".", "options": {}}
    }))
    .unwrap();
    assert_eq!(request.method, "health");
    let response = Response::success(json!("x"), json!({"protocolVersion": 1}));
    let encoded = serde_json::to_value(response).unwrap();
    assert!(encoded.get("result").is_some());
    assert!(encoded.get("result").unwrap().get("protocolVersion").is_some());
}

#[test]
fn capped_index_prioritizes_source_and_search_returns_it() {
    let root = std::env::temp_dir().join(format!("syntee-sidecar-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("repo/assets/minecraft/lang")).unwrap();
    std::fs::create_dir_all(root.join("repo/src")).unwrap();
    std::fs::write(root.join("repo/assets/minecraft/lang/a.json"), "{\\\"hello\\\":\\\"world\\\"}")
        .unwrap();
    std::fs::write(
        root.join("repo/src/RenderPipeline.java"),
        "class RenderPipeline { void renderFrame() {} }",
    )
    .unwrap();
    let db_path = root.join("syntee.db");
    let connection = rusqlite::Connection::open(&db_path).unwrap();
    connection.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY);").unwrap();
    drop(connection);
    let workdir = root.join("repo");

    let indexed = dispatch(Request {
        id: json!(1),
        method: "index".to_owned(),
        params: json!({
            "dbPath": db_path,
            "projectId": "p",
            "workdir": workdir,
            "options": {"maxFiles": 1, "maxFileSizeKb": 1500, "ignoreDirs": []}
        }),
    })
    .unwrap();
    assert_eq!(indexed.result["filesFound"], 1);
    assert_eq!(indexed.result["hitCap"], true);
    assert_eq!(indexed.result["hadErrors"], false);

    let searched = dispatch(Request {
        id: json!(2),
        method: "search".to_owned(),
        params: json!({
            "dbPath": db_path,
            "projectId": "p",
            "query": "RenderPipeline",
            "maxFiles": 10,
            "maxTokens": 1000
        }),
    })
    .unwrap();
    assert_eq!(
        searched.result["topFiles"][0]["path"],
        workdir.join("src").join("RenderPipeline.java").to_string_lossy().as_ref()
    );
    let _ = std::fs::remove_dir_all(root);
}
