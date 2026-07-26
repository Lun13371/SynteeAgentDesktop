import type { McpToolRuntime } from '../../shared/types'
import { PLAN_TOOL_SCHEMA } from './plan'

export const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Редактировать файл. replace — заменить фрагмент (с fuzzy по отступам), insert — вставить после строки, overwrite — перезаписать, apply_patch — надёжная замена по search/replace блокам (Codex-style, для множественных правок). create_if_not_exists=true создаёт файл и директории. Возвращает diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          mode: { type: 'string', enum: ['replace', 'insert', 'overwrite', 'apply_patch'], description: 'Режим редактирования' },
          old_str: { type: 'string', description: '[replace] Уникальный фрагмент для замены. Включай 2-3 строки контекста.' },
          new_str: { type: 'string', description: '[replace] Новый фрагмент (пустая строка = удалить)' },
          after_line: { type: 'number', description: '[insert] Вставить после этой строки (1-indexed)' },
          content: { type: 'string', description: '[insert/overwrite] Контент для вставки или перезаписи' },
          patch: { type: 'string', description: '[apply_patch] Search/replace патч. Формат: блоки <<<<<<< SEARCH / ======= / >>>>>>> REPLACE. Каждый блок заменяет одно точное вхождение. Надёжнее чем replace для множественных правок.' },
          create_if_not_exists: { type: 'boolean', description: 'Создать файл (и директории) если не существует' },
        },
        required: ['path', 'mode'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'multi_edit_file',
      description: 'Несколько замен в одном файле за один вызов. Используй когда нужно изменить 2+ независимых места в файле.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          edits: {
            type: 'array',
            description: 'Список замен — применяются последовательно',
            items: {
              type: 'object',
              properties: {
                old_str: { type: 'string', description: 'Уникальный фрагмент для замены' },
                new_str: { type: 'string', description: 'Новый фрагмент' },
              },
              required: ['old_str', 'new_str'],
            },
          },
        },
        required: ['path', 'edits'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_command',
      description: 'Выполнить команду в терминале. Windows: PowerShell по умолчанию (ls/cat/rm/Get-Process/$env:PATH и т.д.), cmd — через shell:"cmd". Linux/Mac: bash. Указывай cwd для проектов, timeout для долгих операций.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Команда' },
          cwd: { type: 'string', description: 'Рабочая директория' },
          shell: { type: 'string', enum: ['powershell', 'cmd'], description: 'Шелл (только Windows, по умолч. powershell)' },
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 60)' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_diagnostics',
      description: 'Проверить проект на ошибки TypeScript-компиляции и линтинга (tsc --noEmit + eslint). Вызывай после серии правок кода, чтобы убедиться, что изменения не поломали типы или стиль. Возвращает список ошибок с file:line.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Директория проекта (по умолч. рабочая директория чата)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Читает файл. Без offset — первые 100 строк + авто-outline структуры если файл > 100 строк. С offset/limit — точный диапазон строк. outline_only=true — только структура (функции, классы, экспорты) без содержимого — быстро сориентироваться в большом файле. Всегда показывает [total_lines] и подсказку если файл обрезан.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Абсолютный путь к файлу' },
          offset: { type: 'number', description: 'Начальная строка (1-indexed). Для чтения по частям.' },
          limit: { type: 'number', description: 'Кол-во строк (по умолч. 200). Увеличь до 500 если нужно больше.' },
          outline_only: { type: 'boolean', description: 'true — вернуть только структуру файла (функции, классы, экспорты) без содержимого. Удобно чтобы сориентироваться в большом файле.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'ПОЛНАЯ ПЕРЕЗАПИСЬ файла целиком. Для изменений в существующем файле используй edit_file (mode=replace или overwrite) — он безопаснее и возвращает diff. write_file только для создания нового файла с нуля или полного замены содержимого. Возвращает diff.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к файлу' },
          content: { type: 'string', description: 'Содержимое файла' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_directory',
      description: 'Показать содержимое папки в виде дерева. recursive=true обходит вложенные папки (depth по умолч. 3). Игнорирует node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Путь к папке' },
          recursive: { type: 'boolean', description: 'Рекурсивный обход (по умолч. false)' },
          depth: { type: 'number', description: 'Глубина рекурсии (по умолч. 3)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_web',
      description: 'Поиск в интернете через Tavily API. Используй для актуальной информации — новости, документация, ответы на вопросы.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Поисковый запрос' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'http_request',
      description: 'Прямой HTTP-запрос к API или веб-странице. GET/POST/PUT/DELETE/PATCH с заголовками и телом. Возвращает status, headers, body. Быстрее и надёжнее чем curl через run_command — нет проблем с экранированием. Используй для: API-вызовы, вебхуки, скачивание JSON/XML, проверка эндпоинтов. ВАЖНО: success=true означает что запрос выполнился, а не что HTTP-статус успешный — всегда проверяй Status в выводе (404/500 тоже success=true).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL (http:// или https://)' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'], description: 'HTTP-метод (по умолч. GET)' },
          headers: { type: 'object', description: 'Заголовки запроса. Например: {"Authorization": "Bearer ...", "Content-Type": "application/json"}', additionalProperties: { type: 'string' } },
          body: { type: 'string', description: 'Тело запроса (для POST/PUT/PATCH). JSON-строка, XML, plain text — что угодно.' },
          timeout: { type: 'number', description: 'Таймаут в секундах (по умолч. 30)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_system_info',
      description: 'Получить информацию о системе (OS, память, uptime).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description: 'Сгенерировать изображение по текстовому описанию. Используй когда пользователь просит нарисовать, создать или сгенерировать изображение/картинку.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Детальное описание изображения на английском языке для лучшего качества' },
          model: { type: 'string', description: 'Модель генерации (опционально). Например: dall-e-3, dall-e-2, gpt-image-1' },
          size: { type: 'string', description: 'Размер изображения (опционально). Например: 1024x1024, 1792x1024, 1024x1792' },
          quality: { type: 'string', description: 'Качество: standard, hd (dall-e-3) или low, medium, high (gpt-image-1)' },
          style: { type: 'string', description: 'Стиль (только dall-e-3): vivid или natural' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_files',
      description: 'Прочитать несколько файлов за один раз. Используй вместо read_file когда нужно посмотреть сразу несколько файлов проекта.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Список абсолютных путей к файлам (до 10 штук)',
          },
        },
        required: ['paths'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_code',
      description: 'Поиск по коду: regex или текст в файлах. Использует ripgrep (быстро) или PowerShell. Уважает .gitignore, ищет в скрытых dot-директориях (.vscode/.planning/...), исключая .git и секреты (.env/.pem/.key). Возвращает файлы + номера строк + контекст. path — абсолютный (C:\\Projects\\... или /c/Projects/...) или относительный от workdir.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex или строка. Пример: "useState", "import.*axios", "class\\s+User"' },
          path: { type: 'string', description: 'Директория или файл для поиска (абсолютный или относительный от workdir)' },
          file_glob: { type: 'string', description: 'Фильтр файлов: "*.ts", "*.py", "*.{ts,tsx}"' },
          ignore_case: { type: 'boolean', description: 'Без учёта регистра (по умолч. false)' },
          literal: { type: 'boolean', description: 'Искать паттерн дословно (без regex). Удобно для текста со спецсимволами: "arr[i]", "a.b.c", "$env". По умолч. false.' },
          max_results: { type: 'number', description: 'Макс. совпадений всего (по умолч. 50)' },
          context: { type: 'number', description: 'Строк контекста вокруг совпадения (по умолч. 2)' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'analyze_project',
      description: 'Полный анализ проекта — структура файлов, зависимости, git статус, статистика. Вызывай в начале работы с незнакомым проектом.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Абсолютный путь к корню проекта' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_fast_context',
      description: 'Быстрый контекст проекта: находит релевантные файлы и line ranges по запросу через tree-sitter индекс символов + fast LLM. Используй ПЕРВЫМ шагом для любой задачи чтобы мгновенно понять какие файлы/функции/классы относятся к запросу — экономит токены основной модели на поиск. Покрывает 80% случаев "где реализован X" за ~1-3с. Результат: список файлов с line ranges и краткое summary. Не заменяет read_file для деталей — используй его после чтобы прочитать найденные файлы.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Что найти: функционал, имя функции/класса, файл, концепция. Пример: "где реализован OAuth flow", "модель данных User", "обработка платежей"' },
          maxFiles: { type: 'number', description: 'Макс. файлов вернуть (по умолч. 50)' },
          maxTokens: { type: 'number', description: 'Бюджет repo-map slice в токенах (по умолч. 8000)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_files',
      description: 'Найти файлы по имени или regex-паттерну. Используй когда нужно найти файл по имени: "где ChatPage.tsx?", "найди все *.config.ts". Игнорирует node_modules/dist/.git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Имя файла, glob (*.tsx) или regex. Пример: "ChatPage.tsx", "*.config.ts", "index\\.(ts|tsx)"' },
          path: { type: 'string', description: 'Директория для поиска' },
          max_results: { type: 'number', description: 'Макс. результатов (по умолч. 50)' },
        },
        required: ['pattern', 'path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'spawn_agent',
      description: 'Запустить суб-агента для подзадачи с чистым контекстом. Блокирует ход до завершения, возвращает summary (что сделано, изменённые файлы, diffs, выполненные команды — до 4000 симв.). Суб-агент УЖЕ получает контекст родителя (summary чата + рабочая память + последние 12 сообщений истории) — НЕ дублируй его в task. Используй для: независимых подзадач (параллельные исследования A и B), длинных задач засоряющих контекст, делегирования крупных пунктов Todo-плана. НЕ используй для последовательных шагов или тривиальных задач в 1-2 тула (оверхед). task должна быть самодостаточной: что сделать, пути к файлам, ограничения, что вернуть. Параллельно до 3 агентов, дальше — очередь. Не вызывай get_agent_status в цикле — spawn_agent сам вернёт результат. По умолчанию (isolation=auto) суб-агент пишет в workdir родителя, если параллельных суб-агентов на этом проекте нет; при их наличии автоматически создаётся отдельный git worktree (изолированная копия от HEAD) и дельта сливается обратно после завершения.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Подробное описание задачи для суб-агента' },
          approval_mode: { type: 'string', enum: ['auto', 'ask', 'full'], description: 'Режим подтверждения суб-агента (по умолч. наследуется от родителя). full — без подтверждений, ask — на каждый тул, auto — умная детекция' },
          isolation: { type: 'string', enum: ['auto', 'worktree', 'none'], description: 'Изоляция файлов суб-агента. auto (по умолч.) — worktree только при наличии параллельного суб-агента на этом workdir, иначе shared (видит WIP родителя); worktree — всегда отдельный git worktree от HEAD (для независимых задач: суб-агент не видит незафиксированные правки родителя, дельта сливается через git apply --3way); none — явно писать в workdir родителя (только для зависимых/только-чтение задач). Не-git workdir всегда fallback на shared.' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_agent_status',
      description: 'Проверить статус суб-агента — активен ли, что сейчас делает, сколько шагов выполнил. Используй редко — spawn_agent сам ждёт завершения. Полезен только для UI или если нужно узнать прогресс уже завершённого агента.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'ID суб-агента из [AGENT:id] маркера' },
        },
        required: ['agent_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'think',
      description: 'Внутренний монолог — используй ПЕРЕД сложными действиями. Напиши план: что нужно сделать, в каком порядке, какие файлы прочитать, какие риски. Результат не виден пользователю — только тебе. Не тратит его токены.',
      parameters: {
        type: 'object',
        properties: {
          thought: {
            type: 'string',
            description: 'Твои рассуждения, план действий, анализ ситуации.',
          },
        },
        required: ['thought'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'revert_last_change',
      description: 'Откатить последние изменения файлов (undo/rollback). Восстанавливает оригинальное содержимое. Используй когда понял, что сделал неправильную правку.',
      parameters: {
        type: 'object',
        properties: {
          steps: { type: 'number', description: 'Сколько последних изменений откатить (по умолч. 1)' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_todo',
      description: 'Обновить чек-лист задачи (todo list). Используй для многошаговых задач — пользователь видит прогресс в чате. Вызывай в начале (с планом) и после каждого завершённого шага.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Список шагов. Каждый шаг: { text, status }.',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Описание шага' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'], description: 'Статус шага' },
              },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_working_memory',
      description: 'Обновляет рабочую память чата — заметки о проекте, сделанных изменениях, текущем состоянии. Вызывай в конце сессии чтобы запомнить важное для следующих сообщений. Максимум ~2000 токенов.',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Новое содержимое рабочей памяти. Полностью заменяет старое. Пиши компактно: что сделано, текущее состояние, важные факты о проекте.',
          },
          mode: {
            type: 'string',
            enum: ['replace', 'append'],
            description: 'replace — полная замена (по умолчанию), append — добавить к существующему.',
          },
        },
        required: ['content'],
      },
    },
  },
  // ── list_extensions: показать установленные расширения (MCP + skills) ──
  {
    type: 'function',
    function: {
      name: 'list_extensions',
      description: 'Показать установленные расширения: MCP-серверы (статус подключения, список тулов) и все скиллы (имя, описание, активность). Используй когда нужно узнать свои возможности.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  // ── get_skill: получить инструкции скила по имени ──
  {
    type: 'function',
    function: {
      name: 'get_skill',
      description: 'Получить полные инструкции скила по его имени (из списка list_extensions). Возвращает текст инструкций, который нужно соблюдать в работе. Используй когда видишь нужный скилл в списке и хочешь применить его инструкции.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Имя скилла (точное совпадение с именем из list_extensions)',
          },
        },
        required: ['name'],
      },
    },
  },
]

