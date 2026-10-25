# Syntee Sidecar

Rust sidecar для CPU-heavy Fast Context backend Syntee Helper. Sidecar выполняет обход, инкрементальную индексацию, filesystem watching, symbol/import/reference extraction и retrieval вне Electron main process.

## Scope

- deterministic project walk с ignore-директориями и лимитами: **один** проход по дереву, исходники приоритетнее артефактов;
- incremental SQLite index в отдельной таблице `fast_context_sidecar_index` существующей Syntee БД (плюс `fast_context_sidecar_meta` и FTS5-зеркало `fast_context_sidecar_fts`);
- Rust watcher на `notify` с debounce 250 ms, foreground pause и безопасным changed-path indexing (ignoreDirs соблюдаются, появившиеся каталоги разворачиваются, удалённые — вычищаются по префиксу);
- удаление rows только для подтверждённо удалённых файлов; ошибки чтения/metadata никогда не удаляют старую запись;
- нативный tree-sitter (`ast.rs`) для js/ts/tsx/py/rs/go/c/cpp/java/c_sharp/ruby/php/bash/json — **и в индексе, и в методе `symbols`**; lexical parser (`symbols.rs`) остаётся fallback'ом для остальных форматов;
- lexical retrieval по предвычисленным колонкам: field-weighted + IDF + RU→EN словарь + граф-скор, компактный repo-map slice с номерами строк;
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

`scripts/build.ps1` собирает release и копирует бинарь в `resources/sidecar`. Если приложение запущено, файл залочен: замените его через rename (старый → `.locked`, затем копия нового).

## Safety boundaries

- JSONL request ограничен 4 MiB;
- `dbPath` должен быть существующим SQLite-файлом Syntee с таблицей `projects`;
- sidecar создаёт/изменяет только свои таблицы (`fast_context_sidecar_index`, `..._meta`, `..._fts`); чужие таблицы и колонки не мигрируются;
- полный walk не удаляет старые rows при cap или любой filesystem/read error; при чистом cap дополнительно вычищаются только устаревшие artifact-rows (JSON/YAML/TOML/Markdown и сгенерированные `.d.ts`/`.min.js`/`.map`), чтобы они не вытесняли исходники;
- changed-path indexing не удаляет row при ошибке чтения, а удаляет только если `path.exists()` подтверждённо false;
- `index` сначала набирает исходный код, и общий `maxFiles` cap расходуется на артефакты только после этого;
- `index` c `maxAgeMs` не пересканирует проект, если индекс записан недавно (`skipped: true`);
- `search` ограничен 200 files, 20,000 tokens и 512 KiB результата; в ответе есть `indexedFilesCount`, `matchKind` (`exact`/`partial`/`fallback`) и `queryTokens`; definitions обрезаются до 12 на файл, чтобы 50 файлов помещались в бюджет вместо 25;
- при нулевом совпадении search возвращает самые структурно важные файлы, но помечает ответ `matchKind: "fallback"` — вызывающая сторона не должна выдавать его за настоящий результат.

## Performance

Замеры на проекте из ~1 000 файлов (`resources/sidecar/syntee-sidecar.exe`, копия `syntee.db`):

| Операция | До | После |
|---|---|---|
| warm `index` (ничего не изменилось) | 190–200 ms | 43–52 ms |
| `index` с `maxAgeMs` | — | 6 ms (`skipped`) |
| cold `index` (полный разбор tree-sitter) | ~4.7 s | ~1.5 s (параллельный парсинг) |
| `search` | 53–290 ms | 27–42 ms |
| `topFiles` на `maxFiles=50` | 25 файлов, 523 KB JSON | 50 файлов, ~80 KB JSON |

## Methods

`health`, `capabilities`, `index`, `indexChangedPaths`, `search`, `clear`, `startWatching`, `stopWatching`, `foregroundBusy`, `status`, `tokensCount`, `tokensCountBatch`, `tokensTruncate`, `symbols`, `shutdown`.

Основные params используют camelCase: `dbPath`, `projectId`, `workdir`, `options`. `index` дополнительно принимает `maxAgeMs`. `startWatching` принимает те же `options`, что и `index`. `foregroundBusy` принимает `{ "busy": true|false }`.

PTY, LLM orchestration, UI, memory extraction, provider clients и Electron IPC остаются за пределами sidecar.