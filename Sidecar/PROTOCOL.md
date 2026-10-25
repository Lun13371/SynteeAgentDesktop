# Sidecar JSONL protocol

Protocol version: `1`.

## Envelope

```json
{"id":1,"method":"status","params":{}}
```

Success: `{"id":1,"ok":true,"result":{}}`
Failure: `{"id":1,"ok":false,"error":{"code":"invalid_request","message":"..."}}`

One request and one response occupy one line. Maximum request size is 4 MiB. stdout is reserved for responses; watcher diagnostics go to stderr and status.

## Concurrency

Requests are handled on the reader thread in arrival order, with one exception: `tokensCount`, `tokensCountBatch` and `tokensTruncate` are served by a small worker pool, because token counting sits on the chat send path and must not queue behind a full project walk. Responses for those methods can therefore arrive out of order — always match by `id`. Every other method (index, search, watcher control) is serial, which keeps one writer on SQLite at a time.

## Methods

### `health`, `capabilities`

`health` returns `status` and `protocolVersion`. `capabilities` lists all methods, reports `tree-sitter (native) + lexical fallback` as `parserBackend` and `field-weighted + idf + ru-en synonyms + graph rank` as `ranking`.

### `index`

Params:

```json
{"dbPath":"C:/.../syntee.db","projectId":"p","workdir":"C:/repo","maxAgeMs":30000,"options":{"maxFiles":5000,"maxFileSizeKb":1500,"ignoreDirs":["node_modules"],"skipReferences":false}}
```

Full walks are incremental by `(size, mtime)` first and `(size, content_hash)` second: an unchanged timestamp never opens the file, and new content with an old timestamp only rewrites the mtime. One traversal fills `maxFiles` with source files first and only then with artifacts (JSON/YAML/TOML/Markdown, generated `.d.ts`/`.min.js`/`.map`), so a large `assets/` tree cannot crowd implementation files out of the index. `filesRemoved` is non-zero only after a complete, error-free walk; on a clean `hitCap` the walk prunes stale artifact rows that it did not see, never source rows. Any walk/read error disables pruning entirely.

Changed files are parsed in parallel (up to 8 threads) and written in a single transaction.

`maxAgeMs` (optional, default `0`) makes the request a no-op when the index was written more recently: the response then has `"skipped": true` and reports the current row count. It exists so a query does not re-walk a project the watcher is already keeping current.

### `indexChangedPaths`

```json
{"dbPath":"C:/.../syntee.db","projectId":"p","workdir":"C:/repo","changedPaths":["C:/repo/src/a.ts","C:/repo/src/old.ts"],"options":{}}
```

Changed files are parsed/upserted. Paths inside an ignored directory are refused. A directory that appears is walked and its files are indexed. A path is deleted only when the filesystem confirms it no longer exists; a removed directory also drops every row beneath it. Read/metadata/index errors retain the previous row and set `hadErrors`.

### `startWatching`

Uses the same `dbPath`, `projectId`, `workdir`, and `options` schema as `index`. Starts a recursive Rust `notify` watcher with 250 ms debounce. Consecutive events are coalesced and sent through the changed-path indexer. If `foregroundBusy` is true, pending work waits without being discarded.

### `stopWatching`

Stops and joins the watcher thread. Safe to call repeatedly.

### `foregroundBusy`

Params: `{ "busy": true }` or `{ "busy": false }`. Pauses watcher indexing while the foreground chat is busy.

### `status`

Returns watcher state including `active`, `foregroundBusy`, `pendingPaths`, `filesChanged`, `filesRemoved`, `batches`, `debounceMs`, `indexedFilesCount` (rows currently in `fast_context_sidecar_index` for the watched project, `null` when nothing is watched or the DB is unavailable) and nullable `lastError`. Errors are also written to stderr.

### `search`, `clear`

`search` accepts `dbPath`, `projectId`, `query`, `maxFiles`, `maxTokens`; limits are clamped. Query tokens are normalized (camelCase/snake_case split, Unicode lowercase, stop words removed), stemmed and translated from Russian to English (`кеш` → `cache`).

Ranking uses the columns written at index time (`search_path`, `search_names`, `search_body`) and never parses `symbols_json` per row:

- **field weight** — a definition-name match beats a path match, which beats a mention in imports/references;
- **match level** — whole word, then word prefix, then substring;
- **IDF** — a token present in every file does not discriminate; a rare one does;
- **structural importance** — source over artifacts, definitions over empty files, shallow paths over deep ones;
- **graph rank** (`ranked_score`) — how many other files reference names this file defines.

Every tie is broken deterministically (matched tokens, definition count, path depth, path).

