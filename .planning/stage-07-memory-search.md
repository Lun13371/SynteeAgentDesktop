# СТАДИЯ 07 — ПАМЯТЬ И ПОИСК

> Цель: Syntee получает долгосрочную память и умный контекст. Семантический
> поиск по истории, история буфера обмена, контекст вкладок браузера.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- LanceDB: все сообщения векторизуются при сохранении
- Семантический поиск по истории чатов (по смыслу, не по словам)
- MemoryManager: категории (личное/работа/предпочтения/проекты)
- ContextBuilder: собирает умный контекст перед каждым запросом
- ClipboardManager: история последних 50 записей + автодобавление в контекст
- ScreenWatcher: фоновый мониторинг + уведомление при важных изменениях
- Контекст открытых вкладок браузера через Playwright
- Контекст активного окна (приложение + заголовок)
- Автосмена темы по времени суток
- Поисковая система: Tavily + Brave + WebFetch + DDG fallback

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
@lancedb/lancedb — векторная БД (уже есть со стадии 03)
chokidar — наблюдение за файлами
```

---

## ЗАДАЧИ

### 1. VectorStore.ts — улучшенный

```typescript
// src/core/memory/VectorStore.ts
// (уже создан в стадии 03, дополняем)

// Добавить методы:
async addMessage(message: {
  id: string
  chatId: string
  content: string
  role: 'user' | 'assistant'
  timestamp: number
}): Promise<void> {
  const vector = await this.ai.embed(message.content)
  await this.table.add([{ ...message, vector }])
}

async searchSimilar(query: string, limit = 5): Promise<SearchResult[]> {
  const queryVector = await this.ai.embed(query)
  return await this.search(queryVector, limit)
}

async searchInChat(query: string, chatId: string, limit = 5) {
  const queryVector = await this.ai.embed(query)
  return await this.table
    .search(queryVector)
    .where(`chatId = '${chatId}'`)
    .limit(limit)
    .toArray()
}
```

### 2. ContextBuilder.ts — сборщик контекста

```typescript
// src/core/memory/ContextBuilder.ts
import type { MemoryManager } from './MemoryManager'
import type { VectorStore } from './VectorStore'
import type Database from 'better-sqlite3'
import type { ClipboardManager } from '../system/ClipboardManager'
import type { WindowManager } from '../system/WindowManager'
import type Store from 'electron-store'

export class ContextBuilder {
  constructor(
    private memory: MemoryManager,
    private vectors: VectorStore,
    private db: Database.Database,
    private clipboard: ClipboardManager,
    private windowManager: WindowManager,
    private store: Store,
  ) {}

  async build(params: {
    chatId: string
    userMessage: string
    includeScreen?: boolean
    screenPath?: string
  }): Promise<string> {
    const userName = this.store.get('userName') as string
    const parts: string[] = []

    // 1. Базовый промпт
    parts.push(`Ты — Syntee, умный персональный ассистент.`)
    if (userName) parts.push(`Пользователя зовут ${userName}.`)
    parts.push(`Отвечай на русском языке, дружелюбно, с юмором.`)
    parts.push(`Сегодня: ${new Date().toLocaleDateString('ru-RU', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    })}`)

    // 2. Память о пользователе
    const memories = this.memory.getAll()
    if (memories.length > 0) {
      parts.push(`\nЧто ты знаешь о пользователе:`)
      const grouped = this.groupByCategory(memories)
      for (const [cat, facts] of Object.entries(grouped)) {
        parts.push(`[${cat}]: ${facts.map(f => `${f.key}: ${f.value}`).join(', ')}`)
      }
    }

    // 3. Релевантные сообщения из истории (семантический поиск)
    const similar = await this.vectors.searchSimilar(params.userMessage, 3)
    if (similar.length > 0) {
      parts.push(`\nПохожие прошлые разговоры:`)
      similar.forEach(s => {
        parts.push(`- [${new Date(s.timestamp).toLocaleDateString()}] ${s.content.slice(0, 100)}`)
      })
    }

    // 4. Активное окно
    const activeWindow = await this.windowManager.getActive()
    if (activeWindow) {
      parts.push(`\nАктивное приложение: ${activeWindow.owner.name}`)
      if (activeWindow.title) parts.push(`Заголовок: ${activeWindow.title}`)
    }

    // 5. Последние 3 записи из буфера обмена
    const clipboard = this.clipboard.getHistory(3)
    if (clipboard.length > 0) {
      parts.push(`\nПоследнее в буфере обмена: ${clipboard[0].content.slice(0, 100)}`)
    }

    // 6. Скриншот экрана (только в голосовом режиме)
    if (params.includeScreen && params.screenPath) {
      parts.push(`\n[Пользователь показывает экран — используй изображение для ответа]`)
    }

    return parts.join('\n')
  }

  private groupByCategory(memories: Memory[]) {
    return memories.reduce((acc, m) => {
      if (!acc[m.category]) acc[m.category] = []
      acc[m.category].push(m)
      return acc
    }, {} as Record<string, Memory[]>)
  }
}
```

### 3. ClipboardManager.ts

```typescript
// src/core/system/ClipboardManager.ts
import { clipboard, nativeImage } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import type Database from 'better-sqlite3'

export class ClipboardManager {
  private lastContent = ''
  private interval: NodeJS.Timeout | null = null

  constructor(private db: Database.Database) {}

  start(): void {
    // Проверять каждые 500мс
    this.interval = setInterval(() => {
      this.checkClipboard()
    }, 500)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }

  private checkClipboard(): void {
    const text = clipboard.readText()
    if (text && text !== this.lastContent && text.trim().length > 0) {
      this.lastContent = text
      this.save({ type: 'text', content: text })
    }
  }

