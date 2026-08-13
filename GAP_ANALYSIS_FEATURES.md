# SynteeHelper — Gap Analysis: чего нету и что добавить

> Сравнение с Hermes Agent, Claude Code, Cursor, Windsurf, Cline, Aider, Devin, Continue.dev, Zed AI.
> Дата анализа: 07.08.2026

---

## 🔴 Критически важные — нет у тебя, есть у конкурентов

| # | Фича | Описание | У кого есть | Где реализовать | Приоритет |
|---|------|----------|-------------|-----------------|-----------|
| 1 | **Git integration (авто-коммит, PR, diff review)** | Авто-коммит после правок с осмысленным сообщением, создание PR из чата, diff preview перед коммитом, `git status`/`git diff`/`git log` как нативные тулы | Aider, Claude Code, Cursor | `src/core/tools/git.ts` (новый), UI: `SessionChangesPanel` расширить, IPC: `src/main/ipc/git.ipc.ts` (уже есть — расширить) | 🔥🔥 |
| 2 | **Browser automation** | Тулы: `browser_navigate`, `browser_click`, `browser_extract`, `browser_screenshot`, `browser_fill`. Playwright/Puppeteer под капотом. Веб-скрапинг, тестирование, заполнение форм | Hermes (11 тулов), Devin, Cline | `src/core/tools/browser.ts` (новый) или через MCP Playwright | 🔥🔥 |
| 3 | **Inline completions / Tab autocomplete** | Copilot-style дополнения кода прямо в редакторе. Мониторинг активного окна + лёгкий LLM-вызов для дополнения | Cursor, Continue.dev, GitHub Copilot, Windsurf | Оверлей поверх активного окна: `src/renderer/src/components/ui/InlineCompletion/` (новый) | 🔥🔥 |
| 4 | **Headless / CLI mode** | Запуск `syntee-helper --cli "task"` без UI. Для CI/CD, скриптов, автоматизации | Claude Code, Aider | `src/main/cli.ts` (новый), флаг `--headless` в `src/main/index.ts` | 🔥🔥 |
| 5 | **Local model support (Ollama, LM Studio, llama.cpp)** | Подключение локальных моделей через OpenAI-compatible API. Privacy mode — всё локально, без отправки данных | Hermes, Continue.dev, Cline, Zed | Расширить `src/core/ai/AIClient.ts` (уже OpenAI SDK → просто другой base URL), UI: `ModelSelector` добавить категорию "Local" | 🔥🔥 |

---

## 🟡 Высокий приоритет — нет у тебя, есть у конкурентов

| # | Фича | Описание | У кого есть | Где реализовать | Приоритет |
|---|------|----------|-------------|-----------------|-----------|
| 6 | **Hooks / lifecycle events** | `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Notification`. Shell-команды на события (детерминированные, без LLM) | Claude Code | `src/core/agent/hooks.ts` (новый), конфиг: `.syntee/hooks.json` | 🔥 |
| 7 | **Scheduled tasks / cron** | Планировщик: агент выполняет задачу по расписанию. "Каждый день в 9:00 проверь CI и сообщи статус" | Hermes | `src/core/scheduler/cronManager.ts` (новый), UI в Settings | 🔥 |
| 8 | **Project instructions file (`.syntee/instructions.md`)** | Автозагружаемый файл с инструкциями проекта (как CLAUDE.md). Уже есть `projectInstructions.ts`, но нет автозагрузки из файла проекта | Claude Code (CLAUDE.md), Cursor (.cursorrules) | Расширить `src/core/prompts/projectInstructions.ts` | 🔥 |
| 9 | **Context compaction (automatic)** | Автоматическое сжатие при приближении к лимиту контекста. У тебя есть rolling window + summarization, но нет auto-trigger | Claude Code, Cursor | `src/core/context/contextManager.ts` → добавить auto-trigger в `applyRollingWindowAsync` | 🔥 |
| 10 | **Self-improving skills** | Агент анализирует успешные действия и автоматически создаёт навыки. "Я заметил, что ты всегда делаешь X → Y → Z, создать skill?" | Hermes | Расширить `src/core/skills/skillManager.ts`, добавить тул `skill_create` | 🔥 |
| 11 | **Session search (семантический поиск по прошлым чатам)** | Векторный/embeddings поиск по содержимому прошлых сессий. У тебя есть `chatSearch.ts`, но без embeddings | Hermes | Расширить `src/core/memory/chatSearch.ts` (добавить embeddings) | 🔥 |
| 12 | **Code execution sandbox** | Безопасное выполнение Python/JS кода в изоляции. Для тестирования сниппетов, вычислений | Hermes, Claude Code (sandbox) | `src/core/tools/codeExec.ts` (новый), Docker/подпроцесс | 🔥 |
| 13 | **Multi-file edits (Composer)** | Предсказание правок в нескольких файлах одновременно — агент сам определяет какие файлы править | Cursor (Composer), Windsurf, Cline | Расширить `Agent.ts` → группировать правки, UI: multi-file diff preview | 🔥 |
| 14 | **PR creation из чата** | Создание pull requests напрямую из чата (GitHub/GitLab API) | Aider, Claude Code | `src/core/tools/git.ts` + GitHub API через `http_request` | 🔥 |

