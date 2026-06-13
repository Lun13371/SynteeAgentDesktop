export interface SlashCommand {
  name: string
  label: string
  description: string
  icon: string
  placeholder?: string
  // Системный промпт который уходит в AI (скрыт от пользователя)
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
      `Пользователь хочет сгенерировать изображение. Описание: "${args}". Используй инструмент image_generation или опиши изображение детально и предложи способы его создать. Если инструмента нет — создай подробный промпт для Midjourney/DALL-E.`,
  },
  {
    name: 'web',
    label: '/web',
    description: 'Поиск в интернете',
    icon: 'globe',
    placeholder: 'поисковый запрос...',
    systemPrompt: (args) =>
      `Пользователь хочет найти информацию в интернете. Запрос: "${args}". Используй инструмент поиска web_search чтобы найти актуальную информацию и дай развёрнутый ответ.`,
  },
  {
    name: 'clear',
    label: '/clear',
    description: 'Очистить чат',
    icon: 'trash',
    systemPrompt: () => '',  // локальная команда — AI не нужен
  },
  {
    name: 'recap',
    label: '/recap',
    description: 'Краткое резюме чата',
    icon: 'fileText',
    placeholder: '',
    systemPrompt: () =>
      `Пользователь хочет получить краткое резюме текущего разговора. Составь чёткое и структурированное резюме в 3-5 пунктах: что обсуждалось, какие решения приняты, что осталось открытым.`,
  },
  {
    name: 'memo',
    label: '/memo',
    description: 'Сохранить заметку в память',
    icon: 'brain',
    placeholder: 'текст заметки...',
    systemPrompt: (args) =>
      `Пользователь хочет сохранить заметку: "${args}". Подтверди что запомнил эту информацию, кратко перефразируй её и скажи что она сохранена в памяти.`,
  },
  {
    name: 'sys',
    label: '/sys',
    description: 'Изменить системный промпт',
    icon: 'settings',
    placeholder: 'новый системный промпт...',
    systemPrompt: () => '',  // локальная команда
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
