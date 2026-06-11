# СТАДИЯ 06 — АГЕНТСКАЯ СИСТЕМА

> Цель: Syntee становится агентом. Управляет файлами, браузером, терминалом,
> мышью и клавиатурой. Параллельные агенты, разрешения, dry run, откат.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- AgentOrchestrator — мозг, разбивает задачи на инструменты
- Tool calling loop — агент вызывает инструменты пока не получит результат
- Все инструменты: файлы, браузер, терминал, мышь/клава, поиск, мессенджеры
- Параллельные агенты — вкладки с логами в реальном времени
- Мультиагентность — оркестратор делит сложные задачи на подагентов
- Агент-наблюдатель — фоновый мониторинг экрана каждые 5 секунд
- Система разрешений — опасные действия требуют подтверждения
- Dry Run режим — показывает план, не выполняет
- Откат действий — история изменений, отмена последнего
- Красивый лог действий в UI

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
@nut-tree/nut-js — мышь и клавиатура
playwright — браузер (автоопределение Chrome/Firefox/Edge)
active-win — активное окно
ripgrep (rg) — быстрый поиск по файлам
discord.js — Discord
node-telegram-bot-api — Telegram
```

---

## ЗАДАЧИ

### 1. AgentOrchestrator.ts

```typescript
// src/core/agent/AgentOrchestrator.ts
import { AgentRunner } from './AgentRunner'
import { AgentPool } from './AgentPool'
import { AgentLogger } from './AgentLogger'
import { ToolRegistry } from './ToolRegistry'
import { PermissionGuard } from './PermissionGuard'
import type { AIClient } from '../ai/AIClient'
import type Store from 'electron-store'
import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'

export class AgentOrchestrator {
  private pool: AgentPool
  private toolRegistry: ToolRegistry
  private logger: AgentLogger
  private guard: PermissionGuard

  constructor(
    private ai: AIClient,
    private store: Store,
    tools: ToolRegistry
  ) {
    this.toolRegistry = tools
    this.logger = new AgentLogger()
    this.guard = new PermissionGuard(store)
    this.pool = new AgentPool(ai, tools, this.logger, this.guard)
  }

  // Запустить задачу — возвращает ID агента
  async startTask(params: {
    chatId: string
    task: string
    context?: string
    dryRun?: boolean
    parentAgentId?: string
  }): Promise<string> {
    const agentId = uuidv4()
    const model = this.store.get('mainModel') as string

    const runner = new AgentRunner({
      agentId,
      model,
      ai: this.ai,
      toolRegistry: this.toolRegistry,
      logger: this.logger,
      guard: this.guard,
      dryRun: params.dryRun ?? (this.store.get('agentPermissions.dryRunMode') as boolean),
      onAction: (action) => this.broadcastToUI(agentId, action),
    })

    this.pool.add(agentId, runner)
    
    // Запустить асинхронно
    runner.run(params.task, params.context).then((result) => {
      this.pool.remove(agentId)
      this.broadcastToUI(agentId, { type: 'done', result })
    }).catch((err) => {
      this.broadcastToUI(agentId, { type: 'error', error: err.message })
    })

    return agentId
  }

  // Остановить агента
  stopAgent(agentId: string) {
    this.pool.get(agentId)?.stop()
  }

  // Откатить последнее действие
  async undoLastAction(agentId: string) {
    const runner = this.pool.get(agentId)
    await runner?.undo()
  }

  private broadcastToUI(agentId: string, action: any) {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:action', { agentId, ...action })
    })
  }
}
```

### 2. AgentRunner.ts — tool calling loop

```typescript
// src/core/agent/AgentRunner.ts
import type { AIClient } from '../ai/AIClient'
import type { ToolRegistry } from './ToolRegistry'
import type { AgentLogger } from './AgentLogger'
import type { PermissionGuard } from './PermissionGuard'

interface AgentRunnerParams {
  agentId: string
  model: string
  ai: AIClient
  toolRegistry: ToolRegistry
  logger: AgentLogger
  guard: PermissionGuard
  dryRun: boolean
  onAction: (action: AgentAction) => void
}

export class AgentRunner {
  private stopped = false
  private actionHistory: AgentAction[] = []

  constructor(private params: AgentRunnerParams) {}

