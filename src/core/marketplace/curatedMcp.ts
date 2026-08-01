/**
 * Кураторный список популярных MCP-серверов.
 *
 * Встроен в приложение — не зависит от медленного официального реестра
 * (registry.modelcontextprotocol.io отвечает 5-25с). Каждый сервер можно
 * установить в один клик через прямую установку (mcp:installDirect) —
 * приложение само пишет mcp.json и запускает подключение.
 *
 * Аудит 2026-08: все npm-пакеты проверены через registry.npmjs.org.
 * Удалены 404-пакеты, заменены deprecated на community-альтернативы где возможно.
 * Deprecated-but-working пакеты оставлены (они работают через npx).
 */

export type CuratedMcpCategory = 'search' | 'files' | 'code' | 'docs' | 'browser' | 'data' | 'utils' | 'productivity' | 'ai' | 'comms' | 'devops'

export interface CuratedMcpEnvVar {
  name: string
  description: string
  isRequired: boolean
  isSecret: boolean
}

export interface CuratedMcpPositionalArg {
  /** Название параметра для GUI (например "Разрешённые директории"). */
  label: string
  /** Описание-плейсхолдер для GUI. */
  placeholder: string
  /** Дефолтное значение (может быть пустым — пользователь должен заполнить). */
  defaultValue?: string
  /** Если true — установка блокируется пока не заполнено. */
  isRequired?: boolean
}

export interface CuratedMcpServer {
  id: string
  name: string
  description: string
  category: CuratedMcpCategory
  /** stdio-команда для Windows (cmd /c npx ...). null = не поддерживает stdio. */
  winCommand: string | null
  winArgs: string[] | null
  /** stdio-команда для Linux/Mac. null = не поддерживает stdio. */
  unixCommand: string | null
  unixArgs: string[] | null
  envVars: CuratedMcpEnvVar[]
  /**
   * Позиционные аргументы после имени пакета (например пути для filesystem).
   * Каждое значение добавляется в конец args при установке. Пользователь
   * заполняет их через GUI в ScopeDialog.
   */
  positionalArgs?: CuratedMcpPositionalArg[]
  homepage: string
  /** Короткий текст для бейджа "популярный" / "рекомендуемый". */
  featured?: boolean
}

