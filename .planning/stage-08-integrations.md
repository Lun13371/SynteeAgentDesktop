# СТАДИЯ 08 — ИНТЕГРАЦИИ

> Цель: Syntee подключается к внешним сервисам. Telegram, Discord, GitHub,
> Spotify, Email, VS Code, расписание задач, цепочки.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Telegram: читать + отправлять сообщения через Bot API
- Discord: полное управление через Discord.js
- GitHub: репозитории, issues, PRs через Octokit
- Spotify: воспроизведение, плейлисты, поиск через Web API + PKCE OAuth
- Email: Gmail/Outlook через OAuth2
- VS Code: видит открытый файл, предлагает правки
- Системный мониторинг: CPU/RAM/диск в реальном времени
- TaskScheduler: расписание с cron-синтаксисом
- ChainRunner: цепочки задач (одна запускает другую)
- Уведомления по расписанию без запроса
- Все интеграции настраиваются в разделе "Интеграции" настроек

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
node-telegram-bot-api — Telegram Bot API
discord.js — Discord
@octokit/rest — GitHub API
spotify-web-api-node — Spotify
nodemailer + googleapis — Email/Gmail
node-cron — расписание задач
systeminformation — CPU/RAM/диск
```

---

## ЗАДАЧИ

### 1. TelegramService.ts

```typescript
// src/core/integrations/telegram/TelegramService.ts
import TelegramBot from 'node-telegram-bot-api'
import type Store from 'electron-store'
import { BrowserWindow } from 'electron'

export class TelegramService {
  private bot: TelegramBot | null = null

  constructor(private store: Store) {}

  connect(): void {
    const token = this.store.get('integrations.telegram.token') as string
    if (!token) return

    this.bot = new TelegramBot(token, { polling: true })

    this.bot.on('message', (msg) => {
      // Передать входящее сообщение в UI
      BrowserWindow.getAllWindows()[0]?.webContents.send('telegram:message', {
        from: msg.from?.username ?? msg.from?.first_name,
        text: msg.text,
        chatId: msg.chat.id,
        date: msg.date,
      })
    })
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    await this.bot?.sendMessage(chatId, text)
  }

  async getUpdates(): Promise<any[]> {
    return await this.bot?.getUpdates() ?? []
  }

  disconnect(): void {
    this.bot?.stopPolling()
    this.bot = null
  }

  get connected(): boolean { return this.bot !== null }
}
```

### 2. DiscordService.ts

```typescript
// src/core/integrations/discord/DiscordService.ts
import { Client, GatewayIntentBits, TextChannel } from 'discord.js'
import type Store from 'electron-store'
import { BrowserWindow } from 'electron'

export class DiscordService {
  private client: Client | null = null

  constructor(private store: Store) {}

  async connect(): Promise<void> {
    const token = this.store.get('integrations.discord.token') as string
    if (!token) return

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ]
    })

    this.client.on('messageCreate', (message) => {
      if (message.author.bot) return
      BrowserWindow.getAllWindows()[0]?.webContents.send('discord:message', {
        author: message.author.username,
        content: message.content,
        channel: message.channel.id,
        guild: (message.guild?.name) ?? 'DM',
      })
    })

    this.client.on('ready', () => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('discord:ready', {
        username: this.client?.user?.username
      })
    })

    await this.client.login(token)
  }

  async sendMessage(channelId: string, text: string): Promise<void> {
    const channel = await this.client?.channels.fetch(channelId) as TextChannel
    await channel?.send(text)
  }

  async getChannels(guildId: string) {
    const guild = await this.client?.guilds.fetch(guildId)
    return guild?.channels.cache.map(c => ({ id: c.id, name: c.name, type: c.type })) ?? []
  }

  disconnect(): void {
    this.client?.destroy()
    this.client = null
  }
}
```

### 3. GitHubService.ts

```typescript
// src/core/integrations/github/GitHubService.ts
import { Octokit } from '@octokit/rest'
import type Store from 'electron-store'

export class GitHubService {
  private octokit: Octokit | null = null

  constructor(private store: Store) {}

  connect(): void {
    const token = this.store.get('integrations.github.token') as string
    if (!token) return
    this.octokit = new Octokit({ auth: token })
  }

  async getRepos(): Promise<any[]> {
    const { data } = await this.octokit!.repos.listForAuthenticatedUser({ sort: 'updated', per_page: 20 })
    return data
  }

  async createIssue(owner: string, repo: string, title: string, body: string) {
    const { data } = await this.octokit!.issues.create({ owner, repo, title, body })
    return data
  }

  async getPRs(owner: string, repo: string) {
    const { data } = await this.octokit!.pulls.list({ owner, repo, state: 'open' })
    return data
  }

