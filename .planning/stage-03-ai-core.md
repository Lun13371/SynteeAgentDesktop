# СТАДИЯ 03 — AI ЯДРО

> Цель: реальный чат с AI. После этой стадии Syntee по-настоящему отвечает,
> стримит текст по токенам, помнит историю, запоминает факты о пользователе,
> предлагает умные подсказки при вводе.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Реальные ответы от AI через https://api.onlysq.ru/ai/openai
- Стриминг токенов — текст печатается по мере генерации
- SQLite БД с историей чатов (сохраняется между запусками)
- Память о пользователе: Syntee сам извлекает факты, тост при запоминании
- Семантический поиск по истории (LanceDB)
- Умные подсказки при вводе (debounce 500ms)
- Резюме чата одной кнопкой
- Экспорт чата (JSON/PDF/Markdown/TXT)
- Режим инкогнито (без записи)
- Выбор модели в настройках
- Контекст активного окна (знает что открыто)

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
openai (npm) — официальный клиент, поддерживает кастомный baseURL
better-sqlite3 — синхронный SQLite для Node.js
@lancedb/lancedb — векторная БД
active-win — активное окно Windows
electron-log — логирование
```

---

## ЗАДАЧИ

### 1. AIClient.ts — базовый клиент

```typescript
// src/core/ai/AIClient.ts
import OpenAI from 'openai'
import { app } from 'electron'
import Store from 'electron-store'

export class AIClient {
  private client: OpenAI
  private store: Store

  constructor(store: Store) {
    this.store = store
    this.client = this.createClient()
  }

  private createClient(): OpenAI {
    return new OpenAI({
      apiKey: this.store.get('apiKey') as string,
      baseURL: this.store.get('apiEndpoint') as string,
    })
  }

  // Пересоздать клиент при смене настроек
  reload() {
    this.client = this.createClient()
  }

  // Стриминг чата — возвращает AsyncIterable
  async *streamChat(params: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }>
    temperature?: number
    maxTokens?: number
  }): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens,
      stream: true,
    })

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }

  // Одиночный запрос без стриминга
  async complete(params: {
    model: string
    messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }>
    temperature?: number
    responseFormat?: 'text' | 'json'
  }): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature ?? 0.3,
      response_format: params.responseFormat === 'json'
        ? { type: 'json_object' }
        : undefined,
      stream: false,
    })
    return response.choices[0].message.content ?? ''
  }

  // Эмбеддинги для векторного поиска
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    })
    return response.data[0].embedding
  }
}
```

### 2. Database.ts — инициализация SQLite

```typescript
// src/core/database/Database.ts
import Database from 'better-sqlite3'
import path from 'path'
import { app } from 'electron'

export function initDatabase(): Database.Database {
  const dbPath = path.join(
    app.getPath('userData'),
    'syntee.db'
  )
  const db = new Database(dbPath)

  // WAL режим для производительности
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Миграции
  runMigrations(db)

  return db
}

function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'Новый чат',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      is_incognito INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_pinned INTEGER DEFAULT 0,
      model TEXT,
      tokens_used INTEGER,
      FOREIGN KEY(chat_id) REFERENCES chats(id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('personal', 'work', 'preferences', 'projects')),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'cancelled')),
      priority INTEGER DEFAULT 0,
      due_date INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source_chat_id TEXT,
      source_message_id TEXT
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stats (
      date TEXT NOT NULL,
      messages_sent INTEGER DEFAULT 0,
      messages_received INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      voice_sessions INTEGER DEFAULT 0,
      screen_captures INTEGER DEFAULT 0,
      PRIMARY KEY(date)
    );

    CREATE TABLE IF NOT EXISTS clipboard_history (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('text', 'image', 'file')),
      content TEXT NOT NULL,
      preview TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `)
}
```

### 3. ChatService.ts — чат с историей

