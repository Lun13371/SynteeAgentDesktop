/**
 * Slash-команды.
 *
 * Две категории:
 *   1. **Builtin** — захардкожены в SLASH_COMMANDS ниже. Не имеют .md-файла,
 *      управляются кодом (clear/sys/compact/rewind/fork/help/snapshot/restore).
 *   2. **Custom** — загружаются из .md-файлов (commandLoader.ts):
 *        - resources/commands/      (builtin-пакетные, поставляются с приложением)
 *        - {userData}/commands/      (глобальные пользовательские)
 *        - {workdir}/.syntee/commands/ (проектные, коммитятся в репозиторий)
 *      Формат: YAML frontmatter + тело = шаблон systemPrompt (с $ARGS).
 *
 * Источник: 'builtin' | 'user' | 'project'. Builtin-пакетные команды из
 * resources/commands/ тоже помечаются source='builtin' (они вшиты в дистрибутив).
 */

export type SlashCommandSource = 'builtin' | 'user' | 'project'

export type SlashCommandMode = 'ask' | 'plan' | 'code'

/**
 * Описание одного аргумента slash-команды для пикера опций (enum).
 * Если у команды задано `arguments` с непустым `choices`, после выбора
 * команды открывается многоуровневый пикер: первый аргумент → второй → …
 * Аргумент без choices — свободный текст (подсказка через description).
 */
export interface CommandArgument {
  name: string
  description?: string
  /** Predefined опции для enum-пикера. Пустой/undefined — свободный текст. */
  choices?: string[]
  required?: boolean
  default?: string
}

export interface SlashCommand {
  name: string
  label: string
  description: string
  icon: string
  placeholder?: string
  /** Подсказка для аргумента (например "путь к файлу"). Показывается в меню. */
  argumentHint?: string
  /**
   * Структурированные аргументы команды для многоуровневого пикера опций.
   * Опционально — старые команды без этого поля работают как раньше
   * (свободный текст после `/name`). Для custom .md-команд парсится из
   * YAML-блока `arguments:` в frontmatter.
   */
  arguments?: CommandArgument[]
  systemPrompt: (args: string) => string
  /** Источник: builtin (в коде или вшитый .md), user (userData), project (.syntee/commands). */
  source?: SlashCommandSource
  /** Путь к .md-файлу для custom-команд. undefined для builtin в SLASH_COMMANDS. */
  filePath?: string
  /** Ограничение тулов на этот прогон (только для custom-команд с allowed-tools).
   *  Builtin-команды игнорируют это поле — их режим задаётся кодом. */
  allowedTools?: string[]
  /** Режим работы (для custom-команд). Builtin-команды управляют режимом сами. */
  mode?: SlashCommandMode
  /** id скилла для one-shot активации (для команд типа /review → skill:code-review).
   *  Скилл инъектируется в system prompt только на этот прогон, без записи в skillsState. */
  skill?: string
  /** Маркер что это команда из .md-файла (а не из захардкоженного SLASH_COMMANDS). */
  custom?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'image',
    label: '/image',
    description: 'Сгенерировать изображение',
    icon: 'image',
    placeholder: 'описание изображения...',
    source: 'builtin',
    arguments: [
      {
        name: 'style',
        description: 'Стиль изображения',
        choices: ['realistic', 'art', 'anime', 'pixel', '3d'],
        default: 'realistic',
      },
    ],
    systemPrompt: (args) =>
      `Пользователь хочет сгенерировать изображение. Описание: "${args}". Используй инструмент generate_image. Если инструмент недоступен, создай подробный промпт для Midjourney/DALL-E.`,
  },
  {
    name: 'web',
    label: '/web',
    description: 'Поиск в интернете',
    icon: 'globe',
    placeholder: 'поисковый запрос...',
    source: 'builtin',
    systemPrompt: (args) =>
      `Пользователь хочет найти информацию в интернете. Запрос: "${args}". Используй инструмент search_web, чтобы найти актуальную информацию и дать ответ по результатам поиска.`,
  },
  {
    name: 'clear',
    label: '/clear',
    description: 'Очистить чат',
    icon: 'trash',
    source: 'builtin',
    systemPrompt: () => '',
  },
  {
    name: 'compact',
    label: '/compact',
    description: 'Сжать контекст чата',
    icon: 'layers',
    source: 'builtin',
    systemPrompt: () => '',
  },
  {
    name: 'recap',
    label: '/recap',
    description: 'Краткое резюме чата',
    icon: 'fileText',
    placeholder: '',
    source: 'builtin',
    systemPrompt: () =>
      'Пользователь хочет получить краткое резюме текущего разговора. Составь четкое резюме в 3-5 пунктах: что обсуждалось, какие решения приняты, что осталось открытым.',
  },
  {
    name: 'memo',
    label: '/memo',
    description: 'Сохранить заметку в память',
    icon: 'brain',
    placeholder: 'текст заметки...',
    source: 'builtin',
    systemPrompt: (args) =>
      `Пользователь хочет сохранить заметку: "${args}". Кратко подтверди, что информация сохранена в памяти.`,
  },
  {
    name: 'sys',
    label: '/sys',
    description: 'Изменить системный промпт',
    icon: 'settings',
    placeholder: 'новый системный промпт...',
    source: 'builtin',
    systemPrompt: () => '',
  },
  {
    name: 'agent',
    label: '/agent',
    description: 'Режим мульти-агента',
    icon: 'cpu',
    placeholder: 'задача для распределения...',
    source: 'builtin',
    arguments: [
      {
        name: 'strategy',
        description: 'Стратегия оркестрации суб-агентов',
        choices: ['spawn', 'parallel', 'sequential'],
        default: 'spawn',
      },
    ],
    systemPrompt: (args) =>
      `Пользователь хочет решить задачу с помощью суб-агентов: "${args}".

Ты работаешь как оркестратор.
1. Разбей задачу на 2-5 независимых подзадач.
2. Запусти суб-агентов через spawn_agent.
3. Дождись результатов и синтезируй общий ответ.

Не запускай суб-агентов без необходимости и не дублируй работу между ними.`,
  },
  {
    name: 'ask',
    label: '/ask',
    description: 'Спросить без правок (read-only)',
    icon: 'messageSquare',
    placeholder: 'вопрос...',
    source: 'builtin',
    // systemPrompt здесь pass-through — фрейминг задаётся buildAskInjection
    // в ai-worker.ts (как и в planning-режиме). Команда лишь сигнализирует
    // chat.ipc.ts, что это сообщение нужно выполнить в read-only режиме.
    systemPrompt: (args) => args,
  },

  // ─── Новые команды (реализованы в этом проходе) ────────────────────────

  {
    name: 'fork',
    label: '/fork',
    description: 'Дублировать чат с этого места',
    icon: 'gitFork',
    argumentHint: 'имя нового чата (опционально)',
    placeholder: 'имя форка...',
    source: 'builtin',
    // fork обрабатывается в ChatPage.tsx до отправки в агент — вызывает
    // IPC chat:fork, переключается на новый чат. systemPrompt не используется.
    systemPrompt: () => '',
  },
  {
    name: 'help',
    label: '/help',
    description: 'Список команд и горячих клавиш',
    icon: 'helpCircle',
    source: 'builtin',
    // help открывает модалку в renderer — не доходит до агента.
    systemPrompt: () => '',
  },
  {
    name: 'snapshot',
    label: '/snapshot',
    description: 'Сохранить именованный снапшот',
    icon: 'camera',
    argumentHint: 'имя снапшота',
    placeholder: 'имя снапшота...',
    source: 'builtin',
    // snapshot обрабатывается в ChatPage.tsx — вызывает IPC chat:snapshot:create.
    systemPrompt: () => '',
  },
  {
    name: 'restore',
    label: '/restore',
    description: 'Восстановить снапшот',
    icon: 'undo',
    argumentHint: 'имя или id снапшота (опционально)',
    placeholder: 'имя снапшота...',
    source: 'builtin',
    // restore обрабатывается в ChatPage.tsx — открывает пикер снапшотов.
    systemPrompt: () => '',
  },
]

