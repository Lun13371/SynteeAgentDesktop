// ── Plugins (локальные расширения приложения) ───────────────────────────
//
// Плагин — папка с plugin.json (манифест) + JS-базой (main) и опционально
// UI-частью. В отличие от MCP (внешний процесс с тулами) и Skills
// (markdown-инструкции), плагин — это код, исполняемый в изолированном
// utilityProcess внутри приложения, с доступом к host-API:
// registerTool / registerCommand / registerUi / хуки / KV-storage.
//
// Именование тулов плагина: plugin__{pluginId}__{toolName}.

/** Права плагина. Каждое гейтит соответствующую область host-API. */
export type PluginPermission =
  | 'net'            // исходящие HTTP-запросы (host fetch)
  | 'fs:read'        // чтение файлов (любые пути)
  | 'fs:write'       // запись файлов (только внутри папки плагина)
  | 'clipboard'      // буфер обмена
  | 'notifications'  // showNotification
  | 'ui'             // registerUi/registerPanel (кнопки/панели/табы в приложении)
  | 'chat'           // chat.send / chat.reply (действия в чате от имени плагина)
  | 'chats:read'     // чтение списка чатов и их сообщений
  | 'projects:read'  // чтение списка проектов
  | 'memory'         // поиск/сохранение в долгосрочную память приложения

/** Поле настроек плагина — декларативная схема в манифесте,
 *  автоматически рендерится формой в карточке плагина. */
export interface PluginConfigField {
  key: string
  label: string
  type: 'string' | 'password' | 'number' | 'boolean'
  default?: string | number | boolean
  placeholder?: string
  description?: string
}

/** Манифест плагина — plugin.json в корне папки плагина. */
export interface PluginManifest {
  /** Уникальный id (slug). Должен совпадать с именем папки. */
  id: string
  /** Отображаемое имя. */
  name: string
  version: string
  author?: string
  /** Короткое описание для списка в UI. */
  description?: string
  /**
   * Короткое описание для system prompt (~200 символов) — AI видит
   * включённые плагины и понимает, зачем они и какие тулы дают.
   */
  promptDescription?: string
  /** Entry point основной логики (относительный путь, CJS). */
  main: string
  /** HTML-файл кастомного UI (рендерится в sandboxed iframe через
   *  syntee-plugin://{id}/... протокол). Относительный путь. */
  ui?: string
  /** Относительный путь до полного описания (markdown) для карточки UI. */
  readme?: string
  /** Права, запрашиваемые плагином. */
  permissions?: PluginPermission[]
  /** Схема настроек — форма в карточке плагина, значения через syntee.config. */
  config?: PluginConfigField[]
  /**
   * События активации (пока информационные; onLoad — дефолт).
   * Задел на будущее: 'onLoad' | 'chat:message' | 'command:<name>'.
   */
  activation?: string[]
}

/** Загруженный плагин (манифест + метаданные расположения). */
export interface Plugin {
  /** = manifest.id. */
  id: string
  manifest: PluginManifest
  /** Абсолютный путь до папки плагина. */
  dir: string
  /** 'global' ({userData}/plugins) или 'project' ({workdir}/.syntee/plugins). */
  source: 'global' | 'project'
  /** Для проектных — id проекта. */
  projectId?: string
  /** Полное описание (readme.md), прочитанное loader-ом (для карточки UI). */
  readmeContent?: string
}

/** Per-plugin состояние (включён + область применения), в electron-store. */
export interface PluginState {
  enabled: boolean
  scope: import('./mcp').ExtensionScope
  /** Пользователь подтвердил права плагина (consent-диалог при первом
   *  включении). Без consent плагин с permissions не включается. */
  consented?: boolean
}

/** Статус процесса плагина. */
export type PluginStatus = 'stopped' | 'starting' | 'running' | 'error'

/** Запись журнала плагина (кольцевой буфер в main). */
export interface PluginLogEntry {
  /** Unix ms. */
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/** Runtime-тул плагина — регистрируется плагином, агрегируется менеджером. */
export interface PluginToolRuntime {
  pluginId: string
  /** Полное имя тула: plugin__{pluginId}__{toolName}. */
  name: string
  /** Короткое имя (без префикса). */
  shortName: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Слэш-команда плагина (registerCommand). */
export interface PluginCommandRuntime {
  pluginId: string
  /** Имя без слэша: 'weather' → команда /weather. */
  name: string
  description: string
  icon?: string
}

/** UI-вклад плагина (registerUi/registerPanel) — кнопка/панель/таб в слоте. */
export interface PluginUiContribution {
  pluginId: string
  /** Слот: 'sidebar' — низ сайдбара; 'right' — таб правой панели; 'modal' — модальная панель. */
  slot: 'sidebar' | 'right' | 'modal'
  /** 'button' — выполняет command плагина; 'panel' — открывает iframe-панель/таб. */
  type: 'button' | 'panel'
  label: string
  icon?: string
  /** Для type='button' — имя команды плагина (без слэша). */
  command?: string
  /** Уникальный id панели (для right/modal: openPanel/closePanel/setBadge). */
  panelId?: string
  /** HTML-файл панели (относительный путь; по умолчанию — manifest.ui). */
  entry?: string
}

/** Информация о теме для UI плагина (ui.getTheme / событие theme:changed). */
export interface PluginThemeInfo {
  /** Имя темы ('dark', 'light', 'nord', ...). */
  theme: string
  /** Акцентный цвет (#rrggbb). */
  accentColor: string
  /** true для тёмных тем. */
  dark: boolean
}

/** Маркер инлайн-виджета: тул плагина возвращает JSON этого вида —
 *  renderer рендерит iframe-карточку вместо текста. */
export interface PluginUiWidgetPayload {
  __plugin_ui__: true
  pluginId: string
  /** HTML-файл виджета (относительный путь в папке плагина). */
  entry: string
  /** Данные, которые получит виджет при загрузке (postMessage). */
  data?: unknown
  /** Высота карточки в px (по умолчанию 260). */
  height?: number
}

/** Полное состояние плагина для UI. */
export interface PluginRuntime extends Plugin {
  state: PluginState
  status: PluginStatus
  error?: string
  tools: PluginToolRuntime[]
  commands: PluginCommandRuntime[]
  ui: PluginUiContribution[]
  /** Текущие значения настроек (config из манифеста + сохранённые). */
  configValues: Record<string, unknown>
  logs: PluginLogEntry[]
}

/** Компактная инфа о плагине для system prompt. */
export interface PluginPromptInfo {
  id: string
  name: string
  promptDescription?: string
  tools: string[]
}