// Динамический набор тулов — добавляем по режиму
const TOOL_BY_NAME = new Map(
  TOOL_SCHEMAS.map(schema => [schema.function.name, schema]),
)

function pickTools(names: string[]) {
  return names
    .map(name => TOOL_BY_NAME.get(name))
    .filter((schema): schema is NonNullable<typeof schema> => schema !== undefined)
}

export function getToolSchemas(options: {
  planningMode?: boolean
  webMode?: boolean
  imageMode?: boolean
  multiAgentMode?: boolean
  mode?: 'code' | 'work'  // deprecated — игнорируется; work-режим удалён
  /** MCP-тулы — динамически добавляются в набор (только enabled). */
  mcpTools?: McpToolRuntime[]
} = {}) {
  const {
    planningMode = false,
    webMode = false,
    imageMode = false,
    multiAgentMode = false,
    mcpTools,
  } = options

  // Work-режим удалён — всегда полный Code-набор инструментов.
  const names: string[] = [
    'read_file',
    'read_files',
    'find_files',
    'search_code',
    'list_directory',
    'edit_file',
    'multi_edit_file',
    'write_file',
    'run_command',
    'get_diagnostics',
    'think',
    'update_working_memory',
    'revert_last_change',
    'update_todo',
    // Веб-поиск, HTTP и суб-агенты — всегда доступны агенту, модель сама решает
    // когда их использовать.
    'search_web',
    'http_request',
    'spawn_agent',
    'get_agent_status',
    'list_extensions',
    'get_skill',
  ]

  if (!planningMode) {
    names.push('analyze_project')
    names.push('get_fast_context')
  }
  if (imageMode) names.push('generate_image')
  // multiAgentMode/webMode больше не нужны для включения — оставлены как
  // параметры функции для совместимости с вызывающим кодом.
  void webMode
  void multiAgentMode

  const schemas = pickTools(names)
  if (planningMode) schemas.push(PLAN_TOOL_SCHEMA as any)

  // MCP-тулы — конвертируем в OpenAI-function-схему и аппендим.
  // Имя: mcp__{serverName}__{toolName}, описание из MCP-сервера.
  if (mcpTools && mcpTools.length > 0) {
    for (const tool of mcpTools) {
      schemas.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || `MCP-тул ${tool.shortName} с сервера ${tool.serverName}`,
          parameters: tool.inputSchema && Object.keys(tool.inputSchema).length > 0
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        },
      } as any)
    }
  }

  return schemas
}

// ── Side-chat-only tool ────────────────────────────────────────────────
// Этот тул доступен ТОЛЬКО в параллельном доп-чате (side chat). Он не
// включён в TOOL_SCHEMAS и не выдаётся обычным чатам через getToolSchemas.
// Позволяет side-агенту запросить сообщения основного чата по мере нужды
// (вместо передачи всей истории в контекст — экономия токенов).
export const GET_MAIN_CHAT_MESSAGES_SCHEMA = {
  type: 'function',
  function: {
    name: 'get_main_chat_messages',
    description: 'Получить сообщения из основного чата (параллельного этому доп-чату). Возвращает текст сообщений с указанием роли. Используй для поиска информации в истории основного чата.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Количество недавних сообщений (по умолчанию 15, максимум 50).',
        },
        search: {
          type: 'string',
          description: 'Подстрока для фильтрации сообщений (case-insensitive). Если задано, возвращаются только сообщения, содержащие эту подстроку.',
        },
      },
    },
  },
} as const
