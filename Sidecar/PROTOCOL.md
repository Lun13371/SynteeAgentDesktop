# Sidecar JSONL protocol

Protocol version: `1`.

## Envelope

```json
{"id":1,"method":"health","params":{}}
```

Success: `{"id":1,"ok":true,"result":{}}`
Failure: `{"id":1,"ok":false,"error":{"code":"invalid_request","message":"..."}}`

One request and one response occupy one line. Maximum request size is 4 MiB. stdout is reserved for responses; diagnostics go to stderr.

## Concurrency

Requests are handled on the reader thread in arrival order, with exceptions served by a small worker pool: `tokensCount`, `tokensCountBatch`, `tokensTruncate`, `semanticEmbed`, `semanticSearch` and `foregroundBusy`. Token counting sits on the chat send path and must not queue behind a long `semanticIndex` cycle; `foregroundBusy` must land immediately so the indexer yields. Responses for those methods can arrive out of order — always match by `id`. Every other method is serial, which keeps one writer on SQLite at a time.

## Methods

### `health`, `capabilities`

`health` returns `status`, `protocolVersion` and `dbReady`. `capabilities` lists all methods, reports `tree-sitter (native) + lexical fallback` as `parserBackend` and `semantic: E5 cosine (onnx)` as `ranking`.

### `foregroundBusy`

Params: `{ "busy": true }` or `{ "busy": false }`. Pauses background semantic indexing while the foreground chat is busy. Returns `{ "foregroundBusy": <bool> }`.

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

`parser` is `tree-sitter` for languages with a native grammar (`javascript`, `typescript`, `tsx`, `python`, `rust`, `go`, `c`, `cpp`, `java`, `c_sharp`, `ruby`, `php`, `bash`, `json`) and `lexical` for the remaining supported formats. `supported: false` means there is no parser at all for the extension (the caller should fall back to its own heuristics). `truncated: true` means a node/definition cap stopped extraction before the end of the file, so the outline is known to be incomplete. `references` are identifiers collected from the AST — comments and string literals are skipped, names defined in the same file and a fixed blacklist of common local names are removed — and it is empty when `skipReferences` is true.

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

`budgetExhausted: true` — бюджет цикла кончился, остаток доедет следующим вызовом. Цикл уступает фореграунду: пока `foregroundBusy: true`, страницы не читаются.

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

Освобождает ONNX-сессию и память модели, не останавливая процесс. Замер 26.10.2026: загруженная модель — **399 МБ RSS против 34 МБ без неё** (~365 МБ).

```json
{"id":8,"method":"semanticUnload"}
{"status":"unloaded"}   // модель была загружена и выгружена
{"status":"idle"}       // выгружать было нечего
```

Модель загружается снова при следующем `semanticEmbed`/`semanticIndex`/`semanticSearch` (~1.2 с). Окружение ONNX при этом **не** пересоздаётся: `ort::init()` разрешён один раз на процесс, поэтому оно живёт глобально, а выгрузка освобождает только сессию и токенизатор.

Sidecar также выгружает модель **сам** после 5 минут простоя (сторож в отдельном потоке, `SYNTEE_SEMANTIC_IDLE_MS` переопределяет окно для тестов). Вызывать `semanticUnload` вручную не обязательно — команда нужна для принудительной выгрузки и для диагностики.

### `shutdown`

Unloads the semantic model before returning `shutting_down`.

## Compatibility

- Wire envelope remains `{id,method,params}` and response IDs are preserved.
- Symbol fields remain camelCase (`lineStart`, `lineEnd`, `parentName`).

## Storage

The sidecar owns the `semantic_embeddings` table in the Syntee database (E5 vectors
for `recall_memory` sources). No other table is touched, and no column of another
table is migrated.