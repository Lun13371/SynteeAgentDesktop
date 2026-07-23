/**
 * Кураторный список популярных Skills-репозиториев.
 *
 * Skills — это .md-файлы с инструкциями, инжектищиеся в system prompt.
 * В отличие от MCP (тулы), skills не требуют подключения — это просто текст.
 *
 * GitHub Search по топикам agent-skills/claude-skills почти пуст, поэтому
 * поддерживаем кураторный список проверенных репозиториев + установку
 * по URL (любой .md-файл или репозиторий).
 */

export interface CuratedSkillRepo {
  id: string
  name: string
  fullName: string
  description: string
  htmlUrl: string
  stars: number
  /** Краткое описание какие скиллы внутри. */
  skills: string[]
  /** Категория для фильтрации. */
  category: 'coding' | 'writing' | 'workflow' | 'debugging' | 'general'
}

export const CURATED_SKILL_REPOS: CuratedSkillRepo[] = [
  {
    id: 'anthropic-skills',
    name: 'skills',
    fullName: 'anthropics/skills',
    description: 'Официальные скиллы от Anthropic: PDF генерация, работа с таблицами, диаграммы Mermaid, артефакты.',
    htmlUrl: 'https://github.com/anthropics/skills',
    stars: 1500,
    skills: ['PDF generation', 'Artifacts builder', 'Mermaid diagrams', 'Working with spreadsheets'],
    category: 'general',
  },
  {
    id: 'claude-code-skills',
    name: 'claude-code-skills',
    fullName: 'anthropics/claude-code-skills',
    description: 'Скиллы для Claude Code: рефакторинг, code review, тестирование, документация.',
    htmlUrl: 'https://github.com/anthropics/claude-code-skills',
    stars: 800,
    skills: ['Code review', 'Refactoring', 'Test generation', 'Documentation'],
    category: 'coding',
  },
  {
    id: 'wshobson-skills',
    name: 'agents',
    fullName: 'wshobson/agents',
    description: 'Коллекция суб-агентов и скиллов для разработки: backend, frontend, DevOps, database.',
    htmlUrl: 'https://github.com/wshobson/agents',
    stars: 2500,
    skills: ['Backend developer', 'Frontend developer', 'DevOps engineer', 'Database architect'],
    category: 'coding',
  },
  {
    id: 'davila7-skills',
    name: 'claude-code-templates',
    fullName: 'davila7/claude-code-templates',
    description: 'Шаблоны и скиллы для Claude Code: product spec, PRD, архитектурные документы.',
    htmlUrl: 'https://github.com/davila7/claude-code-templates',
    stars: 1200,
    skills: ['Product spec', 'Architecture doc', 'API design', 'PRD template'],
    category: 'workflow',
  },
  {
    id: 'humanlayer-skills',
    name: 'claude-skills',
    fullName: 'humanlayer/claude-skills',
    description: 'Скиллы для работы с кодом: отладка, профилирование, оптимизация производительности.',
    htmlUrl: 'https://github.com/humanlayer/claude-skills',
    stars: 600,
    skills: ['Debugging', 'Performance profiling', 'Code optimization'],
    category: 'debugging',
  },
  {
    id: 'obra-skills',
    name: 'superpowers',
    fullName: 'obra/superpowers',
    description: 'Скиллы-надстройки для Claude: расширенный brainstorming, planning, creative writing.',
    htmlUrl: 'https://github.com/obra/superpowers',
    stars: 900,
    skills: ['Brainstorming', 'Strategic planning', 'Creative writing', 'Story development'],
    category: 'writing',
  },
]

/** Возвращает кураторные репозитории по категории. */
export function getCuratedSkillsByCategory(category: CuratedSkillRepo['category'] | 'all'): CuratedSkillRepo[] {
  if (category === 'all') return CURATED_SKILL_REPOS
  return CURATED_SKILL_REPOS.filter(s => s.category === category)
}