---

## 🟢 Средний приоритет — нет у тебя, есть у конкурентов

| # | Фича | Описание | У кого есть | Где реализовать | Приоритет |
|---|------|----------|-------------|-----------------|-----------|
| 15 | **Thinking modes escalation** | `think` → `think harder` → `ultrathink` — больше reasoning budget на сложные задачи | Claude Code | `src/core/prompts/buildSystemPrompt.ts`, параметр в `AIClient.streamChat` | 🟡 |
| 16 | **Kanban board** | Визуальная доска задач (богаче чем todo-list). Drag-and-drop колонки: To Do → In Progress → Done | Hermes | Новая страница `src/renderer/src/pages/Kanban/` | 🟡 |
| 17 | **Messaging integrations (Telegram bot)** | Управление агентом через Telegram. Получение уведомлений о завершении задач | Hermes | `src/core/integrations/telegram.ts` (новый) | 🟡 |
| 18 | **Computer Use / Desktop automation** | Управление мышью/клавиатурой, управление окнами на десктопе | Hermes, Claude (Computer Use) | `src/core/tools/computerUse.ts` (новый) | 🟡 |
| 19 | **Permission rules (per-tool allow/deny)** | Гранулярные per-tool permissions (белые/чёрные списки команд). У тебя есть approval modes, но не per-tool | Claude Code | Расширить `src/core/agent/commandSafety.ts`, UI в Settings | 🟡 |
| 20 | **Remote MCP with OAuth** | OAuth-аутентификация для удалённых MCP серверов | Claude Code | Расширить `src/core/mcp/McpClient.ts` + `McpManager.ts` | 🟡 |
| 21 | **Auto-lint after edits** | Автоматический lint после правок (у тебя есть `get_diagnostics`, но не auto-trigger) | Aider, Cursor | `Agent.ts` → вызов `get_diagnostics` после каждого `edit_file`/`write_file` | 🟡 |
| 22 | **Custom workflows / automation pipelines** | Pipeline: lint → test → deploy. Настраиваемые цепочки выполнения | Windsurf (Flows), Devin | `src/core/workflows/` (новый), UI: workflow builder | 🟡 |
| 23 | **Multi-model orchestration** | Использование разных моделей для разных задач (fast model для поиска, heavy для кода). У тебя есть роли моделей, но нет автоматической оркестрации | Cursor, Windsurf | Расширить `AIClient.ts` → router model, `ModelAssignment` | 🟡 |
| 24 | **Privacy mode** | Локальный режим без отправки данных. Всё работает локально | Cursor, Continue.dev | Связано с #5 (local models) | 🟡 |
| 25 | **Diff preview (side-by-side, partial accept/reject)** | Side-by-side diff с возможностью принять/отклонить отдельные части | Cursor, Cline | Расширить `SessionChangesPanel` + `DiffBlock` | 🟡 |

---

## 🔵 Низкий приоритет / Nice to have

| # | Фича | Описание | У кого есть | Где реализовать | Приоритет |
|---|------|----------|-------------|-----------------|-----------|
| 26 | **TTS (text-to-speech)** | Озвучка ответов агента | Hermes | `AIClient.textToSpeech` уже есть — добавить UI toggle | 🟢 |
| 27 | **Home Assistant integration** | Управление умным домом | Hermes | MCP server или `src/core/integrations/` | 🟢 |
| 28 | **Team collaboration (shared sessions/memory)** | Shared sessions, shared memory между пользователями | Devin | Серверная часть + `messengerClient.ts` | 🟢 |
| 29 | **Memory providers (Honcho, Holographic)** | Продвинутые внешние бэкенды памяти | Hermes | `src/core/memory/` → pluggable providers | 🟢 |
| 30 | **JetBrains / VS Code plugin** | Интеграция с IDE как плагин | Continue.dev, Claude Code | Отдельный plugin проект | 🟢 |

---

## ⚡ Что улучшить в существующем функционале

| # | Что | Сейчас | Как улучшить | Файлы |
|---|-----|--------|-------------|-------|
| U1 | **Memory search** | FTS5 + TF-IDF + embeddings | Добавить семантический поиск по прошлым чатам (embeddings в `chatSearch.ts`) | `src/core/memory/chatSearch.ts` |
| U2 | **MCP** | stdio, sse, streamable-http | Auto-reconnect при обрыве, лучший error handling, OAuth для remote | `src/core/mcp/McpManager.ts`, `McpClient.ts` |
| U3 | **Sub-agents** | spawn_agent с worktree isolation | UI с прогрессом параллельных агентов, кнопка отмены агента | `src/renderer/src/components/ui/AgentPanel/` |
| U4 | **Fast context** | tree-sitter + repo-map + embeddings | Больше языков, incremental indexing, кэширование результатов | `src/core/context/fastContext/indexer.ts` |
| U5 | **Personas** | 7 захардкоженных персон | Кастомные персоны из .md файлов (как custom slash commands) | `src/shared/modes.ts` → загрузка из файлов |
| U6 | **Slash commands** | builtin + custom .md | Больше builtin: `/git`, `/test`, `/deploy`, `/refactor`, `/doc` | `src/shared/slashCommands.ts` |
| U7 | **Approval system** | 3 режима (ask/auto/full) | Per-tool permissions (whitelist команд), как Claude Code | `src/core/agent/commandSafety.ts` |
| U8 | **UI keyboard shortcuts** | Частично | Command palette (расширить Spotlight), hotkeys для частых действий | `src/renderer/src/pages/Spotlight/` |
| U9 | **Model support** | OpenAI + Anthropic | Добавить Google Gemini, Mistral, Cohere, локальные модели | `src/core/ai/AIClient.ts` |
| U10 | **GitPanel** | Есть `GitPanel.tsx` (24.5KB) | Добавить авто-коммит, PR creation, branch management | `src/renderer/src/components/ui/GitPanel/` |