/**
 * Парсит текст на { command, args }. Ищет среди builtin (SLASH_COMMANDS).
 * Для поиска по кастомным командам используйте parseSlashCommandWithCustom.
 */
export function parseSlashCommand(text: string): { command: SlashCommand; args: string } | null {
  if (!text.startsWith('/')) return null
  const spaceIdx = text.indexOf(' ')
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim()
  const command = SLASH_COMMANDS.find(c => c.name === name)
  if (!command) return null
  return { command, args }
}

/**
 * Парсит текст с учётом builtin + custom команд. Приоритет: builtin,
 * затем custom (по приоритету источников — project > user > builtin-pkg).
 */
export function parseSlashCommandWithCustom(
  text: string,
  customCommands: SlashCommand[],
): { command: SlashCommand; args: string } | null {
  if (!text.startsWith('/')) return null
  const spaceIdx = text.indexOf(' ')
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim()
  // Сначала builtin — они имеют приоритет (нельзя перекрыть /clear и т.д.).
  const builtin = SLASH_COMMANDS.find(c => c.name === name)
  if (builtin) return { command: builtin, args }
  const custom = customCommands.find(c => c.name === name)
  if (custom) return { command: custom, args }
  return null
}

/**
 * Фильтрует команды по префиксу для автокомплита. Принимает optional custom
 * список — если передан, фильтрует по объединённому списку (builtin + custom).
 */
export function filterCommands(query: string, customCommands: SlashCommand[] = []): SlashCommand[] {
  if (!query.startsWith('/')) return []
  const q = query.slice(1).toLowerCase()
  if (q.includes(' ')) return []
  const all = [...SLASH_COMMANDS, ...customCommands]
  // Dedup по name — builtin имеет приоритет (он первый в массиве).
  const seen = new Set<string>()
  const result: SlashCommand[] = []
  for (const cmd of all) {
    if (seen.has(cmd.name)) continue
    if (cmd.name.startsWith(q)) {
      seen.add(cmd.name)
      result.push(cmd)
    }
  }
  return result
}
