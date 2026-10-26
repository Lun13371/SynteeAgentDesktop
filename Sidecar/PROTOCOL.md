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

### `semanticEmbed`

E5-эмбеддинги (384-dim) для пачки текстов. Модель — `Xenova/multilingual-e5-small`, веса `q8`.

```json
{"id":5,"method":"semanticEmbed","params":{"modelPath":"…/onnx/model_quantized.onnx","tokenizerPath":"…/tokenizer.json","texts":["hello world"],"prefix":"passage"}}
```

`prefix` — `query` (поисковый запрос) или `passage` (индексируемый текст). E5 асимметрична: без префикса качество падает, а `query`/`passage` одного и того же текста дают разные векторы.

```json
{"model":"Xenova/multilingual-e5-small@q8-rust","dim":384,"vectors":[[0.021,-0.043,…]]}
```

Векторы L2-нормализованы (mean-pooling по `attention_mask`), поэтому cosine = dot product. Паритет с JS-пайплайном `@huggingface/transformers` закреплён тестом `tests/semantic-rust-parity.test.cjs` (порог cosine ≥ 0.9999 на 10 сэмплах).

### `semanticIndex`

Один цикл индексации источников `recall_memory` в таблицу `semantic_embeddings`.

```json
{"id":6,"method":"semanticIndex","params":{"dbPath":"…/syntee.db","modelPath":"…","tokenizerPath":"…","options":{"budgetMs":60000,"pageSize":200,"pauseBetweenItemsMs":40,"pauseBetweenPagesMs":250,"maxTextChars":1500,"sources":[]}}}
```

`sources` пустой — все пять (`memory`, `messages`, `summaries`, `agent_logs`, `pinned`). Индексируются только новые/изменённые строки: `sha256(текст)` + тег модели в `semantic_embeddings`. Ответ:

```json
{"model":"Xenova/multilingual-e5-small@q8-rust","sources":[{"source":"memory","indexed":252,"skipped":0,"failed":0,"durationMs":19993}],"durationMs":20021,"budgetExhausted":true,"totalIndexed":252,"totalSkipped":0,"totalFailed":0}
```

`budgetExhausted: true` — бюджет цикла кончился, остаток доедет следующим вызовом. Это замена бесконечному циклу в TS, который однажды занял 16.7 минуты. Цикл уступает фореграунду: пока `foregroundBusy: true`, страницы не читаются.

### `semanticSearch`

Cosine-поиск по `semantic_embeddings` с теми же scope/project/kind-фильтрами, что у lexical-канала.

```json
{"id":7,"method":"semanticSearch","params":{"dbPath":"…","modelPath":"…","tokenizerPath":"…","query":"как ускорили индексацию","limit":5,"sources":["memory","messages"],"scope":"all","projectId":null,"crossProject":false,"kind":null,"memoryEnabled":true,"memoryGlobal":true,"memoryProject":true,"memoryChat":true}}
```

```json
{"model":"Xenova/multilingual-e5-small@q8-rust","hits":[{"source":"memory","sourceId":"…","score":0.8398,"content":"…","chatId":"…","chatTitle":"…","role":"assistant","date":1793009705830}]}
```

Для `source: "memory"` дополнительно приходит `memoryRow` — полная строка `memory_items`, чтобы вызывающий построил `MemoryItem` своим маппером. Скан ограничен на источник (`memory` — 4000 по importance, `messages` — 10000 по recency), поэтому выдача bounded.

### `semanticUnload`

Освобождает ONNX-сессию и память модели, не останавливая процесс. Вызывается при shutdown sidecar.

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
