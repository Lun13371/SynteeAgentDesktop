/**
 * Кураторный список популярных MCP-серверов.
 *
 * Встроен в приложение — не зависит от медленного официального реестра
 * (registry.modelcontextprotocol.io отвечает 5-25с). Каждый сервер можно
 * установить в один клик через прямую установку (mcp:installDirect) —
 * приложение само пишет mcp.json и запускает подключение.
 *
 * Серверы отобраны вручную: стабильно работающие, полезные, с активной
 * поддержкой. Категории для фильтрации в UI.
 */

export type CuratedMcpCategory = 'search' | 'files' | 'code' | 'docs' | 'browser' | 'data' | 'utils' | 'productivity' | 'ai' | 'comms'

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
  {
    id: 'filesystem',
    name: 'filesystem',
    description: 'Доступ к файловой системе: чтение, запись, поиск файлов. Настраиваемые разрешённые директории.',
    category: 'files',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    envVars: [],
    positionalArgs: [
      {
        label: 'Разрешённые директории',
        placeholder: 'C:\\Users\\cegor (через пробел — несколько)',
        defaultValue: '',
        isRequired: true,
      },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    featured: true,
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    description: 'Структурированные рассуждения: пошаговый анализ сложных задач с возможностью ревизии и ветвления.',
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
    id: 'fetch',
    name: 'fetch',
    description: 'Прямая загрузка веб-страниц: HTTP-запросы и конвертация HTML в Markdown для анализа.',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-fetch'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-fetch'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'memory',
    name: 'memory',
    description: 'Персистентная память между сессиями: граф знаний с сущностями и связями. Запоминает факты о пользователе.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-memory'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-memory'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'time',
    name: 'time',
    description: 'Текущее время и конвертация часовых поясов. Полезно для планирования и работы с датами.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-time'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-time'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    description: 'Прямой доступ к SQLite-базам: запросы, схема, запись. Для анализа данных без кода.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-sqlite'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-sqlite'],
    envVars: [],
    positionalArgs: [
      {
        label: 'Путь к базе данных',
        placeholder: 'C:\\path\\to\\database.db',
        defaultValue: '',
        isRequired: true,
      },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    description: 'Веб-поиск через Brave Search API. Актуальные результаты с веб-страниц, новостями и изображениями.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-brave-search'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars: [
      { name: 'BRAVE_API_KEY', description: 'API ключ Brave Search (brave.com/search/api)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
    featured: true,
  },
  {
    id: 'github',
    name: 'github',
    description: 'GitHub API: репозитории, issues, PR, коммиты. Поиск кода, управление проектами.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-github'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-github'],
    envVars: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub PAT (github.com/settings/tokens)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    featured: true,
  },
  {
    id: 'gitlab',
    name: 'gitlab',
    description: 'GitLab API: проекты, merge requests, pipelines. Управление репозиториями GitLab.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-gitlab'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-gitlab'],
    envVars: [
      { name: 'GITLAB_PERSONAL_ACCESS_TOKEN', description: 'GitLab PAT (gitlab.com/-/profile/personal_access_tokens)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab',
  },
  {
    id: 'puppeteer',
    name: 'puppeteer',
    description: 'Автоматизация браузера: навигация, скриншоты, заполнение форм, парсинг динамических страниц. Требует установки Chromium (npx puppeteer browsers install chrome).',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-puppeteer'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-puppeteer'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  {
    id: 'postgres',
    name: 'postgres',
    description: 'Прямые запросы к PostgreSQL: схема, данные, аналитика. Только для чтения по умолчанию.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-postgres'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-postgres'],
    envVars: [
      { name: 'POSTGRES_CONNECTION_STRING', description: 'Строка подключения postgres://user:pass@host:5432/db', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres',
  },
  {
    id: 'google-maps',
    name: 'google-maps',
    description: 'Google Maps API: геокодирование, маршруты, места, часовой пояс.',
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
  {
    id: 'slack',
    name: 'slack',
    description: 'Slack API: каналы, сообщения, поиск. Чтение и отправка сообщений в Slack.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-slack'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-slack'],
    envVars: [
      { name: 'SLACK_BOT_TOKEN', description: 'Slack Bot Token (xoxb-...)', isRequired: true, isSecret: true },
      { name: 'SLACK_TEAM_ID', description: 'ID команды Slack (T...)', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack',
  },
  {
    id: 'everart',
    name: 'everart',
    description: 'Генерация изображений через EverArt API. Создание картинок по текстовому описанию.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-everart'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-everart'],
    envVars: [
      { name: 'EVERART_API_KEY', description: 'EverArt API ключ (everart.ai)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everart',
  },
  {
    id: 'obsidian',
    name: 'obsidian',
    description: 'Доступ к заметкам Obsidian: чтение, поиск, создание. Работает с локальным хранилищем.',
    category: 'docs',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-obsidian'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-obsidian'],
    envVars: [
      { name: 'OBSIDIAN_VAULT_PATH', description: 'Абсолютный путь к хранилищу Obsidian', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/obsidian',
  },
  // ── Поиск / Web ──
  {
    id: 'exa',
    name: 'exa',
    description: 'AI-поиск через Exa API. Семантический поиск по вебу, актуальные результаты для исследований.',
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
    id: 'tavily',
    name: 'tavily',
    description: 'Tavily Search API — поиск для AI-агентов. Структурированные результаты, извлечение контента.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'tavily-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'tavily-mcp'],
    envVars: [
      { name: 'TAVILY_API_KEY', description: 'Tavily API ключ (tavily.com)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/tavily-ai/tavily-mcp',
  },
  {
    id: 'brave-search-core',
    name: 'brave-search-core',
    description: 'Brave Search — веб-поиск, новости, изображения. Расширенная версия с фильтрами.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-brave-search'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
    envVars: [
      { name: 'BRAVE_API_KEY', description: 'Brave Search API ключ', isRequired: true, isSecret: true },
    ],
    homepage: 'https://brave.com/search/api/',
  },
  {
    id: 'firecrawl',
    name: 'firecrawl',
    description: 'Firecrawl — скрейпинг и конвертация веб-страниц в markdown. Поддержка JS-сайтов.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'firecrawl-mcp'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'firecrawl-mcp'],
    envVars: [
      { name: 'FIRECRAWL_API_KEY', description: 'Firecrawl API ключ (firecrawl.dev)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/mendableai/firecrawl-mcp-server',
  },
  // ── Код / DevOps ──
  {
    id: 'git',
    name: 'git',
    description: 'Git операции: статус, diff, лог, коммиты, ветки. Работа с локальными репозиториями.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@cyanheads/git-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@cyanheads/git-mcp-server'],
    envVars: [],
    homepage: 'https://github.com/cyanheads/git-mcp-server',
  },
  {
    id: 'docker',
    name: 'docker',
    description: 'Docker: управление контейнерами, образами, volumes. Статус, логи, exec.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@ckreiling/mcp-server-docker'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@ckreiling/mcp-server-docker'],
    envVars: [],
    homepage: 'https://github.com/ckreiling/mcp-server-docker',
  },
  {
    id: 'kubernetes',
    name: 'kubernetes',
    description: 'Kubernetes: управление подами, деплойментами, сервисами. Логи, exec, масштабирование.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@manusa/kubernetes-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@manusa/kubernetes-mcp-server'],
    envVars: [],
    homepage: 'https://github.com/manusa/kubernetes-mcp-server',
  },
  {
    id: 'vercel',
    name: 'vercel',
    description: 'Vercel: деплой, управление проектами, окружения, домены. API для хостинга.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@vercel/mcp-adapter'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@vercel/mcp-adapter'],
    envVars: [
      { name: 'VERCEL_TOKEN', description: 'Vercel API токен (vercel.com/account/tokens)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/vercel/mcp-adapter',
  },
  // ── Данные ──
  {
    id: 'mongodb',
    name: 'mongodb',
    description: 'MongoDB: запросы, агрегации, схема. Прямой доступ к NoSQL-базе.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-mongodb'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-mongodb'],
    envVars: [
      { name: 'MONGODB_URI', description: 'Строка подключения mongodb://...', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/mongodb',
  },
  {
    id: 'mysql',
    name: 'mysql',
    description: 'MySQL: запросы, схема, данные. Только для чтения по умолчанию.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@benborla29/mcp-server-mysql'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@benborla29/mcp-server-mysql'],
    envVars: [
      { name: 'MYSQL_HOST', description: 'Хост MySQL', isRequired: true, isSecret: false },
      { name: 'MYSQL_USER', description: 'Пользователь MySQL', isRequired: true, isSecret: false },
      { name: 'MYSQL_PASSWORD', description: 'Пароль MySQL', isRequired: true, isSecret: true },
      { name: 'MYSQL_DATABASE', description: 'Имя базы данных', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/benborla/mcp-server-mysql',
  },
  {
    id: 'redis',
    name: 'redis',
    description: 'Redis: ключ-значение, списки, множества. Кэш, очереди, pub/sub.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-redis'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-redis'],
    envVars: [
      { name: 'REDIS_URL', description: 'URL Redis redis://host:6379', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/redis',
  },
  {
    id: 'elasticsearch',
    name: 'elasticsearch',
    description: 'Elasticsearch: полнотекстовый поиск, агрегации, индексы.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@elastic/mcp-server-elasticsearch'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@elastic/mcp-server-elasticsearch'],
    envVars: [
      { name: 'ES_URL', description: 'URL Elasticsearch http://localhost:9200', isRequired: true, isSecret: false },
      { name: 'ES_API_KEY', description: 'API ключ Elasticsearch (опционально)', isRequired: false, isSecret: true },
    ],
    homepage: 'https://github.com/elastic/mcp-server-elasticsearch',
  },
  {
    id: 'supabase',
    name: 'supabase',
    description: 'Supabase: PostgreSQL, Auth, Storage, Realtime. Управление проектом.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@supabase/mcp-server-supabase'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@supabase/mcp-server-supabase'],
    envVars: [
      { name: 'SUPABASE_ACCESS_TOKEN', description: 'Supabase access token', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/supabase/mcp-server-supabase',
  },
  {
    id: 'qdrant',
    name: 'qdrant',
    description: 'Qdrant: векторная база данных. Семантический поиск, embeddings.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@qdrant/mcp-server-qdrant'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@qdrant/mcp-server-qdrant'],
    envVars: [
      { name: 'QDRANT_URL', description: 'URL Qdrant http://localhost:6333', isRequired: true, isSecret: false },
      { name: 'QDRANT_API_KEY', description: 'API ключ Qdrant (опционально)', isRequired: false, isSecret: true },
    ],
    homepage: 'https://github.com/qdrant/mcp-server-qdrant',
  },
  // ── Продуктивность ──
  {
    id: 'notion',
    name: 'notion',
    description: 'Notion: страницы, базы данных, задачи. Чтение и редактирование рабочего пространства.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-notion'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-notion'],
    envVars: [
      { name: 'NOTION_API_KEY', description: 'Notion API ключ (notion.so/my-integrations)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/notion',
    featured: true,
  },
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
  {
    id: 'jira',
    name: 'jira',
    description: 'Jira: задачи, спринты, доски. Управление проектами Atlassian.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-jira'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-jira'],
    envVars: [
      { name: 'JIRA_API_TOKEN', description: 'Jira API токен', isRequired: true, isSecret: true },
      { name: 'JIRA_EMAIL', description: 'Email для Jira API', isRequired: true, isSecret: false },
      { name: 'JIRA_DOMAIN', description: 'Домен Jira (your-org.atlassian.net)', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/sooperset/mcp-atlassian',
  },
  {
    id: 'asana',
    name: 'asana',
    description: 'Asana: задачи, проекты, тимиды. Управление командной работой.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-asana'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-asana'],
    envVars: [
      { name: 'ASANA_ACCESS_TOKEN', description: 'Asana access token', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/asana',
  },
  {
    id: 'trello',
    name: 'trello',
    description: 'Trello: доски, карточки, списки. Kanban-управление проектами.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-trello'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-trello'],
    envVars: [
      { name: 'TRELLO_API_KEY', description: 'Trello API ключ', isRequired: true, isSecret: false },
      { name: 'TRELLO_TOKEN', description: 'Trello токен', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/trello',
  },
  {
    id: 'airtable',
    name: 'airtable',
    description: 'Airtable: базы данных, записи, представления. Управление таблицами.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-airtable'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-airtable'],
    envVars: [
      { name: 'AIRTABLE_API_KEY', description: 'Airtable API ключ', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/airtable',
  },
  {
    id: 'todoist',
    name: 'todoist',
    description: 'Todoist: задачи, проекты, метки. Управление личными и командными задачами.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-todoist'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-todoist'],
    envVars: [
      { name: 'TODOIST_API_TOKEN', description: 'Todoist API токен', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/todoist',
  },
  // ── Браузер ──
  {
    id: 'playwright',
    name: 'playwright',
    description: 'Playwright: автоматизация браузера. Навигация, клики, скриншоты, парсинг динамических страниц.',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@executeautomation/playwright-mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@executeautomation/playwright-mcp-server'],
    envVars: [],
    homepage: 'https://github.com/executeautomation/mcp-playwright',
    featured: true,
  },
  {
    id: 'browserbase',
    name: 'browserbase',
    description: 'Browserbase: облачная автоматизация браузера. Сессии, скриншоты, PDF.',
    category: 'browser',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@browserbase/mcp-server-browserbase'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@browserbase/mcp-server-browserbase'],
    envVars: [
      { name: 'BROWSERBASE_API_KEY', description: 'Browserbase API ключ', isRequired: true, isSecret: true },
      { name: 'BROWSERBASE_PROJECT_ID', description: 'Browserbase project ID', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/browserbase/mcp-server-browserbase',
  },
  // ── AI ──
  {
    id: 'openai-dalle',
    name: 'openai-dalle',
    description: 'OpenAI DALL-E: генерация изображений по текстовому описанию.',
    category: 'ai',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-openai-dalle'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-openai-dalle'],
    envVars: [
      { name: 'OPENAI_API_KEY', description: 'OpenAI API ключ', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/openai-dalle',
  },
  {
    id: 'stability',
    name: 'stability',
    description: 'Stability AI: генерация изображений через Stable Diffusion API.',
    category: 'ai',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-stability'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-stability'],
    envVars: [
      { name: 'STABILITY_API_KEY', description: 'Stability AI API ключ', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/stability',
  },
  {
    id: 'replicate',
    name: 'replicate',
    description: 'Replicate: запуск ML-моделей. Генерация изображений, аудио, видео.',
    category: 'ai',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-replicate'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-replicate'],
    envVars: [
      { name: 'REPLICATE_API_TOKEN', description: 'Replicate API токен', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/replicate',
  },
  // ── Коммуникации ──
  {
    id: 'discord',
    name: 'discord',
    description: 'Discord: каналы, сообщения, роли. Чтение и отправка сообщений.',
    category: 'comms',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-discord'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-discord'],
    envVars: [
      { name: 'DISCORD_BOT_TOKEN', description: 'Discord bot token', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/discord',
  },
  {
    id: 'telegram',
    name: 'telegram',
    description: 'Telegram Bot API: отправка сообщений, управление чатами, файлы.',
    category: 'comms',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-server-telegram'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-server-telegram'],
    envVars: [
      { name: 'TELEGRAM_BOT_TOKEN', description: 'Telegram bot token (@BotFather)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/chigwell/telegram-mcp',
  },
  {
    id: 'twilio',
    name: 'twilio',
    description: 'Twilio: SMS, звонки, WhatsApp. Отправка сообщений через API.',
    category: 'comms',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-twilio'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-twilio'],
    envVars: [
      { name: 'TWILIO_ACCOUNT_SID', description: 'Twilio Account SID', isRequired: true, isSecret: false },
      { name: 'TWILIO_AUTH_TOKEN', description: 'Twilio Auth Token', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/twilio',
  },
  // ── Утилиты / Мониторинг ──
  {
    id: 'sentry',
    name: 'sentry',
    description: 'Sentry: ошибки, трекинг багов, релизы. Мониторинг production-приложений.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@sentry/mcp-server'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@sentry/mcp-server'],
    envVars: [
      { name: 'SENTRY_AUTH_TOKEN', description: 'Sentry auth token', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/getsentry/sentry-mcp-server',
  },
  {
    id: 'stripe',
    name: 'stripe',
    description: 'Stripe: платежи, клиенты, подписки. Управление через API.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-stripe'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-stripe'],
    envVars: [
      { name: 'STRIPE_API_KEY', description: 'Stripe API ключ (sk_...)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/stripe',
  },
  {
    id: 'sendgrid',
    name: 'sendgrid',
    description: 'SendGrid: отправка email, шаблоны, управление контактами.',
    category: 'comms',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-sendgrid'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-sendgrid'],
    envVars: [
      { name: 'SENDGRID_API_KEY', description: 'SendGrid API ключ', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sendgrid',
  },
  {
    id: 'cloudflare',
    name: 'cloudflare',
    description: 'Cloudflare: DNS, workers, страницы. Управление инфраструктурой.',
    category: 'utils',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@cloudflare/mcp-server-cloudflare'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@cloudflare/mcp-server-cloudflare'],
    envVars: [
      { name: 'CLOUDFLARE_API_TOKEN', description: 'Cloudflare API токен', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/cloudflare/mcp-server-cloudflare',
  },
  {
    id: 'google-drive',
    name: 'google-drive',
    description: 'Google Drive: файлы, папки, поиск. Чтение и загрузка документов.',
    category: 'docs',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-google-drive'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-google-drive'],
    envVars: [
      { name: 'GOOGLE_CLIENT_ID', description: 'Google OAuth Client ID', isRequired: true, isSecret: false },
      { name: 'GOOGLE_CLIENT_SECRET', description: 'Google OAuth Client Secret', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/google-drive',
  },
  {
    id: 'dropbox',
    name: 'dropbox',
    description: 'Dropbox: файлы, папки, загрузка. Доступ к облачному хранилищу.',
    category: 'docs',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-dropbox'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-dropbox'],
    envVars: [
      { name: 'DROPBOX_ACCESS_TOKEN', description: 'Dropbox access token', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/dropbox',
  },
  {
    id: 'figma',
    name: 'figma',
    description: 'Figma: дизайн-файлы, компоненты, стили. Чтение макетов для разработки.',
    category: 'ai',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@anthropics/mcp-figma'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@anthropics/mcp-figma'],
    envVars: [
      { name: 'FIGMA_API_KEY', description: 'Figma API ключ (figma.com/developers)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/anthropics/mcp-figma',
  },
  {
    id: 'blender',
    name: 'blender',
    description: 'Blender 3D: создание сцен, рендеринг, моделирование через Python API.',
    category: 'ai',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-blender'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-blender'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/blender',
  },
  {
    id: 'clickup',
    name: 'clickup',
    description: 'ClickUp: задачи, списки, пространства. Управление проектами и командами.',
    category: 'productivity',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-clickup'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-clickup'],
    envVars: [
      { name: 'CLICKUP_API_TOKEN', description: 'ClickUp API токен', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/TaimuriEstGmbh/mcp-clickup',
  },
  {
    id: 'confluence',
    name: 'confluence',
    description: 'Confluence: страницы, пространства, поиск. Доступ к корпоративной базе знаний.',
    category: 'docs',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@sooperset/mcp-atlassian'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@sooperset/mcp-atlassian'],
    envVars: [
      { name: 'ATLASSIAN_API_TOKEN', description: 'Atlassian API токен', isRequired: true, isSecret: true },
      { name: 'ATLASSIAN_EMAIL', description: 'Email для Atlassian API', isRequired: true, isSecret: false },
      { name: 'ATLASSIAN_DOMAIN', description: 'Домен (your-org.atlassian.net)', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/sooperset/mcp-atlassian',
  },
  {
    id: 'neo4j',
    name: 'neo4j',
    description: 'Neo4j: графовая база данных. Cypher-запросы, связи, анализ графов.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-neo4j'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-neo4j'],
    envVars: [
      { name: 'NEO4J_URI', description: 'URI Neo4j (bolt://localhost:7687)', isRequired: true, isSecret: false },
      { name: 'NEO4J_USER', description: 'Пользователь Neo4j', isRequired: true, isSecret: false },
      { name: 'NEO4J_PASSWORD', description: 'Пароль Neo4j', isRequired: true, isSecret: true },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/neo4j',
  },
  {
    id: 'serper',
    name: 'serper',
    description: 'Serper.dev: быстрый Google Search API. Актуальные результаты поиска.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-server-serper'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-server-serper'],
    envVars: [
      { name: 'SERPER_API_KEY', description: 'Serper API ключ (serper.dev)', isRequired: true, isSecret: true },
    ],
    homepage: 'https://serper.dev',
  },
  {
    id: 'perplexity',
    name: 'perplexity',
    description: 'Perplexity API: AI-поиск с источниками. Ответы на основе актуального веба.',
    category: 'search',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', 'mcp-perplexity'],
    unixCommand: 'npx',
    unixArgs: ['-y', 'mcp-perplexity'],
    envVars: [
      { name: 'PERPLEXITY_API_KEY', description: 'Perplexity API ключ', isRequired: true, isSecret: true },
    ],
    homepage: 'https://docs.perplexity.ai',
  },
  {
    id: 's3',
    name: 's3',
    description: 'AWS S3: бакеты, объекты, загрузка/скачивание файлов. Облачное хранилище.',
    category: 'data',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-s3'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-s3'],
    envVars: [
      { name: 'AWS_ACCESS_KEY_ID', description: 'AWS Access Key ID', isRequired: true, isSecret: false },
      { name: 'AWS_SECRET_ACCESS_KEY', description: 'AWS Secret Access Key', isRequired: true, isSecret: true },
      { name: 'AWS_REGION', description: 'AWS регион (us-east-1)', isRequired: true, isSecret: false },
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/s3',
  },
  {
    id: 'ssh',
    name: 'ssh',
    description: 'SSH: выполнение команд на удалённых серверах. Управление через SSH-подключения.',
    category: 'code',
    winCommand: 'cmd',
    winArgs: ['/c', 'npx', '-y', '@modelcontextprotocol/server-ssh'],
    unixCommand: 'npx',
    unixArgs: ['-y', '@modelcontextprotocol/server-ssh'],
    envVars: [],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/ssh',
  },
]

/** Возвращает кураторные серверы, отфильтрованные по категории. */
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
