# Syntee Sidecar

Rust sidecar для CPU-heavy подсистем Syntee Helper. Выносит подсчёт токенов, разбор символов кода и E5-semantic память вне Electron main process, чтобы не блокировать event loop и UI.

## Scope

- нативный tree-sitter (`symbols/ast.rs`) для js/ts/tsx/py/rs/go/c/cpp/java/c_sharp/ruby/php/bash/json; lexical parser (`symbols/lexical.rs`) — fallback для остальных форматов; метод `symbols` возвращает definitions/imports/references для outline в `read_file`;
- cl100k_base token counting (`text/tokens.rs`, `tiktoken-rs`) — точный подсчёт токенов вне main process; `tokens*` методы обслуживаются пулом потоков, чтобы не стоять в очереди за семантической индексацией;
- E5-эмбеддинги памяти (`semantic/`): индексация источников `recall_memory` в `semantic_embeddings` и cosine-поиск; модель выгружается после простоя;
- JSON Lines protocol через `stdin`/`stdout`.

Диагностика пишется в `stderr`, чтобы stdout оставался machine-readable. `shutdown` выгружает semantic-модель до ответа.

## Build

```powershell
cargo fmt --all -- --check
cargo check
cargo test
cargo build --release
```

`scripts/build.ps1` собирает release и копирует бинарь в `resources/sidecar`. Если приложение запущено, файл залочен: замените его через rename (старый → `.locked`, затем копия нового).

## Safety boundaries

- JSONL request ограничен 4 MiB;
- `dbPath` должен быть существующим SQLite-файлом Syntee;
- sidecar создаёт/изменяет только свою таблицу `semantic_embeddings`; чужие таблицы и колонки не мигрируются;
- semantic-индексация уступает фореграунду (`foregroundBusy`) и ограничена бюджетом цикла.

## Methods

`health`, `capabilities`, `foregroundBusy`, `tokensCount`, `tokensCountBatch`, `tokensTruncate`, `symbols`, `semanticEmbed`, `semanticIndex`, `semanticSearch`, `semanticUnload`, `shutdown`.

Основные params используют camelCase: `dbPath`, `modelPath`, `tokenizerPath`. `foregroundBusy` принимает `{ "busy": true|false }`. Подробности — в `PROTOCOL.md`.

PTY, LLM orchestration, UI, memory extraction, provider clients и Electron IPC остаются за пределами sidecar.