# Sidecar JSONL protocol

Protocol version: `1`.

## Envelope

```json
{"id":1,"method":"status","params":{}}
```

Success: `{"id":1,"ok":true,"result":{}}`
Failure: `{"id":1,"ok":false,"error":{"code":"invalid_request","message":"..."}}`

One request and one response occupy one line. Maximum request size is 4 MiB. stdout is reserved for responses; watcher diagnostics go to stderr and status.

## Methods

### `health`, `capabilities`

`health` returns `status` and `protocolVersion`. `capabilities` lists all methods and reports `rust-lexical-structural-parser`.

### `index`

Params:

```json
{"dbPath":"C:/.../syntee.db","projectId":"p","workdir":"C:/repo","options":{"maxFiles":5000,"maxFileSizeKb":1500,"ignoreDirs":["node_modules"],"skipReferences":false}}
```

Full walks are incremental by `(size, content_hash)`. The walk fills `maxFiles` with source files first and only then with artifacts (JSON/YAML/TOML/Markdown), so a large `assets/` tree cannot crowd implementation files out of the index. `filesRemoved` is non-zero only after a complete, error-free walk; on a clean `hitCap` the walk prunes stale artifact rows that it did not see, never source rows. Any walk/read error disables pruning entirely.

### `indexChangedPaths`

```json
{"dbPath":"C:/.../syntee.db","projectId":"p","workdir":"C:/repo","changedPaths":["C:/repo/src/a.ts","C:/repo/src/old.ts"],"options":{}}
```

Changed files are parsed/upserted. A path is deleted only when the filesystem confirms it no longer exists. Read/metadata/index errors retain the previous row and set `hadErrors`.

### `startWatching`

Uses the same `dbPath`, `projectId`, `workdir`, and `options` schema as `index`. Starts a recursive Rust `notify` watcher with 250 ms debounce. Consecutive events are coalesced and sent through the changed-path indexer. If `foregroundBusy` is true, pending work waits without being discarded.

### `stopWatching`

Stops and joins the watcher thread. Safe to call repeatedly.

### `foregroundBusy`

Params: `{ "busy": true }` or `{ "busy": false }`. Pauses watcher indexing while the foreground chat is busy.

### `status`

Returns watcher state including `active`, `foregroundBusy`, `pendingPaths`, `filesChanged`, `filesRemoved`, `batches`, `debounceMs`, `indexedFilesCount` (rows currently in `fast_context_sidecar_index` for the watched project, `null` when nothing is watched or the DB is unavailable) and nullable `lastError`. Errors are also written to stderr.

### `search`, `clear`

`search` accepts `dbPath`, `projectId`, `query`, `maxFiles`, `maxTokens`; limits are clamped. Query tokens are normalized (camelCase/snake_case split, Unicode lowercase, stop words removed) and matched against the file path and stored symbols; source files are ranked above artifacts. A query with no lexical match still returns the most structurally important indexed files instead of an empty result. The response contains `slice`, `topFiles` and `indexedFilesCount`. `clear` accepts `dbPath` and `projectId`.

### `shutdown`

Stops and joins watcher threads before returning `shutting_down`.

## Compatibility

- Wire envelope remains `{id,method,params}` and response IDs are preserved.
- `fast_context_sidecar_index.symbols_json` remains `{ "d": [...], "i": [...], "r": [...] }`.
- Symbol fields remain camelCase (`lineStart`, `lineEnd`, `parentName`).
- Production TypeScript `fast_context_index` is not modified.