export const CURATED_MCP_SERVERS: CuratedMcpServer[] = [
  // ── Документация ──
  {
    id: 'context7',
    name: 'context7',
    description: 'Документация для библиотек и фреймворков в реальном времени. Поиск по актуальным докам прямо в чате.',
    category: 'docs',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@upstash/context7-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@upstash/context7-mcp'],
    envVars: [
      { name: 'CONTEXT7_API_KEY', description: 'API ключ Context7 (бесплатно на context7.com)', isRequired: false, isSecret: true },
    ],
    homepage: 'https://context7.com',
    featured: true,
  },

  // ── Файлы ──
  {
    id: 'filesystem',
    name: 'filesystem',
    description: 'Доступ к файловой системе: чтение, запись, поиск, перемещение файлов. Укажите разрешённые директории.',
    category: 'files',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    envVars: [],
    positionalArgs: [
      { label: 'Разрешённые директории', placeholder: 'C:\\Users\\user\\Documents', isRequired: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    featured: true,
  },

  // ── Утилиты ──
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    description: 'Пошаговое мышление для сложных задач. AI разбивает проблему на шаги и рассуждает последовательно.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-sequential-thinking'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    featured: true,
  },
  {
    id: 'memory',
    name: 'memory',
    description: 'Граф знаний для долгосрочной памяти AI. Сохраняет сущности и отношения между ними.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-memory'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-memory'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'everything',
    name: 'everything',
    description: 'Демо-сервер для тестирования всех возможностей MCP-протокола. Полезен для отладки подключений.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-everything'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-everything'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
  },

  // ── Браузер ──
  {
    id: 'playwright',
    name: 'playwright',
    description: 'Microsoft Playwright MCP: автоматизация браузера, скриншоты, клики, навигация. Актуальная замена Puppeteer.',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@playwright/mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@playwright/mcp'],
    envVars: [],
    homepage: 'https://github.com/microsoft/playwright-mcp',
    featured: true,
  },
  {
    id: 'playwright-exec',
    name: 'playwright-exec',
    description: 'Playwright MCP от ExecuteAutomation: автоматизация браузера, запись действий, генерация тестов.',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@executeautomation/playwright-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@executeautomation/playwright-mcp-server'],
    envVars: [],
    homepage: 'https://executeautomation.github.io/mcp-playwright/',
  },
  {
    id: 'puppeteer',
    name: 'puppeteer',
    description: 'Автоматизация браузера через Puppeteer. Скриншоты, клики, навигация. (Deprecated, но работает.)',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-puppeteer'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },

  // ── Поиск ──
  {
    id: 'brave-search',
    name: 'brave-search',
    description: 'Brave Search API: веб-поиск, поиск изображений, новостей, точек интереса. Community-версия.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'brave-search-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'brave-search-mcp'],
    envVars: [
      { name: 'BRAVE_API_KEY', description: 'Brave Search API ключ (brave.com/search/api)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/mikechao/brave-search-mcp',
  },
  {
    id: 'tavily',
    name: 'tavily',
    description: 'Tavily AI Search: продвинутый веб-поиск с извлечением контента, оптимизированный для AI.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'tavily-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'tavily-mcp'],
    envVars: [
      { name: 'TAVILY_API_KEY', description: 'Tavily API ключ (tavily.com)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/tavily-ai/tavily-mcp',
    featured: true,
  },
  {
    id: 'exa',
    name: 'exa',
    description: 'Exa (бывший Metaphor): веб-поиск и краулинг для AI. Поиск по содержимому страниц.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'exa-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'exa-mcp-server'],
    envVars: [
      { name: 'EXA_API_KEY', description: 'Exa API ключ (exa.ai)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    id: 'firecrawl',
    name: 'firecrawl',
    description: 'Firecrawl: поиск, скрапинг и взаимодействие с веб-страницами. Поддержка cloud и self-hosted.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'firecrawl-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'firecrawl-mcp'],
    envVars: [
      { name: 'FIRECRAWL_API_KEY', description: 'Firecrawl API ключ (firecrawl.dev)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/firecrawl/firecrawl-mcp-server',
  },
  {
    id: 'serper',
    name: 'serper',
    description: 'Serper.dev: Google Search API для AI. Быстрый веб-поиск и скрапинг страниц.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-server-serper'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-server-serper'],
    envVars: [
      { name: 'SERPER_API_KEY', description: 'Serper API ключ (serper.dev)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/pashvc/mcp-server-serper',
  },
  // ── Код / Git ──
  {
    id: 'git',
    name: 'git',
    description: 'Git MCP: полный контроль версий — clone, commit, push, pull, merge, rebase, worktree.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@cyanheads/git-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@cyanheads/git-mcp-server'],
    envVars: [],
    homepage: 'https://github.com/cyanheads/git-mcp-server',
    featured: true,
  },
  {
    id: 'github',
    name: 'github',
    description: 'GitHub API: репозитории, issues, PR, коммиты. (Deprecated, но работает.)',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-github'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-github'],
    envVars: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub Personal Access Token (github.com/settings/tokens)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
  },
  {
    id: 'gitlab',
    name: 'gitlab',
    description: 'GitLab API: проекты, MR, pipeline. (Deprecated, но работает.)',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-gitlab'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-gitlab'],
    envVars: [
      { name: 'GITLAB_PERSONAL_ACCESS_TOKEN', description: 'GitLab Personal Access Token', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
  },

  // ── Данные ──
  {
    id: 'postgres',
    name: 'postgres',
    description: 'PostgreSQL: чтение и анализ баз данных. (Deprecated, но работает.)',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-postgres'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-postgres'],
    envVars: [],
    positionalArgs: [
      { label: 'Строка подключения', placeholder: 'postgresql://user:pass@localhost:5432/dbname', isRequired: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'mysql',
    name: 'mysql',
    description: 'MySQL: чтение и запись, SQL-запросы. Community-версия с поддержкой write-операций.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@benborla29/mcp-server-mysql'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@benborla29/mcp-server-mysql'],
    envVars: [
      { name: 'MYSQL_HOST', description: 'MySQL хост (по умолчанию 127.0.0.1)', isRequired: false, isSecret: false },
      { name: 'MYSQL_PORT', description: 'MySQL порт (по умолчанию 3306)', isRequired: false, isSecret: false },
      { name: 'MYSQL_USER', description: 'MySQL пользователь', isRequired: true, isSecret: false },
      { name: 'MYSQL_PASSWORD', description: 'MySQL пароль', isRequired: true, isSecret: true },
      { name: 'MYSQL_DATABASE', description: 'Имя базы данных', isRequired: false, isSecret: false },
    ],
    homepage: 'https://github.com/benborla/mcp-server-mysql',
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    description: 'SQLite: чтение и запись баз данных SQLite. Community-версия.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-server-sqlite'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-server-sqlite'],
    envVars: [],
    positionalArgs: [
      { label: 'Путь к БД', placeholder: 'C:\\path\\to\\database.db', isRequired: true },
    ],
    homepage: 'https://github.com/madnh/mcp-server-sqlite',
  },
  {
    id: 'redis',
    name: 'redis',
    description: 'Redis: чтение и запись ключей, списков, хешей. (Deprecated, но работает.)',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-redis'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-redis'],
    envVars: [],
    positionalArgs: [
      { label: 'Redis URL', placeholder: 'redis://localhost:6379', defaultValue: 'redis://localhost:6379', isRequired: false },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/redis',
  },
  {
    id: 'elasticsearch',
    name: 'elasticsearch',
    description: 'Elasticsearch: полнотекстовый поиск, аналитика, запросы к индексам. (Deprecated v0.3.1, v0.4+ на GitHub.)',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@elastic/mcp-server-elasticsearch'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@elastic/mcp-server-elasticsearch'],
    envVars: [
      { name: 'ELASTICSEARCH_URL', description: 'Elasticsearch URL', isRequired: true, isSecret: false },
      { name: 'ELASTICSEARCH_API_KEY', description: 'Elasticsearch API ключ', isRequired: false, isSecret: true },
    ],
    homepage: 'https://github.com/elastic/mcp-server-elasticsearch',
  },
  {
    id: 'supabase',
    name: 'supabase',
    description: 'Supabase: управление проектами, базы данных, SQL-запросы, аналитика.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@supabase/mcp-server-supabase'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@supabase/mcp-server-supabase'],
    envVars: [
      { name: 'SUPABASE_ACCESS_TOKEN', description: 'Supabase access token (supabase.com/dashboard/account/tokens)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/supabase/mcp',
    featured: true,
  },

  // ── Продуктивность ──
  {
    id: 'linear',
    name: 'linear',
    description: 'Linear: issues, projects, циклы. Управление задачами разработки.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-linear'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-linear'],
    envVars: [
      { name: 'LINEAR_API_KEY', description: 'Linear API ключ (linear.app/settings/api)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/linear/linear-mcp-server',
  },

  // ── DevOps / Cloud ──
  {
    id: 'cloudflare',
    name: 'cloudflare',
    description: 'Cloudflare API: DNS, Workers, R2, KV, Cache, Zones. Управление инфраструктурой Cloudflare.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@cloudflare/mcp-server-cloudflare'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@cloudflare/mcp-server-cloudflare'],
    envVars: [
      { name: 'CLOUDFLARE_API_TOKEN', description: 'Cloudflare API token (dash.cloudflare.com/profile/api-tokens)', isRequired: true, isSecret: true },
      { name: 'CLOUDFLARE_ACCOUNT_ID', description: 'Cloudflare Account ID', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/cloudflare/mcp-server-cloudflare',
  },
  {
    id: 'sentry',
    name: 'sentry',
    description: 'Sentry: поиск и анализ ошибок, issues, релизы. Мониторинг production-приложений.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@sentry/mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@sentry/mcp-server'],
    envVars: [
      { name: 'SENTRY_AUTH_TOKEN', description: 'Sentry auth token (sentry.io/settings/auth-tokens)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    id: 'vercel',
    name: 'vercel',
    description: 'Vercel MCP Adapter: деплой и управление проектами на Vercel.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@vercel/mcp-adapter'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@vercel/mcp-adapter'],
    envVars: [
      { name: 'VERCEL_TOKEN', description: 'Vercel access token (vercel.com/account/tokens)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/vercel/vercel/tree/main/packages/mcp-adapter',
  },

  // ── Карты ──
  {
    id: 'google-maps',
    name: 'google-maps',
    description: 'Google Maps API: маршруты, геокодинг, поиск мест. (Deprecated, но работает.)',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-google-maps'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-google-maps'],
    envVars: [
      { name: 'GOOGLE_MAPS_API_KEY', description: 'Google Maps API ключ (console.cloud.google.com)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-maps',
  },

  // ── Коммуникации ──
  {
    id: 'slack',
    name: 'slack',
    description: 'Slack: каналы, сообщения, поиск истории. (Deprecated, но работает.)',
    category: 'comms',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-slack'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-slack'],
    envVars: [
      { name: 'SLACK_BOT_TOKEN', description: 'Slack Bot token (xoxb-...)', isRequired: true, isSecret: true },
      { name: 'SLACK_TEAM_TOKEN', description: 'Slack Team token (xoxp-...)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },

  // ── DevOps ──
  {
    id: 'kubernetes',
    name: 'kubernetes',
    description: 'Kubernetes: управление подами, деплоями, сервисами. Выполнение kubectl через MCP.',
    category: 'devops',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-server-kubernetes'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-server-kubernetes'],
    envVars: [
      { name: 'KUBECONFIG', description: 'Путь к kubeconfig (опционально, по умолчанию ~/.kube/config)', isRequired: false, isSecret: false },
    ],
    homepage: 'https://github.com/Flux159/mcp-server-kubernetes',
    featured: true,
  },
  {
    id: 'kubectl',
    name: 'kubectl-mcp',
    description: 'kubectl MCP Server: натуральный язык → kubectl команды. Диагностика кластера, логи, ресурсы.',
    category: 'devops',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'kubectl-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'kubectl-mcp-server'],
    envVars: [],
    homepage: 'https://github.com/rohitg00/kubectl-mcp-server',
  },
  {
    id: 'docker',
    name: 'docker',
    description: 'Docker: выполнение команд в контейнерах, управление сервисами через docker-compose.',
    category: 'devops',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-server-docker'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-server-docker'],
    envVars: [
      { name: 'ALLOWED_CONTAINERS', description: 'Список разрешённых контейнеров (через запятую, опционально)', isRequired: false, isSecret: false },
    ],
    homepage: 'https://github.com/adamdude828/mcp-server-docker',
  },

  // ── Продуктивность (доп.) ──
  {
    id: 'figma',
    name: 'figma',
    description: 'Figma MCP: доступ к Figma-файлам, чтение дизайна, извлечение компонентов и стилей.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'figma-developer-mcp', '--stdio'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'figma-developer-mcp', '--stdio'],
    envVars: [
      { name: 'FIGMA_API_KEY', description: 'Figma Personal Access Token (figma.com/settings)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/GLips/Figma-Context-MCP',
    featured: true,
  },
  {
    id: 'notion',
    name: 'notion',
    description: 'Notion MCP (официальный): чтение и редактирование страниц, баз данных, комментариев.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@notionhq/notion-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@notionhq/notion-mcp-server'],
    envVars: [
      { name: 'OPENAPI_MCP_HEADERS', description: 'JSON с заголовками Notion API: {"Authorization":"Bearer ntn_...","Notion-Version":"2025-05-20"}', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/makenotion/notion-mcp-server',
    featured: true,
  },
  {
    id: 'obsidian',
    name: 'obsidian',
    description: 'Obsidian MCP: чтение и поиск по заметкам в Obsidian vault. Управление заметками через AI.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'obsidian-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'obsidian-mcp'],
    envVars: [
      { name: 'OBSIDIAN_API_KEY', description: 'Obsidian Local REST API ключ (нужен плагин Local REST API)', isRequired: true, isSecret: true },
      { name: 'OBSIDIAN_HOST', description: 'Адрес Obsidian REST API (по умолчанию 127.0.0.1)', isRequired: false, isSecret: false },
    ],
    homepage: 'https://github.com/StevenStavrakis/obsidian-mcp',
  },
  {
    id: 'excel',
    name: 'excel',
    description: 'Excel MCP: чтение Excel-файлов, листов, запросы к данным. Поддержка .xlsx.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'excel-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'excel-mcp-server'],
    envVars: [],
    homepage: 'https://github.com/haris-musa/excel-mcp-server',
  },

  // ── Браузер (доп.) ──
  {
    id: 'chrome-devtools',
    name: 'chrome-devtools',
    description: 'Chrome DevTools MCP (от Google): отладка веб-страниц, скриншоты, инспекция DOM, производительность.',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'chrome-devtools-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'chrome-devtools-mcp'],
    envVars: [],
    homepage: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    featured: true,
  },

  // ── Код (доп.) ──
  {
    id: 'shadcn-ui',
    name: 'shadcn-ui',
    description: 'shadcn/ui MCP: поиск и референсы компонентов shadcn/ui. Помогает AI использовать правильные компоненты.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'shadcn-ui-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'shadcn-ui-mcp-server'],
    envVars: [],
    homepage: 'https://github.com/ymadd/shadcn-ui-mcp-server',
  },

  // ── Утилиты (доп.) ──
  {
    id: 'fetch',
    name: 'fetch',
    description: 'Fetch MCP: HTTP-запросы к любым URL, получение HTML/JSON. Простой веб-скрапинг.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'fetch-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'fetch-mcp'],
    envVars: [],
    homepage: 'https://github.com/egoist/fetch-mcp',
  },
]

/** Возвращает кураторные серверы по категории. 'all' = все. */
export function getCuratedByCategory(category: CuratedMcpCategory | 'all'): CuratedMcpServer[] {
  if (category === 'all') return CURATED_MCP_SERVERS
  return CURATED_MCP_SERVERS.filter(s => s.category === category)
}

/** Возвращает кураторный сервер по id. */
export function getCuratedById(id: string): CuratedMcpServer | undefined {
  return CURATED_MCP_SERVERS.find(s => s.id === id)
}

/**
 * Возвращает stdio-команду для текущей платформы.
 * null = сервер не поддерживает stdio на этой платформе.
 */
export function getCuratedCommand(server: CuratedMcpServer, isWin: boolean): { command: string; args: string[] } | null {
  if (isWin) {
    if (!server.winCommand || !server.winArgs) return null
    return { command: server.winCommand, args: server.winArgs }
  }
  if (!server.unixCommand || !server.unixArgs) return null
  return { command: server.unixCommand, args: server.unixArgs }
}