  async run(task: string, context?: string): Promise<string> {
    const { ai, model, toolRegistry, guard, dryRun, onAction, logger, agentId } = this.params
    
    const tools = toolRegistry.getOpenAITools()
    const messages: any[] = [
      {
        role: 'system',
        content: `Ты умный агент. Выполни задачу используя доступные инструменты.
${context ? `Контекст: ${context}` : ''}
${dryRun ? 'РЕЖИМ DRY RUN: описывай что ты сделал бы, но не выполняй действия.' : ''}
Комментируй каждое действие перед выполнением.
Отвечай на русском языке.`
      },
      { role: 'user', content: task }
    ]

    const maxIterations = 30
    let iteration = 0

    while (!this.stopped && iteration < maxIterations) {
      iteration++

      const response = await ai.complete({
        model,
        messages,
        // Передаём tools через параметры — openai SDK поддерживает
      } as any)

      // Если нет tool calls — задача выполнена
      if (!this.hasToolCalls(response)) {
        logger.log(agentId, 'done', response)
        return response
      }

      // Выполнить tool calls
      const toolCalls = this.extractToolCalls(response)
      
      for (const call of toolCalls) {
        if (this.stopped) break

        const tool = toolRegistry.get(call.name)
        if (!tool) continue

        // Проверка разрешений
        const needsConfirm = await guard.check(call.name, call.args)
        if (needsConfirm && !dryRun) {
          const allowed = await guard.requestPermission(call.name, call.args)
          if (!allowed) {
            messages.push({ role: 'tool', content: 'Действие отклонено пользователем.', tool_call_id: call.id })
            continue
          }
        }

        // Логировать действие
        const action: AgentAction = {
          type: 'tool_call',
          tool: call.name,
          args: call.args,
          timestamp: Date.now(),
        }
        this.actionHistory.push(action)
        onAction(action)
        logger.log(agentId, 'action', `${call.name}(${JSON.stringify(call.args)})`)

        // Выполнить
        let result = ''
        if (!dryRun) {
          try {
            result = await tool.execute(call.args)
            action.result = result
          } catch (err: any) {
            result = `Ошибка: ${err.message}`
            action.error = err.message
          }
        } else {
          result = `[DRY RUN] Действие ${call.name} было бы выполнено с аргументами: ${JSON.stringify(call.args)}`
        }

        onAction({ type: 'tool_result', tool: call.name, result })
        messages.push({ role: 'tool', content: result, tool_call_id: call.id })
      }
    }

    return 'Задача выполнена'
  }

  stop() { this.stopped = true }

  async undo() {
    const lastAction = this.actionHistory.pop()
    if (!lastAction?.undoFn) return
    await lastAction.undoFn()
  }

  private hasToolCalls(response: string): boolean {
    // Проверка наличия tool calls в ответе (зависит от формата)
    return false // упрощено
  }

  private extractToolCalls(response: string): ToolCall[] {
    return [] // упрощено
  }
}
```

### 3. ToolRegistry.ts + все инструменты

```typescript
// src/core/agent/ToolRegistry.ts

export interface Tool {
  name: string
  description: string
  parameters: object  // JSON Schema
  dangerous: boolean  // нужно ли подтверждение
  execute: (args: any) => Promise<string>
  undo?: (args: any) => Promise<void>
}

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool) { this.tools.set(tool.name, tool) }
  get(name: string) { return this.tools.get(name) }
  
  getOpenAITools() {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }
    }))
  }
}

// src/core/agent/tools/FileTools.ts
export const fileTools: Tool[] = [
  {
    name: 'read_file',
    description: 'Прочитать файл',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    execute: async ({ path }) => {
      const fs = require('fs')
      return fs.readFileSync(path, 'utf-8')
    }
  },
  {
    name: 'write_file',
    description: 'Записать файл',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    },
    execute: async ({ path, content }) => {
      const fs = require('fs')
      // Сохранить бэкап для отката
      if (fs.existsSync(path)) {
        const backup = fs.readFileSync(path, 'utf-8')
        // хранить в истории
      }
      fs.writeFileSync(path, content, 'utf-8')
      return `Файл записан: ${path}`
    }
  },
  {
    name: 'search_files',
    description: 'Поиск по содержимому файлов (ripgrep)',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        directory: { type: 'string' },
        fileType: { type: 'string' }
      },
      required: ['query']
    },
    execute: async ({ query, directory = '.', fileType }) => {
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)
      const typeFlag = fileType ? `-t ${fileType}` : ''
      const { stdout } = await execAsync(`rg "${query}" ${directory} ${typeFlag} --max-count=20`)
      return stdout || 'Ничего не найдено'
    }
  }
]

