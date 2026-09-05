# События и хуки — syntee.on(event, handler)

Подписка на события хоста. Fire-and-forget события — просто колбэк; **хуки** — колбэк с ответом (`return { action: 'modify' | 'reject', … }`), хост ждёт результат (таймаут 1.5 с).

## Хуки (могут менять поведение)

### chat:before-send — перехват отправки сообщения

```js
syntee.on('chat:before-send', (p) => {
  // p: { chatId, content }
  if (p.content.includes('пароль')) {
    return { action: 'reject', reason: 'В сообщении есть секрет — отправка заблокирована' }
  }
  if (p.content.includes('/old')) {
    return { action: 'modify', content: p.content.replace('/old', '/new') }
  }
  // undefined / нет return / { action: 'allow' } — пропустить как есть
})
```

### tool:result — модификация результата тула (до модели)

```js
syntee.on('tool:result', (p) => {
  // p: { toolName, args, result }
  if (p.toolName === 'read_file' && String(p.result).includes('REDACTED')) {
    return { action: 'modify', content: String(p.result).replaceAll('REDACTED', '***') }
  }
})
```

### prompt:before-build — последний шанс изменить system prompt

```js
syntee.on('prompt:before-build', (p) => {
  // p: { chatId, prompt }
  return { action: 'modify', content: p.prompt + '\n\n## Дополнение от плагина\n…' }
})
```

## События (уведомления)

| Событие | Payload | Когда |
|---|---|---|
| `chat:message` | `{ chatId, content }` | сообщение пользователя отправлено |
| `chat:completed` | `{ chatId }` | агент закончил ответ |
| `chat:switched` | `{ chatId }` | пользователь переключил активный чат |
| `message:delta` | `{ chatId, delta }` | стриминг ответа (троттлинг 250 мс) |
| `agent:status` | `{ chatId, status, toolName? }` | `started` / `finished` / `error` |
| `tool:call` | `{ toolName, args }` | любой тул вызван (fire-and-forget) |
| `theme:changed` | `{ theme, accentColor, dark }` | смена темы приложения |
| `app:focus` | `{}` | главное окно получило фокус |
| `input-action` | `{ id }` | клик по кнопке над инпутом (registerInputAction без command) |
| `fs:change` | `{ id, event, file }` | сработал fs.watch |
| `ws:open` / `ws:message` / `ws:close` / `ws:error` | `{ id, … }` | WebSocket |
| `scheduler:tick` | `{ id }` | задача планировщика (используется内部 scheduler API) |
| `shortcut` | `{ accelerator }` | глобальный шорткат |
| `tray:action` | `{ label }` | пункт трея без command |
| `webhook:request` | `{ port, method, path, body }` | запрос на net.listen |
| `bus:<name>` | `{ data, from }` | шина между плагинами (syntee.bus.emit) |

## Подписка и short-circuit

Хост шлёт хуковые события только плагинам, которые на них подписаны (при `on('chat:before-send', …)` плагин автоматически регистрирует подписку). Отписки нет — на время жизни процесса.

## Паттерн «реакция на сообщения»

```js
syntee.on('chat:message', async (p) => {
  if (/ошибка|error/i.test(String(p.content))) {
    // мягкая реакция: сохранить в память, ответить панелью и т.п.
    await syntee.memory.chat.set(p.chatId, 'last_error', String(p.content).slice(0, 500))
    syntee.ui.setBadge('main', 1)
  }
})
```

## Паттерн «фильтр приватности»

```js
const BLOCKED = [/sk-[a-zA-Z0-9]{20,}/, /\b\d{16}\b/]   // ключи, номера карт

syntee.on('chat:before-send', (p) => {
  for (const re of BLOCKED) {
    if (re.test(p.content)) {
      return { action: 'reject', reason: 'Обнаружен секрет — убери его из сообщения' }
    }
  }
})
```