```typescript
// src/core/ai/ChatService.ts
import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import type { AIClient } from './AIClient'
import type Store from 'electron-store'
import { MemoryManager } from '../memory/MemoryManager'
import { ContextBuilder } from '../memory/ContextBuilder'

export class ChatService {
  constructor(
    private db: Database.Database,
    private ai: AIClient,
    private store: Store,
    private memory: MemoryManager
  ) {}

  // Создать новый чат
  createChat(incognito = false): string {
    const id = uuidv4()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO chats (id, title, created_at, updated_at, is_incognito)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 'Новый чат', now, now, incognito ? 1 : 0)
    return id
  }

  // Получить все чаты для сайдбара
  getChats(): Chat[] {
    return this.db.prepare(`
      SELECT c.*, 
        (SELECT content FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count
      FROM chats c
      WHERE c.is_incognito = 0
      ORDER BY c.updated_at DESC
    `).all() as Chat[]
  }

  // Получить сообщения чата
  getMessages(chatId: string): Message[] {
    return this.db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC
    `).all(chatId) as Message[]
  }

  // Отправить сообщение и получить стриминг ответ
  async *sendMessage(params: {
    chatId: string
    content: string
    attachments?: Array<{ type: 'image' | 'file', data: string, name: string }>
    incognito?: boolean
  }): AsyncIterable<{ type: 'token' | 'done' | 'error', data?: string }> {
    const { chatId, content, incognito } = params
    const model = this.store.get('mainModel') as string
    const now = Date.now()

    // Сохранить сообщение пользователя
    if (!incognito) {
      const userMsgId = uuidv4()
      this.db.prepare(`
        INSERT INTO messages (id, chat_id, role, content, created_at)
        VALUES (?, ?, 'user', ?, ?)
      `).run(userMsgId, chatId, content, now)

      // Обновить время чата
      this.db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`)
        .run(now, chatId)

      // Автоназвание чата по первому сообщению
      const chat = this.db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as Chat
      if (chat.title === 'Новый чат') {
        const title = content.slice(0, 40) + (content.length > 40 ? '...' : '')
        this.db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, chatId)
      }
    }

    // Собрать контекст
    const context = await this.buildContext(chatId, content)
    const messages = await this.buildMessages(chatId, content, context)

    // Стриминг ответа
    let fullResponse = ''
    const assistantMsgId = uuidv4()

    try {
      for await (const token of this.ai.streamChat({ model, messages })) {
        fullResponse += token
        yield { type: 'token', data: token }
      }

      // Сохранить ответ
      if (!incognito) {
        this.db.prepare(`
          INSERT INTO messages (id, chat_id, role, content, created_at, model)
          VALUES (?, ?, 'assistant', ?, ?, ?)
        `).run(assistantMsgId, chatId, fullResponse, Date.now(), model)

        // Извлечь факты для памяти асинхронно
        this.memory.extractAndStore(content, fullResponse).catch(console.error)

        // Обновить статистику
        this.updateStats()
      }

      yield { type: 'done' }
    } catch (error: any) {
      yield { type: 'error', data: error.message }
    }
  }

  // Собрать системный промпт с контекстом
  private async buildContext(chatId: string, userMessage: string): Promise<string> {
    const userName = this.store.get('userName') as string
    const memories = this.memory.getAll()
    const recentMessages = this.getMessages(chatId).slice(-20)

    let context = `Ты — Syntee, умный персональный ассистент.`
    if (userName) context += ` Пользователя зовут ${userName}.`
    context += ` Отвечай на русском языке, дружелюбно, с юмором.`

    if (memories.length > 0) {
      context += `\n\nЧто ты знаешь о пользователе:\n`
      memories.forEach(m => { context += `- [${m.category}] ${m.key}: ${m.value}\n` })
    }

    return context
  }

  private async buildMessages(chatId: string, userMessage: string, systemContext: string) {
    const history = this.getMessages(chatId).slice(-20)
    return [
      { role: 'system' as const, content: systemContext },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: userMessage },
    ]
  }

  private updateStats() {
    const date = new Date().toISOString().split('T')[0]
    this.db.prepare(`
      INSERT INTO stats (date, messages_sent, messages_received) VALUES (?, 1, 1)
      ON CONFLICT(date) DO UPDATE SET 
        messages_sent = messages_sent + 1,
        messages_received = messages_received + 1
    `).run(date)
  }

  // Генерация резюме чата
  async summarizeChat(chatId: string): Promise<string> {
    const messages = this.getMessages(chatId)
    const text = messages.map(m => `${m.role}: ${m.content}`).join('\n')
    const model = this.store.get('mainModel') as string

    return await this.ai.complete({
      model,
      messages: [
        { role: 'system', content: 'Сделай краткое резюме этого чата на русском языке.' },
        { role: 'user', content: text }
      ]
    })
  }
}
```

### 4. MemoryManager.ts — память о пользователе

```typescript
// src/core/memory/MemoryManager.ts
import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'
import type { AIClient } from '../ai/AIClient'
import { BrowserWindow } from 'electron'

export class MemoryManager {
  constructor(
    private db: Database.Database,
    private ai: AIClient
  ) {}

  // Автоматически извлечь факты из переписки
  async extractAndStore(userMessage: string, assistantMessage: string): Promise<void> {
    const model = 'gpt-4o-mini' // быстрая модель для этой задачи

    const result = await this.ai.complete({
      model,
      messages: [{
        role: 'system',
        content: `Ты анализируешь переписку и извлекаешь важные факты о пользователе.
Верни JSON массив фактов: [{"category": "personal|work|preferences|projects", "key": "...", "value": "..."}]
Если фактов нет — верни пустой массив [].
Извлекай только конкретные факты: имена, предпочтения, проекты, работу, привычки.`
      }, {
        role: 'user',
        content: `Пользователь написал: "${userMessage}"\nAssistant ответил: "${assistantMessage}"`
      }],
      responseFormat: 'json',
      temperature: 0.1,
    })

    try {
      const facts = JSON.parse(result) as Array<{
        category: 'personal' | 'work' | 'preferences' | 'projects'
        key: string
        value: string
      }>

      for (const fact of facts) {
        this.upsert(fact.category, fact.key, fact.value)
        // Показать тост пользователю
        this.notifyMemorized(fact)
      }
    } catch {}
  }

  // Явное запоминание ("запомни что...")
  async rememberExplicit(userMessage: string): Promise<boolean> {
    if (!userMessage.toLowerCase().includes('запомни')) return false

    const model = 'gpt-4o-mini'
    const result = await this.ai.complete({
      model,
      messages: [{
        role: 'system',
        content: `Извлеки что нужно запомнить из сообщения. Верни JSON: {"category": "...", "key": "...", "value": "..."} или null если непонятно.`
      }, {
        role: 'user',
        content: userMessage
      }],
      responseFormat: 'json',
    })

    try {
      const fact = JSON.parse(result)
      if (fact) {
        this.upsert(fact.category, fact.key, fact.value)
        this.notifyMemorized(fact)
        return true
      }
    } catch {}
    return false
  }

  upsert(category: string, key: string, value: string) {
    const now = Date.now()
    const existing = this.db.prepare(
      'SELECT id FROM memories WHERE key = ?'
    ).get(key)

    if (existing) {
      this.db.prepare(
        'UPDATE memories SET value = ?, updated_at = ? WHERE key = ?'
      ).run(value, now, key)
    } else {
      this.db.prepare(`
        INSERT INTO memories (id, category, key, value, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), category, key, value, now, now)
    }
  }

  getAll() {
    return this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all() as Memory[]
  }

  getByCategory(category: string) {
    return this.db.prepare('SELECT * FROM memories WHERE category = ?').all(category) as Memory[]
  }

  delete(id: string) {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  private notifyMemorized(fact: { category: string, key: string, value: string }) {
    // Отправить событие в renderer для показа тоста
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send('memory:memorized', {
      message: `Запомнил: ${fact.key} — ${fact.value}`
    })
  }
}
```

### 5. VectorStore.ts — LanceDB семантический поиск

```typescript
// src/core/memory/VectorStore.ts
import * as lancedb from '@lancedb/lancedb'
import path from 'path'
import { app } from 'electron'