// src/core/agent/tools/InputTools.ts
export const inputTools: Tool[] = [
  {
    name: 'mouse_move',
    description: 'Переместить мышь в координаты',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y']
    },
    execute: async ({ x, y }) => {
      const { mouse, Point } = require('@nut-tree/nut-js')
      await mouse.setPosition(new Point(x, y))
      return `Мышь перемещена в (${x}, ${y})`
    }
  },
  {
    name: 'mouse_click',
    description: 'Кликнуть мышью',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] }
      },
      required: ['x', 'y']
    },
    execute: async ({ x, y, button = 'left' }) => {
      const { mouse, Point, Button } = require('@nut-tree/nut-js')
      await mouse.setPosition(new Point(x, y))
      await mouse.click(Button.LEFT)
      return `Клик в (${x}, ${y})`
    }
  },
  {
    name: 'keyboard_type',
    description: 'Напечатать текст',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    execute: async ({ text }) => {
      const { keyboard } = require('@nut-tree/nut-js')
      await keyboard.type(text)
      return `Напечатано: "${text}"`
    }
  }
]

// src/core/agent/tools/BrowserTools.ts
export const browserTools: Tool[] = [
  {
    name: 'browser_navigate',
    description: 'Открыть URL в браузере',
    dangerous: false,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url']
    },
    execute: async ({ url }) => {
      const { chromium, firefox, webkit } = require('playwright')
      // Автоопределение браузера
      const browser = await chromium.launch({ headless: false, channel: 'chrome' })
      const page = await browser.newPage()
      await page.goto(url)
      const title = await page.title()
      return `Открыта страница: ${title}`
    }
  }
]

// src/core/agent/tools/TerminalTools.ts  
export const terminalTools: Tool[] = [
  {
    name: 'run_command',
    description: 'Выполнить команду в терминале',
    dangerous: true,  // требует подтверждения
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' }
      },
      required: ['command']
    },
    execute: async ({ command, cwd }) => {
      const { exec } = require('child_process')
      const { promisify } = require('util')
      const execAsync = promisify(exec)
      const { stdout, stderr } = await execAsync(command, { cwd, timeout: 30000 })
      return stdout || stderr || 'Команда выполнена'
    }
  }
]
```

### 4. PermissionGuard.ts

```typescript
// src/core/agent/PermissionGuard.ts
import { BrowserWindow } from 'electron'
import type Store from 'electron-store'

// Список опасных инструментов
const DANGEROUS_TOOLS = new Set([
  'write_file', 'delete_file', 'run_command', 'run_code',
  'mouse_click', 'keyboard_type', 'browser_navigate'
])

// Критически опасные — всегда спрашивать
const CRITICAL_TOOLS = new Set([
  'delete_file', 'format_disk', 'run_command'
])

export class PermissionGuard {
  constructor(private store: Store) {}

  async check(toolName: string, args: any): Promise<boolean> {
    const confirmDangerous = this.store.get('agentPermissions.confirmDangerous') as boolean
    
    if (CRITICAL_TOOLS.has(toolName)) return true
    if (confirmDangerous && DANGEROUS_TOOLS.has(toolName)) return true
    
    // Проверить запрещённые пути
    if (toolName === 'write_file' || toolName === 'delete_file') {
      const forbiddenPaths = this.store.get('agentPermissions.forbiddenPaths') as string[]
      const filePath = args.path ?? ''
      if (forbiddenPaths.some(fp => filePath.startsWith(fp))) return true
    }
    
    return false
  }

  async requestPermission(toolName: string, args: any): Promise<boolean> {
    return new Promise((resolve) => {
      // Показать модалку в renderer
      const win = BrowserWindow.getAllWindows()[0]
      const permissionId = Date.now().toString()
      
      win?.webContents.send('agent:permission:request', {
        permissionId,
        tool: toolName,
        args,
        description: this.getDescription(toolName, args),
      })
      
      // Ждать ответа от renderer
      const { ipcMain } = require('electron')
      ipcMain.once(`agent:permission:response:${permissionId}`, (_, allowed: boolean) => {
        resolve(allowed)
      })
    })
  }

