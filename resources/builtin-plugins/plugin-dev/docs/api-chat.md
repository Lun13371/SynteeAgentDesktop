# API: чаты, проекты, память

## chat — действия в активном чате (`chat`)

```js
// Отправить сообщение ОТ ИМЕНИ ПОЛЬЗОВАТЕЛЯ — запускает агента.
// attachments — файлы к сообщению: текст инлайном, картинки → vision.
await syntee.chat.send('Проверь файл', {
  attachments: [
    { path: 'C:/report.txt', name: 'report.txt', kind: 'file' },
    { path: 'C:/pic.png', kind: 'image' },
  ],
})

// silent: true — только вставить текст в поле ввода, не отправлять
await syntee.chat.send('черновик', { silent: true })

// Вставить ответ ОТ ИМЕНИ ПЛАГИНА (не запускает агента)
await syntee.chat.reply('Готово: найдено 3 файла.')
```

## chats — чтение и изменение чатов

```js
// 'chats:read'
const list = await syntee.chats.list()          // [{ id, title, createdAt, updatedAt }]
const full = await syntee.chats.get(chatId)     // { chat: {...}, messages: [...] } | null
await syntee.chats.open(chatId)                 // переключить активный чат в UI
const atts = await syntee.chats.getAttachments(messageId)  // [{ id, kind, name, path, mime, size }]

// 'chats:write'
const { id } = await syntee.chats.create('Новый чат', projectId?)
await syntee.chats.rename(chatId, 'Новое имя')
await syntee.chats.delete(chatId)
const { id: msgId } = await syntee.chats.appendMessage(chatId, 'assistant', 'текст')
await syntee.chats.editMessage(msgId, 'новый текст')
await syntee.chats.deleteMessage(msgId)
```

## projects (`projects:read` / `projects:write`)

```js
const list = await syntee.projects.list()       // [{ id, name, workdir }]
const cur = await syntee.projects.current()     // { chatId, projectId?, projectName?, workdir? }
const p = await syntee.projects.create('C:/Projects/app', { name: 'Моё приложение', projectContext: 'что за проект' })
```

`projects.current().workdir` — рабочий каталог активного чата (если чат привязан к проекту). Используй для fs-операций «в проекте пользователя».

## memory — долговременная память (`memory`)

```js
// Поиск по памяти приложения (то же, что у ассистента)
const found = await syntee.memory.search('настройки деплоя')   // [{ … }]

// Сохранить факт
await syntee.memory.save('deploy-key', 'деплой через gh-pages', 'work')

// Заметки, привязанные к чату (попадают в контекст, если у плагина есть context provider)
await syntee.memory.chat.set(chatId, 'summary', 'пользователь делает игру на Unity')
const s = await syntee.memory.chat.get(chatId, 'summary')
await syntee.memory.chat.delete(chatId, 'summary')
```

## Типичный сценарий: контекст плагина в промпте

```js
// 1. Данные (storage/memory)
await syntee.memory.chat.set(chatId, 'todos', ['купить хлеб', 'дописать плагин'])

// 2. Context provider отдаёт их в system prompt перед каждым запросом
syntee.registerContextProvider({
  name: 'todos',
  handler: ({ chatId }) => '## Todos\n' + (await syntee.memory.chat.get(chatId, 'todos')).join('\n'),
})
```

Требует permission `'context'` — см. contributions/events.