export class VectorStore {
  private db!: lancedb.Connection
  private table!: lancedb.Table

  async init(): Promise<void> {
    const dbPath = path.join(app.getPath('userData'), 'vectors')
    this.db = await lancedb.connect(dbPath)

    // Создать таблицу если не существует
    const tables = await this.db.tableNames()
    if (!tables.includes('messages')) {
      this.table = await this.db.createTable('messages', [
        { id: 'init', content: '', vector: new Array(1536).fill(0), chatId: '', timestamp: 0 }
      ])
    } else {
      this.table = await this.db.openTable('messages')
    }
  }

  async add(entry: {
    id: string
    content: string
    vector: number[]
    chatId: string
    timestamp: number
  }): Promise<void> {
    await this.table.add([entry])
  }

  async search(vector: number[], limit = 5): Promise<Array<{
    id: string
    content: string
    chatId: string
    timestamp: number
    score: number
  }>> {
    const results = await this.table
      .search(vector)
      .limit(limit)
      .toArray()

    return results.map(r => ({
      id: r.id,
      content: r.content,
      chatId: r.chatId,
      timestamp: r.timestamp,
      score: r._distance,
    }))
  }

  async delete(id: string): Promise<void> {
    await this.table.delete(`id = '${id}'`)
  }
}
```

### 6. IPC обработчики чата

```typescript
// src/main/ipc/chat.ipc.ts
import { ipcMain } from 'electron'
import type { ChatService } from '../../core/ai/ChatService'

