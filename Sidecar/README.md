# Syntee Sidecar

Rust sidecar для CPU-heavy Fast Context backend Syntee Helper. Sidecar выполняет обход, инкрементальную индексацию, filesystem watching, symbol/import/reference extraction и retrieval вне Electron main process.

## Scope

- deterministic project walk с ignore-директориями и лимитами;
- incremental SQLite index в отдельной таблице `fast_context_sidecar_index` существующей Syntee БД;
- Rust watcher на `notify` с debounce 250 ms, foreground pause и безопасным changed-path indexing;
- удаление rows только для подтверждённо удалённых файлов; ошибки чтения/metadata никогда не удаляют старую запись;
- нативный tree-sitter (`ast.rs`) для js/ts/tsx/py/rs/go/c/cpp/java/c_sharp/ruby/php/bash/json; lexical parser (`symbols.rs`) остаётся fallback'ом для остальных форматов;
- lexical retrieval и компактный repo-map slice;
- cl100k_base token counting (`tokens.rs`, `tiktoken-rs`) — точный подсчёт токенов вне main process; `tokens*` методы обслуживаются пулом потоков, чтобы не стоять в очереди за индексацией;
- JSON Lines protocol через `stdin`/`stdout`.

Watcher/index errors пишутся в `stderr` и доступны через `status.lastError`, чтобы stdout оставался machine-readable. `shutdown` останавливает watcher thread до ответа.

## Build

```powershell
cargo fmt --all -- --check
cargo check
cargo test
cargo build --release
```

## Safety boundaries

- JSONL request ограничен 4 MiB;
- `dbPath` должен быть существующим SQLite-файлом Syntee с таблицей `projects`;
- sidecar создаёт/изменяет только `fast_context_sidecar_index`;
- полный walk не удаляет старые rows при cap или любой filesystem/read error; при чистом cap дополнительно вычищаются только устаревшие artifact-rows (JSON/YAML/TOML/Markdown), чтобы они не вытесняли исходники;
- changed-path indexing не удаляет row при ошибке чтения, а удаляет только если `path.exists()` подтверждённо false;
- `index` сначала набирает исходный код, и общий `maxFiles` cap расходуется на артефакты только после этого;
- `search` лексический, но устойчивый: query токенизируется по camelCase/snake_case, сравнивается с путём и символами, при нулевом совпадении возвращает самые структурно важные файлы вместо пустого результата;
- search ограничен 200 files, 20,000 tokens и 512 KiB результата; в ответе есть `indexedFilesCount` — реальное число rows проекта.

## Methods

`health`, `capabilities`, `index`, `indexChangedPaths`, `search`, `clear`, `startWatching`, `stopWatching`, `foregroundBusy`, `status`, `tokensCount`, `tokensCountBatch`, `tokensTruncate`, `symbols`, `shutdown`.

Основные params используют camelCase: `dbPath`, `projectId`, `workdir`, `options`. `startWatching` дополнительно принимает те же `options`, что и `index`. `foregroundBusy` принимает `{ "busy": true|false }`.

PTY, LLM orchestration, UI, memory extraction, provider clients и Electron IPC остаются за пределами sidecar.
