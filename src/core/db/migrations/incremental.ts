import type Database from 'better-sqlite3'
import { migrateChatsToProjects, migrateLegacyMemoryToMemoryItems, stripMessageAttachmentDataUrls } from './dataMigrations'

/** Инкрементальные миграции: ALTER TABLE, новые таблицы, data-миграции. */
export function runIncrementalMigrations(db: Database.Database): void {
  // Backfill messages_fts существующими сообщениями (одноразово при первом запуске).
  // Проверяем по messages_fts — если пусто, а messages нет — заполняем.
  {
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM messages_fts`).get() as { c: number }).c
    const msgCount = (db.prepare(`SELECT COUNT(*) as c FROM messages`).get() as { c: number }).c
    if (ftsCount === 0 && msgCount > 0) {
      const insertFts = db.prepare(
        `INSERT INTO messages_fts(content, message_id, chat_id, role, created_at)
         SELECT content, id, chat_id, role, created_at FROM messages
         WHERE role IN ('user','assistant','system')`
      )
      const t0 = Date.now()
      insertFts.run()
      console.log(`[migrations] messages_fts: backfilled ${msgCount} messages in ${Date.now() - t0}ms`)
    }
  }

  // Backfill chat_summaries_fts существующими резюме (одноразово при первом запуске).
  {
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM chat_summaries_fts`).get() as { c: number }).c
    const csCount = (db.prepare(`SELECT COUNT(*) as c FROM chat_summaries`).get() as { c: number }).c
    if (ftsCount === 0 && csCount > 0) {
      const t0 = Date.now()
      db.prepare(
        `INSERT INTO chat_summaries_fts(content, chat_id) SELECT content, chat_id FROM chat_summaries`
      ).run()
      console.log(`[migrations] chat_summaries_fts: backfilled ${csCount} summaries in ${Date.now() - t0}ms`)
    }
  }

  // Fast Context удалён из приложения: убираем его таблицы (TS-индекс,
  // история, Rust-зеркала) и узлы графа с source_kind='fast_context'.
  // Идемпотентно — на свежих БД таблиц уже нет.
  {
    db.exec(`
      DROP TABLE IF EXISTS fast_context_index;
      DROP TABLE IF EXISTS fast_context_index_history;
      DROP TABLE IF EXISTS fast_context_sidecar_index;
      DROP TABLE IF EXISTS fast_context_sidecar_meta;
      DROP TABLE IF EXISTS fast_context_sidecar_fts;
      DELETE FROM memory_graph_nodes WHERE source_kind = 'fast_context';
    `)
  }

  // Автомиграция: для каждого уникального workdir из chats создаём проект
  // и привязываем чаты к нему. workdir на chats остаётся как денормализованный
  // кэш для обратной совместимости, но источник правды теперь — projects.
  migrateChatsToProjects(db)

  // Миграция памяти: переносим старую memory table (key-value факты) в
  // новую унифицированную memory_items. Идемпотентна — повторный запуск
  // не дублирует (проверка по metadata->legacy_id).
  migrateLegacyMemoryToMemoryItems(db)

  // Автомиграция: добавляем title колонку к memory_items (если ещё нет).
  // Для существующих записей без title — переносим content в title
  // (как fallback, чтобы UI показывал что-то осмысленное).
  {
    const miCols = db.prepare(`PRAGMA table_info(memory_items)`).all() as { name: string }[]
    if (!miCols.find(c => c.name === 'title')) {
      db.prepare(`ALTER TABLE memory_items ADD COLUMN title TEXT`).run()
      // Backfill: для существующих записей без title — переносим content (truncate 100)
      db.prepare(`UPDATE memory_items SET title = SUBSTR(content, 1, 100) WHERE title IS NULL`).run()
    }
  }

  // ── memory_fts: FTS5 trigram индекс по memory_items (title + content) ──────
  // Схема (таблица + триггеры) создаётся в initialSchema (CREATE IF NOT EXISTS
  // выполняется и на существующих БД при каждом старте). Здесь — одноразовый
  // backfill существующих записей: триггеры срабатывают только на новые записи.
  {
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM memory_fts`).get() as { c: number }).c
    const miCount = (db.prepare(`SELECT COUNT(*) as c FROM memory_items`).get() as { c: number }).c
    if (ftsCount === 0 && miCount > 0) {
      const t0 = Date.now()
      db.prepare(
        `INSERT INTO memory_fts(title, content, item_id) SELECT title, content, id FROM memory_items`
      ).run()
      console.log(`[migrations] memory_fts: backfilled ${miCount} memory items in ${Date.now() - t0}ms`)
    }
  }

  // Автомиграция: name колонка в chat_checkpoints — для именованных снапшотов
  // (/snapshot <name>). NULL у обычных чекпоинтов (auto-checkpoint на каждый turn).
  // Именованные снапшоты — поименованные точки отката, которые пользователь
  // явно создал и может восстановить через /restore <name>.
  {
    const ccCols = db.prepare(`PRAGMA table_info(chat_checkpoints)`).all() as { name: string }[]
    if (!ccCols.find(c => c.name === 'name')) {
      db.prepare(`ALTER TABLE chat_checkpoints ADD COLUMN name TEXT`).run()
    }
  }

  // Автомиграция: добавляем role колонку к subagents — для специализированных
  // суб-агентов (researcher, deep-researcher, editor, implementer, reviewer).
  // NULL у старых записей → getSubagentRole(null) → implementer (default).
  {
    const subCols = db.prepare(`PRAGMA table_info(subagents)`).all() as { name: string }[]
    if (!subCols.find(c => c.name === 'role')) {
      db.prepare(`ALTER TABLE subagents ADD COLUMN role TEXT`).run()
    }
  }

  // ── Attachments ──────────────────────────────────────────────────────────
  // Колонка attachments в messages — JSON-массив Attachment[] (метаданные для
  // рендера чипов над отправленным сообщением). Текстовое содержимое уже
  // инлайнилось в content при отправке — здесь только UI-метаданные.
  {
    const cols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]
    if (!cols.find(c => c.name === 'attachments')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN attachments TEXT`).run()
    }
    // Колонка attachment_result — JSON AttachmentProcessingResult (для
    // AttachmentProcessingBlock в сохранённом сообщении). Заполняется только у
    // user-сообщений с attachments, прошедших processAttachmentsAndStream.
    if (!cols.find(c => c.name === 'attachment_result')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN attachment_result TEXT`).run()
    }
    // thinking_blocks — JSON массив [{thinking, signature}] для Anthropic
    // extended thinking. Без signatures Anthropic API отвергает thinking
    // blocks при resubmission в следующем раунде. Поле хранит signatures,
    // чтобы после перезахода в чат агент мог продолжить с extended thinking.
    if (!cols.find(c => c.name === 'thinking_blocks')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN thinking_blocks TEXT`).run()
    }
    // hidden_from_context — сообщение скрыто из AI-контекста редактором чата:
    // пользователь видит его в чате (затемнено, с пометкой), но getLiveMessages
    // исключает его из промпта, счётчика контекста и компакции.
    if (!cols.find(c => c.name === 'hidden_from_context')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN hidden_from_context INTEGER NOT NULL DEFAULT 0`).run()
    }
    // reply_to — JSON ReplyTarget[]: реплай-цитаты user-сообщения (на какие
    // сообщения отвечает). Для рендера цитаты в MessageBubble и восстановления
    // реплай-цитаты в AI-контексте на следующих ходах (messageToContextMessages).
    if (!cols.find(c => c.name === 'reply_to')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN reply_to TEXT`).run()
    }
    // orchestration — JSON-снапшот фаз one-turn оркестрации (/orchestrate):
    // по записи на фазу (planning/executing/reviewing/replanning) со статусом,
    // моделью и таймингами. Пишется только у assistant-сообщений
    // оркестрированного рана (см. main/ipc/orchestrationRun.slimOrchestrationPhases),
    // чтобы карточка прогресса восстанавливалась после перезахода в чат.
    if (!cols.find(c => c.name === 'orchestration')) {
      db.prepare(`ALTER TABLE messages ADD COLUMN orchestration TEXT`).run()
    }
  }

  // Cleanup requires the attachments column, including on first launch.
  stripMessageAttachmentDataUrls(db)

  // chat_draft_attachments — вложения черновика (переживают рестарт, не
  // пропадают при смене чата). Картинки хранятся как файлы в
  // userData/draft-attachments/{chatId}/, в БД — только путь + метаданные.
  // Текстовые файлы из @mention хранят только путь (содержимое читается
  // при отправке). DELETE CASCADE — удаляем при удалении чата.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_draft_attachments (
      id          TEXT PRIMARY KEY,
      chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      name        TEXT NOT NULL,
      path        TEXT,
      rel_path    TEXT,
      mime        TEXT,
      size        INTEGER,
      source      TEXT NOT NULL,
      data_url    TEXT,
      skill_id    TEXT,
      command_name TEXT,
      snippet     TEXT,
      attached_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cda_chat ON chat_draft_attachments(chat_id);
  `)

  // mcp_server_id — прикреплённый к сообщению MCP-сервер (kind='mcp'):
  // id сервера из McpManager; main инжектит его инструменты в контекст запроса.
  const cdaCols = db.prepare(`PRAGMA table_info(chat_draft_attachments)`).all() as Array<{ name: string }>
  if (!cdaCols.find(c => c.name === 'mcp_server_id')) {
    db.prepare(`ALTER TABLE chat_draft_attachments ADD COLUMN mcp_server_id TEXT`).run()
  }

  // ── Notes: фича удалена (UI-панель, IPC, manage_notes-тул) ────────────────
  // Таблица дропается идемпотентно: на новой БД — no-op, на старой —
  // освобождает данные, которые больше никто не читает.
  db.exec(`DROP TABLE IF EXISTS notes;`)

  // ── streaming_buffers: чекпоинты активного стриминга ──────────────────────
  // Промежуточные чекпоинты assistant-ответа (каждые 3с во время стриминга).
  // Раньше писались прямо в messages → каждый чекпоинт дёргал FTS5-триггеры
  // messages_fts (DELETE+INSERT пересобирали индекс всего content) → фризы
  // main на слабых машинах. Здесь — сырой JSON БЕЗ триггеров; финальную
  // полную версию пишет sendDone в messages (один раз, с триггерами) и
  // удаляет буфер. Если процесс упал — буфер переносится в messages при
  // загрузке чата (краш-рекавери в historyCache). FK на chats нет намеренно:
  // буферы чистим явно при deleteChat/rewind (см. deleteStreamingBuffersForChat).
  db.exec(`
    CREATE TABLE IF NOT EXISTS streaming_buffers (
      message_id TEXT PRIMARY KEY NOT NULL,
      chat_id    TEXT NOT NULL,
      payload    TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_streaming_buffers_chat ON streaming_buffers(chat_id);
  `)

  // ── Dots: always-on фоновые агенты ────────────────────────────────────────
  // dots — конфиги (имя, аватар, цель, правила, расписание, модель, chatId).
  // dot_runs — история пробуждений (триггер, статус report/silent/error,
  // резюме, токены). Чат Dot'а — обычный чат в chats (FK без CASCADE:
  // удаление чата Dot'а чистит dot через DotManager, не через БД).
  // Одноразовый per-file undo. Снапшоты остаются в file_snapshots для rewind;
  // таблица хранит только факт использованной кнопки (redo для неё нет).
  db.exec(`
    CREATE TABLE IF NOT EXISTS per_file_undo_consumed (
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_message_id TEXT NOT NULL,
      path_key TEXT NOT NULL,
      consumed_at INTEGER NOT NULL,
      PRIMARY KEY(chat_id, user_message_id, path_key)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS dots (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      emoji           TEXT NOT NULL DEFAULT '🟣',
      color           TEXT NOT NULL DEFAULT '#7c6cff',
      purpose         TEXT NOT NULL,
      rules           TEXT,
      schedule_kind   TEXT CHECK(schedule_kind IN ('cron','interval')),
      schedule_value  TEXT,
      watch_paths     TEXT,
      webhook_enabled INTEGER NOT NULL DEFAULT 0,
      webhook_secret  TEXT,
      model_id        TEXT,
      model_provider  TEXT,
      chat_id         TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dots_chat ON dots(chat_id);
    CREATE TABLE IF NOT EXISTS dot_runs (
      id                TEXT PRIMARY KEY,
      dot_id            TEXT NOT NULL,
      trigger           TEXT NOT NULL CHECK(trigger IN ('cron','interval','webhook','fs','manual')),
      started_at        INTEGER NOT NULL,
      finished_at       INTEGER,
      status            TEXT NOT NULL CHECK(status IN ('running','report','silent','error','cancelled')),
      summary           TEXT,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_dot_runs_dot ON dot_runs(dot_id, started_at DESC);
  `)

  // ── Одноразовая чистка гигантских tool-результатов в истории ──────────────
  // Инцидент: PowerShell-fallback search_code вернул 5.59MB (совпадение в
  // минифицированном бандле — одна строка = мегабайты). search_code исключён
  // из truncateToolResult, своего потолка у fallback не было → шаг сохранился
  // в tool_steps сырым → messageToContextMessages разворачивает шаги целиком →
  // оценка контекста ~1.8M токенов → порог компакции (85% окна) превышен на
  // КАЖДОМ сообщении: divider ставится перед гигантским Message и не может
  // его разрезать — цикл «сжатие на каждом запросе». Обрезаем tool_result-шаги
  // и их копии в iterations[].steps (UI-таймлайн) до head+tail.
  // Строго одноразово через PRAGMA user_version: фильтр по length(tool_steps)
  // ловит и легитимно «толстые» строки (много средних результатов в сумме),
  // повторный скан каждый старт = лишние сотни мс JSON.parse. FTS-триггер
  // не задет (AFTER UPDATE OF content, мы эти колонки не трогаем).
  {
    const MIGRATION_GIANT_TOOL_RESULTS = 1
    const currentUserVersion = db.pragma('user_version', { simple: true }) as number
    if (currentUserVersion < MIGRATION_GIANT_TOOL_RESULTS) {
      const GIANT_CHARS = 200_000
      const giantRows = db.prepare(
        `SELECT id, tool_steps, iterations FROM messages
         WHERE length(tool_steps) > ? OR length(iterations) > ?`
      ).all(GIANT_CHARS, GIANT_CHARS) as Array<{ id: string; tool_steps: string | null; iterations: string | null }>
      if (giantRows.length > 0) {
        const t0 = Date.now()
        const trimGiant = (content: string): string =>
          content.slice(0, 10_000) +
          `\n\n…[обрезано миграцией: гигантский tool-результат (${content.length.toLocaleString('en-US')} символов) отравлял оценку контекста — оставлены начало и конец]…\n\n` +
          content.slice(-2_000)
        const capStep = (s: { type?: string; content?: unknown } | undefined): number => {
          if (!s || s.type !== 'tool_result') return 0
          const content = s.content
          if (typeof content !== 'string' || content.length <= GIANT_CHARS) return 0
          s.content = trimGiant(content)
          return content.length
        }
        const updateRow = db.prepare(`UPDATE messages SET tool_steps = ?, iterations = ? WHERE id = ?`)
        let cappedSteps = 0
        let freedChars = 0
        db.transaction(() => {
          for (const row of giantRows) {
            let changed = false
            const steps = row.tool_steps ? JSON.parse(row.tool_steps) as Array<{ type?: string; content?: unknown }> : null
            if (steps) {
              for (const s of steps) {
                const beforeLen = capStep(s)
                if (beforeLen > 0) { freedChars += beforeLen; cappedSteps++; changed = true }
              }
            }
            let iterationsOut = row.iterations
            if (row.iterations) {
              const iterations = JSON.parse(row.iterations) as Array<{ steps?: Array<{ type?: string; content?: unknown }> }> | null
              if (Array.isArray(iterations)) {
                let iterChanged = false
                for (const it of iterations) {
                  if (!Array.isArray(it?.steps)) continue
                  for (const s of it.steps) {
                    if (capStep(s) > 0) iterChanged = true
                  }
                }
                if (iterChanged) { iterationsOut = JSON.stringify(iterations); changed = true }
              }
            }
            if (changed) {
              updateRow.run(steps ? JSON.stringify(steps) : row.tool_steps, iterationsOut, row.id)
            }
          }
        })()
        console.log(`[migrations] giant tool results: trimmed ${cappedSteps} steps across ${giantRows.length} messages, ~${(freedChars / 1024 / 1024).toFixed(1)}MB freed in ${Date.now() - t0}ms`)
      }
      db.pragma(`user_version = ${MIGRATION_GIANT_TOOL_RESULTS}`)
    }
  }
}