export function registerChatIPC(chatService: ChatService) {
  // Создать чат
  ipcMain.handle('chat:create', (_, incognito = false) => {
    return chatService.createChat(incognito)
  })

  // Получить список чатов
  ipcMain.handle('chat:getAll', () => {
    return chatService.getChats()
  })

  // Получить сообщения
  ipcMain.handle('chat:getMessages', (_, chatId: string) => {
    return chatService.getMessages(chatId)
  })

  // Отправить сообщение (стриминг через события)
  ipcMain.handle('chat:send', async (event, params) => {
    const { chatId, content, incognito } = params
    const webContents = event.sender

    for await (const chunk of chatService.sendMessage({ chatId, content, incognito })) {
      if (chunk.type === 'token') {
        webContents.send('chat:stream:token', chunk.data)
      } else if (chunk.type === 'done') {
        webContents.send('chat:stream:done')
      } else if (chunk.type === 'error') {
        webContents.send('chat:stream:error', chunk.data)
      }
    }
  })

  // Резюме чата
  ipcMain.handle('chat:summarize', (_, chatId: string) => {
    return chatService.summarizeChat(chatId)
  })

  // Удалить чат
  ipcMain.handle('chat:delete', (_, chatId: string) => {
    // удаление через репозиторий
  })

  // Переименовать чат
  ipcMain.handle('chat:rename', (_, chatId: string, title: string) => {
    // переименование
  })
}
```

### 7. useStreamingText хук (renderer)

```typescript
// src/renderer/hooks/useStreamingText.ts
import { useEffect, useRef, useState } from 'react'

export function useStreamingText() {
  const [text, setText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const bufferRef = useRef('')

  useEffect(() => {
    const onToken = (_: any, token: string) => {
      bufferRef.current += token
      setText(bufferRef.current)
    }

    const onDone = () => {
      setIsStreaming(false)
      bufferRef.current = ''
    }

    window.syntee.on('chat:stream:token', onToken)
    window.syntee.on('chat:stream:done', onDone)

    return () => {
      window.syntee.off('chat:stream:token', onToken)
      window.syntee.off('chat:stream:done', onDone)
    }
  }, [])

  const start = () => {
    setIsStreaming(true)
    setText('')
    bufferRef.current = ''
  }

  return { text, isStreaming, start }
}
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/core/
  ai/
    AIClient.ts         ← новый
    ChatService.ts      ← новый
    VisionService.ts    ← заглушка
  memory/
    MemoryManager.ts    ← новый
    VectorStore.ts      ← новый
    ContextBuilder.ts   ← новый
  database/
    Database.ts         ← новый
    schema.ts           ← новый
  system/
    WindowManager.ts    ← новый (active-win)
src/main/ipc/
  chat.ipc.ts           ← новый
  settings.ipc.ts       ← обновить
src/renderer/hooks/
  useStreamingText.ts   ← новый
  useChat.ts            ← обновить
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] Чат отправляет сообщение → получает реальный ответ от AI
- [ ] Текст появляется по токенам (стриминг)
- [ ] После перезапуска история чатов сохранена
- [ ] При новом факте в разговоре — тост "Запомнил: ..."
- [ ] "Запомни что я люблю Python" → факт сохранён в памяти
- [ ] Семантический поиск: похожие сообщения находятся
- [ ] Умные подсказки при вводе (с debounce)
- [ ] Кнопка резюме → краткое изложение чата
- [ ] Режим инкогнито: сообщения не сохраняются
- [ ] Выбор модели в настройках работает
- [ ] Знает активное окно (active-win)
