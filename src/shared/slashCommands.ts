export interface SlashCommand {
  name: string
  label: string
  description: string
  icon: string
  placeholder?: string
  systemPrompt: (args: string) => string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'image',
    label: '/image',
    description: 'Сгенерировать изображение',
    icon: 'image',
    placeholder: 'описание изображения...',
    systemPrompt: (args) =>
      `Пользователь хочет сгенерировать изображение. Описание: "${args}". Используй инструмент generate_image. Если инструмент недоступен, создай подробный промпт для Midjourney/DALL-E.`,
  },
  {
    name: 'web',
    label: '/web',
    description: 'Поиск в интернете',
    icon: 'globe',
    placeholder: 'поисковый запрос...',
    systemPrompt: (args) =>
      `Пользователь хочет найти информацию в интернете. Запрос: "${args}". Используй инструмент search_web, чтобы найти актуальную информацию и дать ответ по результатам поиска.`,
  },
  {
    name: 'clear',
    label: '/clear',
    description: 'Очистить чат',
    icon: 'trash',
    systemPrompt: () => '',
  },
  {
    name: 'compact',
    label: '/compact',
    description: 'Сжать контекст чата',
    icon: 'layers',
    systemPrompt: () => '',
  },
  {
    name: 'recap',
    label: '/recap',
    description: 'Краткое резюме чата',
    icon: 'fileText',
    placeholder: '',
    systemPrompt: () =>
      'Пользователь хочет получить краткое резюме текущего разговора. Составь четкое резюме в 3-5 пунктах: что обсуждалось, какие решения приняты, что осталось открытым.',
  },
  {
    name: 'memo',
    label: '/memo',
    description: 'Сохранить заметку в память',
    icon: 'brain',
    placeholder: 'текст заметки...',
    systemPrompt: (args) =>
      `Пользователь хочет сохранить заметку: "${args}". Кратко подтверди, что информация сохранена в памяти.`,
  },
  {
    name: 'sys',
    label: '/sys',
    description: 'Изменить системный промпт',
    icon: 'settings',
    placeholder: 'новый системный промпт...',
    systemPrompt: () => '',
  },
  {
    name: 'agent',
    label: '/agent',
    description: 'Режим мульти-агента',
    icon: 'cpu',
    placeholder: 'задача для распределения...',
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
    // systemPrompt здесь pass-through — фрейминг задаётся buildAskInjection
    // в ai-worker.ts (как и в planning-режиме). Команда лишь сигнализирует
    // chat.ipc.ts, что это сообщение нужно выполнить в read-only режиме.
    systemPrompt: (args) => args,
  },
]

export function parseSlashCommand(text: string): { command: SlashCommand; args: string } | null {
  if (!text.startsWith('/')) return null
  const spaceIdx = text.indexOf(' ')
  const name = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase()
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim()
  const command = SLASH_COMMANDS.find(c => c.name === name)
  if (!command) return null
  return { command, args }
}

export function filterCommands(query: string): SlashCommand[] {
  if (!query.startsWith('/')) return []
  const q = query.slice(1).toLowerCase()
  if (q.includes(' ')) return []
  return SLASH_COMMANDS.filter(c => c.name.startsWith(q))
}