The response contains `slice`, `topFiles`, `indexedFilesCount`, `matchKind` and `queryTokens`:

```json
{"slice":"src/tokens.rs: L26 function count\n","topFiles":[{"path":"C:/repo/src/tokens.rs","score":77.8,"matchedTokens":2,"definitions":[{"name":"count","kind":"function","lineStart":26,"lineEnd":32,"signature":"pub fn count(text: &str) -> usize"}]}],"indexedFilesCount":1013,"matchKind":"exact","queryTokens":["token","counting"]}
```

`matchKind` is `exact` (every query token matched), `partial` (some did) or `fallback` (nothing matched — `topFiles` are then the most structurally important files, and the caller must not present them as real matches). Each hit carries at most 12 definitions, the ones most relevant to the query.

On projects above 4 000 rows the candidate set is narrowed with an FTS5 mirror first; below it, a full scan over the precomputed columns is faster and has higher recall. The mirror is built once per project, lazily, and any FTS failure falls back to the scan.

`clear` accepts `dbPath` and `projectId` and removes the project's rows, its metadata and its FTS entries.

### `tokensCount`, `tokensCountBatch`, `tokensTruncate`

cl100k_base BPE token counting (the encoding used for request accounting).

```json
{"id":1,"method":"tokensCount","params":{"text":"Hello, world!"}}
{"id":2,"method":"tokensCountBatch","params":{"texts":["","hello world"]}}
{"id":3,"method":"tokensTruncate","params":{"text":"one two three four","maxTokens":3}}
```

`tokensCount` → `{"tokens":4}`. `tokensCountBatch` → `{"tokens":[0,2]}` (one entry per input, same order). `tokensTruncate` → `{"text":"one two three","tokens":3,"truncated":true}`: the cut lands on a token boundary, and a partially cut multi-byte character is dropped instead of being returned as U+FFFD.

Special-token spellings such as `<|endoftext|>` are counted as ordinary text — identical to `js-tiktoken`'s `encode(text, [], ['all'])`, so counts are interchangeable between the two implementations. `text` is capped at 2 MiB per request.

### `symbols`

Parses one file and returns definitions, imports and call-site references.

```json
{"id":4,"method":"symbols","params":{"path":"C:/repo/src/store.ts","content":"…","skipReferences":false}}
```

`content` is optional: when present the sidecar does not read the file again. The response is:

```json
{"definitions":[{"name":"Store","kind":"class","lineStart":1,"lineEnd":4,"signature":"export class Store {","parentName":null}],"imports":["import { readFile } from 'fs'"],"references":["readFile"],"truncated":false,"language":"typescript","parser":"tree-sitter","supported":true}
```

`parser` is `tree-sitter` for languages with a native grammar (`javascript`, `typescript`, `tsx`, `python`, `rust`, `go`, `c`, `cpp`, `java`, `c_sharp`, `ruby`, `php`, `bash`, `json`) and `lexical` for the remaining indexable formats. `supported: false` means there is no parser at all for the extension (the caller should fall back to its own heuristics). `truncated: true` means a node/definition cap stopped extraction before the end of the file, so the outline is known to be incomplete. `references` are identifiers collected from the AST — comments and string literals are skipped, names defined in the same file and a fixed blacklist of common local names are removed — and it is empty when `skipReferences` is true.

The same pipeline feeds the index: `index`/`indexChangedPaths` use native tree-sitter where a grammar exists and the lexical scanner elsewhere, so the repo-map the model sees is built from the same symbols as this method.

### `shutdown`

Stops and joins watcher threads before returning `shutting_down`.

## Compatibility

- Wire envelope remains `{id,method,params}` and response IDs are preserved.
- `fast_context_sidecar_index.symbols_json` remains `{ "d": [...], "i": [...], "r": [...] }`.
- Symbol fields remain camelCase (`lineStart`, `lineEnd`, `parentName`).
- Production TypeScript `fast_context_index` is not modified.

## Storage

The sidecar owns three objects in the Syntee database, all created on first open
and migrated in place (a column that has to be added forces one full re-parse of
the affected project by invalidating `content_hash` and `mtime`):

- `fast_context_sidecar_index` — one row per file: the raw `symbols_json` plus the
  precomputed `search_path`, `search_names`, `search_body`, `definitions_count`
  and `ranked_score` used for ranking;
- `fast_context_sidecar_meta` — `last_index_ms`, `files_count`, `fts_built`;
- `fast_context_sidecar_fts` — FTS5 mirror of the search columns, maintained only
  for projects above the scan threshold.

No other table is touched, and no column of another table is migrated.