  async getFileContent(owner: string, repo: string, path: string): Promise<string> {
    const { data } = await this.octokit!.repos.getContent({ owner, repo, path })
    if ('content' in data) {
      return Buffer.from(data.content, 'base64').toString('utf-8')
    }
    return ''
  }

  async createCommit(params: {
    owner: string, repo: string, branch: string,
    message: string, files: Array<{ path: string, content: string }>
  }) {
    // Создать коммит через Git Data API
    const { data: ref } = await this.octokit!.git.getRef({
      owner: params.owner, repo: params.repo,
      ref: `heads/${params.branch}`
    })
    // ... полная реализация через tree/commit API
  }

  get connected(): boolean { return this.octokit !== null }
}
```

### 4. SpotifyService.ts

```typescript
// src/core/integrations/spotify/SpotifyService.ts
// OAuth через PKCE flow в отдельном окне браузера

export class SpotifyService {
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private baseUrl = 'https://api.spotify.com/v1'

  async authenticate(): Promise<void> {
    // Открыть браузер с OAuth URL
    // Получить code через localhost callback
    // Обменять на токены
    const clientId = process.env.SPOTIFY_CLIENT_ID
    const redirectUri = 'http://localhost:8888/callback'
    const scope = 'user-read-playback-state user-modify-playback-state playlist-read-private'
    
    const authUrl = `https://accounts.spotify.com/authorize?` +
      `client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`
    
    const { shell } = require('electron')
    shell.openExternal(authUrl)
    // Слушать localhost callback через http сервер
  }

  async getCurrentTrack(): Promise<any> {
    return await this.request('/me/player/currently-playing')
  }

  async play(deviceId?: string): Promise<void> {
    await this.request('/me/player/play', 'PUT', deviceId ? { device_id: deviceId } : undefined)
  }

  async pause(): Promise<void> {
    await this.request('/me/player/pause', 'PUT')
  }

  async next(): Promise<void> {
    await this.request('/me/player/next', 'POST')
  }

  async previous(): Promise<void> {
    await this.request('/me/player/previous', 'POST')
  }

  async search(query: string, types = 'track,artist,album'): Promise<any> {
    return await this.request(`/search?q=${encodeURIComponent(query)}&type=${types}&limit=10`)
  }

  async getPlaylists(): Promise<any[]> {
    const data = await this.request('/me/playlists')
    return data.items ?? []
  }

  private async request(endpoint: string, method = 'GET', body?: any): Promise<any> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (response.status === 204) return null
    return response.json()
  }
}
```

### 5. TaskScheduler.ts

```typescript
// src/core/scheduler/TaskScheduler.ts
import cron from 'node-cron'
import type Database from 'better-sqlite3'
import type { AgentOrchestrator } from '../agent/AgentOrchestrator'
import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'

interface ScheduledTask {
  id: string
  name: string
  schedule: string  // cron или 'every Xm/h'
  task: string      // что выполнить
  enabled: boolean
  lastRun?: number
  nextRun?: number
}

export class TaskScheduler {
  private jobs = new Map<string, cron.ScheduledTask>()

  constructor(
    private db: Database.Database,
    private agent: AgentOrchestrator
  ) {
    this.loadFromDB()
  }

  schedule(params: {
    name: string
    schedule: string
    task: string
    notify?: boolean
  }): string {
    const id = uuidv4()
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO scheduled_tasks (id, name, schedule, task, enabled, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(id, params.name, params.schedule, params.task, now)

    this.startJob(id, params.schedule, params.task, params.notify)
    return id
  }

  private startJob(id: string, schedule: string, task: string, notify = true): void {
    // Конвертировать простой формат в cron
    const cronExp = this.toCron(schedule)

    const job = cron.schedule(cronExp, async () => {
      // Выполнить задачу через агента
      const chatId = 'scheduler'
      await this.agent.startTask({ chatId, task })

      // Уведомить пользователя
      if (notify) {
        BrowserWindow.getAllWindows()[0]?.webContents.send('scheduler:task_done', {
          name: task.slice(0, 50),
        })
      }

      this.db.prepare('UPDATE scheduled_tasks SET last_run = ? WHERE id = ?')
        .run(Date.now(), id)
    })

    this.jobs.set(id, job)
  }

  // Конвертировать "every 30m", "daily at 9", "каждое утро в 9" → cron
  private toCron(schedule: string): string {
    if (cron.validate(schedule)) return schedule

    const patterns: Record<string, string> = {
      'every 1m': '* * * * *',
      'every 5m': '*/5 * * * *',
      'every 30m': '*/30 * * * *',
      'every 1h': '0 * * * *',
      'daily at 9': '0 9 * * *',
      'daily at 20': '0 20 * * *',
      'every morning': '0 8 * * *',
      'every evening': '0 19 * * *',
    }

    return patterns[schedule] ?? '0 9 * * *' // дефолт: каждый день в 9
  }

  getAll(): ScheduledTask[] {
    return this.db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as ScheduledTask[]
  }

  remove(id: string): void {
    this.jobs.get(id)?.stop()
    this.jobs.delete(id)
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  }

  private loadFromDB(): void {
    const tasks = this.db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all() as ScheduledTask[]
    tasks.forEach(t => this.startJob(t.id, t.schedule, t.task))
  }
}
```

### 6. ChainRunner.ts — цепочки задач

```typescript
// src/core/scheduler/ChainRunner.ts
import type { AgentOrchestrator } from '../agent/AgentOrchestrator'

interface ChainStep {
  task: string
  condition?: string  // выполнить только если предыдущий шаг содержит...
  delay?: number      // задержка перед шагом (мс)
}

export class ChainRunner {
  constructor(private agent: AgentOrchestrator) {}