  private getDescription(tool: string, args: any): string {
    const descriptions: Record<string, (args: any) => string> = {
      'write_file': (a) => `Записать файл: ${a.path}`,
      'delete_file': (a) => `Удалить файл: ${a.path}`,
      'run_command': (a) => `Выполнить команду: ${a.command}`,
      'keyboard_type': (a) => `Напечатать: "${a.text}"`,
      'mouse_click': (a) => `Кликнуть в (${a.x}, ${a.y})`,
    }
    return descriptions[tool]?.(args) ?? `Выполнить: ${tool}`
  }
}
```

### 5. UI — AgentTabs (вкладки агентов)

```tsx
// src/renderer/components/agent/AgentTabs/AgentTabs.tsx
// Вкладки для параллельных агентов с логами в реальном времени

import { motion, AnimatePresence } from 'framer-motion'

interface AgentTab {
  id: string
  task: string
  status: 'running' | 'done' | 'error'
  logs: AgentLog[]
}

interface AgentLog {
  timestamp: number
  type: 'action' | 'result' | 'thinking' | 'error' | 'done'
  message: string
}

export function AgentTabs({ agents }: { agents: AgentTab[] }) {
  const [activeTab, setActiveTab] = useState(agents[0]?.id)

  return (
    <div className="agent-tabs">
      {/* Табы */}
      <div className="agent-tabs-header">
        {agents.map(agent => (
          <motion.button
            key={agent.id}
            whileTap={{ scale: 0.95 }}
            onClick={() => setActiveTab(agent.id)}
            className={cn('agent-tab', { active: activeTab === agent.id })}
          >
            <StatusDot status={agent.status} />
            <span>{agent.task.slice(0, 20)}...</span>
          </motion.button>
        ))}
      </div>

      {/* Логи активного агента */}
      {agents.map(agent => (
        agent.id === activeTab && (
          <div key={agent.id} className="agent-log-panel">
            {agent.logs.map((log, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                className={cn('agent-log-entry', log.type)}
              >
                <span className="log-time">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="log-icon">
                  {log.type === 'action' ? '⚡' :
                   log.type === 'result' ? '✓' :
                   log.type === 'thinking' ? '💭' :
                   log.type === 'error' ? '✗' : '🏁'}
                </span>
                <span className="log-message">{log.message}</span>
              </motion.div>
            ))}
            
            {agent.status === 'running' && (
              <div className="agent-stop-btn">
                <button onClick={() => window.syntee.agent.stop(agent.id)}>
                  ⏹ Остановить
                </button>
              </div>
            )}
          </div>
        )
      ))}
    </div>
  )
}
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/core/agent/
  AgentOrchestrator.ts    ← новый
  AgentRunner.ts          ← новый
  AgentPool.ts            ← новый
  AgentLogger.ts          ← новый
  ToolRegistry.ts         ← новый
  PermissionGuard.ts      ← новый
  tools/
    FileTools.ts          ← новый
    BrowserTools.ts       ← новый
    InputTools.ts         ← новый
    TerminalTools.ts      ← новый
    SearchTools.ts        ← новый
    ScreenTools.ts        ← новый
    MessengerTools.ts     ← новый (заглушки)
src/renderer/components/agent/
  AgentTabs/              ← новый
  AgentLogPanel/          ← новый
  PermissionModal/        ← новый
  DryRunPreview/          ← новый
src/main/ipc/
  agent.ipc.ts            ← новый
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] "Создай файл test.txt с текстом Hello" — агент создаёт файл
- [ ] Опасное действие → появляется окно подтверждения
- [ ] "Стоп" в голосовом режиме останавливает агента
- [ ] Dry Run режим показывает план без выполнения
- [ ] 2 задачи одновременно — 2 вкладки с логами
- [ ] Лог обновляется в реальном времени
- [ ] "Открой google.com в браузере" — Playwright открывает браузер
- [ ] "Напечатай Hello" — keyboard_type печатает
- [ ] Откат последнего действия работает
- [ ] Агент-наблюдатель запускается и мониторит экран