---

## 🏆 Что у тебя УЖЕ ЕСТЬ и нет/слабее у конкурентов (не трогать — это преимущества)

| Фича | Описание | Уникальность |
|------|----------|--------------|
| **Memory Graph** | Граф знаний с визуализацией (`MemoryGraphTab`) | Нет ни у одного конкурента |
| **5-source memory search** | memory + messages + summaries + agent_logs + pinned (параллельный FTS5 + TF-IDF + embeddings) | Уникально |
| **Personas с fine-grained tool allowlists** | 7 персон с разными наборами тулов | Нет ни у кого |
| **Overlay mode** | Поверх всех окон | Уникально для desktop |
| **Spotlight search** | Быстрый поиск (Cmd+Space style) | Уникально |
| **Voice input** | Голосовой ввод (Whisper) | Есть у Hermes, слабее у других |
| **Tray menu** | Системный трей с меню | Уникально |
| **Share chat modal** | Поделиться чатом | Уникально |
| **Chat minimap** | Мини-карта чата | Уникально |
| **Split chat panes** | Разделённые панели чата | Уникально |
| **Checkpoints/rewind** | Откат изменений | Есть у Claude Code, слабее |
| **Queue system** | Очередь задач | Уникально |
| **Marketplace** | Кураторный MCP + skills каталог | Уникально |
| **Animated backgrounds** | 9 тем + анимированный фон | Уникально для desktop |
| **MCP support** | stdio, sse, streamable-http | На уровне Claude Code |
| **Skills system** | builtin, user, project levels + one-shot | На уровне Claude Code |
| **Slash commands** | builtin + custom .md с YAML frontmatter + arguments | На уровне |
| **Command safety** | Классификация опасности команд (safe/warn/dangerous/blocked) | Уникально |
| **Fast context** | tree-sitter индексация + repo-map + embeddings | На уровне Cursor |
| **Context management** | Rolling window, smart summarization, token tracking | На уровне |
| **Model catalog** | Прайсинг, context limits, роли моделей | Уникально |
| **Dual AI provider** | OpenAI + Anthropic native | На уровне |
| **Worktree isolation** | Git worktree для параллельных sub-agents | На уровне Claude Code |
| **Messenger** | Встроенный мессенджер | Уникально |
| **Reasoning models** | ReasoningSelector + reasoningModels.ts | На уровне |

---

## 📋 План реализации (рекомендуемый порядок)

### Фаза 1 — Фундамент (1-2 недели)
1. ✅ Git integration (авто-коммит, diff, PR) — `#1`
2. ✅ Local model support (Ollama/LM Studio) — `#5`
3. ✅ Project instructions file — `#8`
4. ✅ Auto-lint after edits — `#21`

### Фаза 2 — Агент (2-3 недели)
5. ✅ Hooks / lifecycle events — `#6`
6. ✅ Context compaction (auto-trigger) — `#9`
7. ✅ Self-improving skills — `#10`
8. ✅ Code execution sandbox — `#12`

### Фаза 3 — Browser & Autonomy (2-3 недели)
9. ✅ Browser automation — `#2`
10. ✅ Scheduled tasks / cron — `#7`
11. ✅ Headless / CLI mode — `#4`
12. ✅ Multi-file edits (Composer) — `#13`

### Фаза 4 — UX (1-2 недели)
13. ✅ Inline completions — `#3`
14. ✅ Diff preview (side-by-side) — `#25`
15. ✅ Thinking modes escalation — `#15`
16. ✅ Kanban board — `#16`

### Фаза 5 — Интеграции (по желанию)
17. ✅ Telegram bot — `#17`
18. ✅ Computer Use — `#18`
19. ✅ Multi-model orchestration — `#23`
20. ✅ Custom workflows — `#22`

### Фаза 6 — Полировка существующего
21. ✅ Улучшения U1-U10 из таблицы выше

---

## 📊 Сводная статистика

| Категория | Кол-во |
|-----------|--------|
| 🔴 Критически важных | 5 |
| 🟡 Высокий приоритет | 9 |
| 🟢 Средний приоритет | 11 |
| 🔵 Низкий приоритет | 5 |
| ⚡ Улучшений существующего | 10 |
| 🏆 Уникальных преимуществ (не трогать) | 25 |
| **Всего к реализации** | **40** |