  async run(chatId: string, steps: ChainStep[]): Promise<string[]> {
    const results: string[] = []

    for (const step of steps) {
      // Проверить условие
      if (step.condition && results.length > 0) {
        const lastResult = results[results.length - 1]
        if (!lastResult.toLowerCase().includes(step.condition.toLowerCase())) {
          results.push(`Пропущено: условие не выполнено (${step.condition})`)
          continue
        }
      }

      // Задержка если указана
      if (step.delay) {
        await new Promise(resolve => setTimeout(resolve, step.delay))
      }

      // Выполнить шаг с контекстом предыдущих результатов
      const context = results.length > 0
        ? `Предыдущие шаги: ${results.join('; ')}`
        : undefined

      const agentId = await this.agent.startTask({
        chatId, task: step.task, context
      })

      // Ждать завершения
      const result = await this.waitForAgent(agentId)
      results.push(result)
    }

    return results
  }

  private waitForAgent(agentId: string): Promise<string> {
    return new Promise((resolve) => {
      const { ipcMain } = require('electron')
      ipcMain.once(`agent:done:${agentId}`, (_, result: string) => resolve(result))
      setTimeout(() => resolve('Timeout'), 300000) // 5 минут максимум
    })
  }
}
```

### 7. SystemMonitor.ts

```typescript
// src/core/system/SystemMonitor.ts
import si from 'systeminformation'
import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'

export class SystemMonitor extends EventEmitter {
  private interval: NodeJS.Timeout | null = null

  start(updateMs = 2000): void {
    this.interval = setInterval(async () => {
      const stats = await this.getStats()
      BrowserWindow.getAllWindows()[0]?.webContents.send('system:stats', stats)

      // Предупреждения
      if (stats.cpu > 90) this.emit('alert', `Высокая нагрузка CPU: ${stats.cpu}%`)
      if (stats.ram > 90) this.emit('alert', `Высокое использование RAM: ${stats.ram}%`)
    }, updateMs)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }

  async getStats() {
    const [cpu, mem, disk] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
    ])
    return {
      cpu: Math.round(cpu.currentLoad),
      ram: Math.round((mem.used / mem.total) * 100),
      ramUsed: Math.round(mem.used / 1024 / 1024 / 1024 * 10) / 10, // GB
      ramTotal: Math.round(mem.total / 1024 / 1024 / 1024 * 10) / 10,
      disk: disk.map(d => ({
        mount: d.mount,
        used: Math.round(d.use),
        size: Math.round(d.size / 1024 / 1024 / 1024),
      }))
    }
  }
}
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/core/integrations/
  telegram/TelegramService.ts    ← новый
  discord/DiscordService.ts      ← новый
  github/GitHubService.ts        ← новый
  spotify/SpotifyService.ts      ← новый
  email/EmailService.ts          ← новый
  vscode/VSCodeService.ts        ← новый
src/core/scheduler/
  TaskScheduler.ts               ← новый
  ChainRunner.ts                 ← новый
src/core/system/
  SystemMonitor.ts               ← новый
src/renderer/pages/Settings/
  IntegrationsSection.tsx        ← новый
src/renderer/components/widgets/
  SystemMonitor/                 ← новый
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] Telegram: ввёл токен бота → входящие видны в UI
- [ ] Telegram: "отправь в телеграм: привет" → сообщение отправлено
- [ ] Discord: подключился → сообщения видны
- [ ] GitHub: "покажи мои репозитории" → список репо
- [ ] GitHub: "создай issue в repo: Баг с авторизацией" → issue создан
- [ ] Spotify: OAuth прошёл → "включи музыку" работает
- [ ] Spotify: "следующий трек" → переключает
- [ ] Email: подключил Gmail → "прочитай последние письма" работает
- [ ] Расписание: "каждое утро в 9 присылай погоду" → работает
- [ ] Цепочка: шаг 2 запускается после шага 1
- [ ] SystemMonitor: CPU/RAM в статусбаре
- [ ] При CPU > 90% приходит уведомление
