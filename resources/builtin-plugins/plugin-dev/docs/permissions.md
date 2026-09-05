# Права (permissions)

Каждое право гейтит семейство host-API. Вызов API без права кидает `Permission denied: … требует "<perm>"`. Права показываются пользователю в consent-диалоге при первом включении. Неизвестные права лоадер молча вырезает — плагин упадёт при вызове, поэтому сверяй имена.

| Право | Что даёт |
|---|---|
| `net` | `net.fetch` (HTTP), `net.ws.*` (WebSocket), `shell.openExternal` |
| `fs:read` | `fs.readFile` / `fs.listDir` / `fs.stat` (любые пути) + `fs.watch` |
| `fs:write` | `fs.writeFile` / `mkdir` / `delete` / `rename` / `copy` / `writeFiles` **только внутри папки плагина** |
| `fs:write:any` | Запись/создание/удаление в **любых** путях (для генераторов проектов и т.п.) |
| `clipboard` | `clipboard.readText` / `writeText` |
| `notifications` | `notifications.show` (системные уведомления, кнопки-actions) |
| `ui` | `registerUi` / `registerPanel` / виджеты / модалки / `statusbar` / `sound.play` / `window.toast/dialog` / `fs.pickFile/pickDir` / markdown-рендереры / поиск / autocomplete / контекстное меню / input actions / темы / фоны |
| `chat` | `chat.send` / `chat.reply` (действия в активном чате) |
| `chats:read` | `chats.list` / `chats.get` / `chats.getAttachments` / `chats.open` |
| `chats:write` | `chats.create/rename/delete`, `chats.appendMessage/editMessage/deleteMessage` |
| `projects:read` | `projects.list` / `projects.current` |
| `projects:write` | `projects.create` |
| `memory` | `memory.search` / `memory.save` / `memory.chat.*` |
| `ai` | `ai.chat` (LLM хоста, вкл. vision и стриминг), `ai.embed`, `ai.listModels`, `ai.generateImage` |
| `scheduler` | `scheduler.every` / `cron` / `at` |
| `shortcuts` | `registerShortcut` / `unregisterShortcut` (глобальные горячие клавиши) |
| `process:exec` | `process.exec` (shell-команды через хост, таймаут ≤ 120 с) |
| `overlay` | `overlay.show` / `hide` (окно поверх всего) |
| `tray` | `tray.setMenu` / `clearMenu` |
| `context` | `registerContextProvider` (динамический markdown в system prompt) |
| `secrets` | `secrets.get/set/delete` (шифрованное хранилище, safeStorage) |
| `git` | `git.status/diff/log/commit/branches` |
| `mcp` | `mcp.listTools` / `mcp.call` (тулы MCP-серверов приложения) |
| `webhook` | `net.listen` / `net.close` (локальный HTTP-сервер) |
| `agent` | `agent.useTool` (host-туры), `agent.run` (субагент; пишущие тулы — дополнительно `fs:write:any`) |
| `hooks` | Подписка на события контента: `chat:message`, `chat:before-send`, `chat:completed`, `message:delta`, `tool:call`, `tool:result`, `prompt:before-build` (чтение/изменение переписки и промпта) |

## Принципы

- **Минимум прав**: проси только то, что реально используешь — consent-диалог показывает весь список, `fs:write:any` и `process:exec` пугают пользователей.
- `fs:write` достаточно для своих данных (кэш, состояние) — пиши в `syntee.pluginDir`.
- `fs:write:any` — для плагинов-генераторов (создание проектов, файлов пользователя). Помни: запись вне песочницы — доверенная операция.
- Права проверяются в рантайме при каждом вызове — фильтр лоадера + проверка хоста.
