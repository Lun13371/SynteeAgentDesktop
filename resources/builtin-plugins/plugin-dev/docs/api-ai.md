# API: AI, агент, MCP

## ai — LLM через хост (`ai`)

Биллинг и модели централизованы в приложении — плагин не хранит ключи.

```js
// Простой вызов
const answer = await syntee.ai.chat('Переведи на английский: привет', {
  system: 'Ты переводчик. Отвечай только переводом.',
  model: '…',            // опционально: id модели приложения
  maxTokens: 1024,       // ≤ 8192
})

// Vision: массив сообщений с картинками
const desc = await syntee.ai.chat([
  { type: 'text', text: 'Что на картинке?' },
  { type: 'image', path: 'C:/pic.png' },        // или url: 'https://…' / base64: '…'
])

// Стриминг
let full = ''
const text = await syntee.ai.chat('Расскажи историю', {
  stream: true,
  onDelta: (delta) => { full += delta; syntee.ui.emit('stream', { delta }) },
})

// Эмбеддинги (вектор текста, хостовый эмбеддер)
const vec = await syntee.ai.embed('текст')      // number[], ≤ 32k символов

// Доступные модели
const models = await syntee.ai.listModels()     // [{ id, providerId, name, contextWindow }]

// Генерация изображения → markdown '![…](url)' с временной ссылкой
const md = await syntee.ai.generateImage('кот-космонавт', { size: '1024x1024' })
```

## agent — тулы и субагенты (`agent`)

```js
// Прямой вызов host-тулов агента:
//   read-only: read_file, search_code, list_directory, find_files, search_web
//   запись:    write_file, edit_file (дополнительно требует 'fs:write:any')
const files = await syntee.agent.useTool('find_files', {
  pattern: '*.ts', path: workdir,
})
const res = await syntee.agent.useTool('search_web', { query: 'electron utilityProcess docs' })
await syntee.agent.useTool('write_file', { path: 'C:/x.txt', content: '…' })

// Полноценный субагент (воркер + все тулы + планировщик). Возвращает summary.
const { agentId, summary } = await syntee.agent.run(
  'Найди в проекте все TODO и составь список по файлам',
  { model: '…', workdir: 'C:/Projects/app' },
)
```

`agent.run` — для многошаговых задач; пиши задание конкретно, как промпт субагенту. Пишущие тулы субагента требуют `fs:write:any`.

## mcp — тулы MCP-серверов (`mcp`)

```js
const tools = await syntee.mcp.listTools()      // [{ server, name, description }]
const res = await syntee.mcp.call('server-name', 'tool-name', { arg: 1 })
```

MCP-серверы настраиваются в приложении (`~/.syntee/mcp.json` / `.mcp.json`) — плагин может вызывать их тулы без своего MCP-клиента.

## Паттерн «AI-тул»

Тул плагина + ai.chat = кастомная AI-фича с чистым UX:

```js
syntee.registerTool({
  name: 'summarize_url',
  description: 'Summarize a web page content',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  handler: async ({ url }) => {
    const r = await syntee.net.fetch(url)
    return await syntee.ai.chat(
      'Summarize this page in 5 bullet points:\n\n' + r.body.slice(0, 20000),
      { system: 'You are a concise summarizer.' },
    )
  },
})
```