  private save(entry: { type: 'text' | 'image' | 'file', content: string }): void {
    const now = Date.now()
    // Не сохранять дубликаты
    const existing = this.db.prepare(
      'SELECT id FROM clipboard_history WHERE content = ? AND created_at > ?'
    ).get(entry.content, now - 60000) // в течение минуты

    if (!existing) {
      this.db.prepare(`
        INSERT INTO clipboard_history (id, type, content, created_at)
        VALUES (?, ?, ?, ?)
      `).run(uuidv4(), entry.type, entry.content.slice(0, 10000), now)

      // Держать только 50 последних
      this.db.prepare(`
        DELETE FROM clipboard_history WHERE id NOT IN (
          SELECT id FROM clipboard_history ORDER BY created_at DESC LIMIT 50
        )
      `).run()
    }
  }

  getHistory(limit = 20): ClipboardEntry[] {
    return this.db.prepare(
      'SELECT * FROM clipboard_history ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as ClipboardEntry[]
  }

  clear(): void {
    this.db.prepare('DELETE FROM clipboard_history').run()
  }
}
```

### 4. ScreenWatcher.ts — агент-наблюдатель

```typescript
// src/core/screen/ScreenWatcher.ts
import { EventEmitter } from 'events'
import type { ScreenCapture } from './ScreenCapture'
import type { VisionService } from '../ai/VisionService'
import { BrowserWindow } from 'electron'

export class ScreenWatcher extends EventEmitter {
  private interval: NodeJS.Timeout | null = null
  private lastAnalysis = ''
  private isActive = false

  constructor(
    private capture: ScreenCapture,
    private vision: VisionService,
  ) { super() }

  startWatching(intervalMs = 5000): void {
    this.isActive = true
    this.interval = setInterval(async () => {
      if (!this.isActive) return
      await this.analyzeScreen()
    }, intervalMs)
  }

  stopWatching(): void {
    this.isActive = false
    if (this.interval) clearInterval(this.interval)
  }

  private async analyzeScreen(): Promise<void> {
    try {
      const imagePath = await this.capture.captureFullScreen()

      // Быстрый анализ: изменилось ли что-то важное?
      const analysis = await this.getQuickAnalysis(imagePath)

      if (this.hasImportantChange(analysis)) {
        this.emit('important_change', { imagePath, analysis })
        this.notifyUser(analysis)
      }

      this.lastAnalysis = analysis
    } catch {}
  }

  private async getQuickAnalysis(imagePath: string): Promise<string> {
    // Упрощённый анализ — только важные изменения
    const result: string[] = []
    // Используем gemini-3.5-flash
    for await (const token of await this.vision.analyzeImage({
      imagePath,
      prompt: 'Кратко опиши что на экране. Есть ли ошибки, уведомления, важные изменения? Один абзац.'
    })) {
      result.push(token)
    }
    return result.join('')
  }

  private hasImportantChange(analysis: string): boolean {
    const keywords = ['ошибка', 'error', 'предупреждение', 'warning', 'уведомление', 'завершено', 'failed', 'success']
    return keywords.some(kw => analysis.toLowerCase().includes(kw))
  }

  private notifyUser(analysis: string): void {
    const win = BrowserWindow.getAllWindows()[0]
    win?.webContents.send('watcher:notification', { message: analysis })
  }
}
```

### 5. SearchRouter.ts — система поиска

```typescript
// src/core/integrations/search/SearchRouter.ts
import type Store from 'electron-store'

interface SearchResult {
  title: string
  url: string
  snippet: string
  content?: string
}

export class SearchRouter {
  private providers: SearchProvider[]

  constructor(store: Store) {
    this.providers = [
      new TavilyProvider(store.get('tavilyKey') as string),
      new BraveProvider(store.get('braveKey') as string),
      new WebFetchProvider(),
      new DDGProvider(),
    ]
  }

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    for (const provider of this.providers) {
      try {
        const results = await provider.search(query, limit)
        if (results.length > 0) return results
      } catch {
        continue // переключиться на следующий провайдер
      }
    }
    return []
  }
}

class TavilyProvider {
  constructor(private apiKey: string) {}

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    if (!this.apiKey) throw new Error('No Tavily key')
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: limit,
        include_raw_content: false,
      })
    })
    const data = await response.json()
    return data.results?.map((r: any) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    })) ?? []
  }
}

class WebFetchProvider {
  async search(url: string): Promise<SearchResult[]> {
    // Прямой fetch URL с очисткой через readability
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    })
    const html = await response.text()
    // Простое извлечение текста без JS
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000)
    return [{ title: url, url, snippet: text, content: text }]
  }
}
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/core/memory/
  VectorStore.ts          ← обновить
  ContextBuilder.ts       ← обновить
  MemoryManager.ts        ← обновить
src/core/system/
  ClipboardManager.ts     ← новый
  WindowManager.ts        ← обновить (active-win)
src/core/screen/
  ScreenWatcher.ts        ← новый
src/core/integrations/search/
  SearchRouter.ts         ← новый
  TavilyProvider.ts       ← новый
  BraveProvider.ts        ← новый
  WebFetchProvider.ts     ← новый
  DDGProvider.ts          ← новый
src/renderer/components/widgets/
  ClipboardHistory/       ← новый
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] Сохранить сообщение → векторизуется автоматически
- [ ] Семантический поиск: "про python" находит старые разговоры о питоне
- [ ] Скопировал текст → попал в историю буфера обмена
- [ ] История буфера видна в виджете
- [ ] Контекст содержит активное окно при отправке
- [ ] Агент-наблюдатель запускается → при ошибке на экране уведомление
- [ ] Поиск через Tavily работает
- [ ] При недоступности Tavily переключается на Brave
- [ ] WebFetch: "fetch https://..." → получает текст страницы
- [ ] Автосмена темы по времени работает
