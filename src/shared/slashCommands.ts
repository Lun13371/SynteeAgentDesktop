export interface SlashCommand {
  name: string           // без слеша: 'image'
  label: string          // отображаемое название
  description: string    // подсказка
  icon: string           // lucide icon name
  placeholder?: string   // placeholder после команды
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'image',
    label: '/image',
    description: 'Сгенерировать изображение',
    icon: 'image',
    placeholder: 'описание изображения...',
  },
  {
    name: 'web',
    label: '/web',
    description: 'Поиск в интернете',
    icon: 'globe',
    placeholder: 'поисковый запрос...',
  },
  {
    name: 'clear',
    label: '/clear',
    description: 'Очистить чат',
    icon: 'trash',
  },
  {
    name: 'recap',
    label: '/recap',
    description: 'Краткое резюме чата',
    icon: 'fileText',
  },
  {
    name: 'memo',
    label: '/memo',
    description: 'Сохранить заметку в память',
    icon: 'brain',
    placeholder: 'текст заметки...',
  },
  {
    name: 'sys',
    label: '/sys',
    description: 'Изменить системный промпт',
    icon: 'settings',
    placeholder: 'новый системный промпт...',
  },
]

/** Парсит строку вида "/image красивый закат" → { command, args } */
export function parseSlashCommand(text: string): { command: SlashCommand; args: string } | null {
  if (!text.startsWith('/')) return null
  const parts = text.slice(1).split(/\s+(.*)/)
  const name = parts[0].toLowerCase()
  const args = (parts[1] || '').trim()
  const command = SLASH_COMMANDS.find(c => c.name === name)
  if (!command) return null
  return { command, args }
}

/** Возвращает подходящие команды по частичному вводу "/im" → [/image] */
export function filterCommands(query: string): SlashCommand[] {
  if (!query.startsWith('/')) return []
  const q = query.slice(1).toLowerCase()
  return SLASH_COMMANDS.filter(c => c.name.startsWith(q))
}
