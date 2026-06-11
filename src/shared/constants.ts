export const APP_NAME = 'Syntee Helper'
export const APP_VERSION = '0.1.0'

export const DEFAULT_HOTKEYS = {
  mainWindow: 'CommandOrControl+Shift+Space',
  overlay: 'CommandOrControl+Shift+S',
  voice: 'CommandOrControl+Shift+V',
  spotlight: 'CommandOrControl+Space',
  quickQuestion: 'Alt+Q',
  readAloud: 'Alt+R',
  translate: 'Alt+T',
  screenshot: 'Alt+S',
}

export const DEFAULT_SETTINGS = {
  theme: 'dark' as const,
  accentColor: '#ffffff',
  language: 'ru',
  fontFamily: 'Inter',
  fontSize: 'medium',
  glassOpacity: 'medium',
  animatedBackground: true,
  sounds: true,
  autostart: false,
  onboardingCompleted: false,
  userName: '',
  apiKey: '',
  apiEndpoint: 'https://api.onlysq.ru/ai/openai',
  mainModel: 'claude-sonnet-4-6',
  fastModel: 'claude-haiku-4-5',
  visionModel: 'gemini-3.5-flash',
  sttModel: 'gemini-3-flash',
  ttsModel: 'gemini-3-flash',
  embeddingModel: 'gemini-embedding-2',
  memoryModel: 'claude-haiku-4-5',
  imageModel: 'imagen-3-flash',
  watcherModel: 'gemini-3-flash',
  summaryModel: 'gpt-5.2',
  routerModel: 'nano-banana',
  emotionModel: 'gpt-5-mini',
  voiceId: 'alloy',
  wakeWord: 'синти',
  themeSchedule: { enabled: false, lightFrom: '08:00', darkFrom: '20:00' },
  agentPermissions: {
    confirmDangerous: true,
    dryRunMode: false,
    forbiddenPaths: ['C:\\Windows', 'C:\\Program Files\\SynteeHelper'],
  },
  backupEnabled: true,
  backupPath: '',
  hotkeys: DEFAULT_HOTKEYS,
  integrations: {
    telegram: { token: '', chatId: '' },
    discord: { token: '', guildId: '' },
    github: { token: '' },
    spotify: { clientId: '', clientSecret: '' },
    tavily: { key: '' },
    brave: { key: '' },
  },
}

export const WINDOW_SIZES = {
  main: { width: 1200, height: 800 },
  spotlight: { width: 600, height: 80 },
  spotlightExpanded: { width: 600, height: 420 },
  voice: { width: 300, height: 300 },
  overlayChat: { width: 400, height: 600 },
}

export const IPC_EVENTS = {
  CHAT_STREAM_TOKEN: 'chat:stream:token',
  CHAT_STREAM_DONE: 'chat:stream:done',
  CHAT_STREAM_ERROR: 'chat:stream:error',
  MEMORY_MEMORIZED: 'memory:memorized',
  AGENT_ACTION: 'agent:action',
  AGENT_PERMISSION_REQUEST: 'agent:permission:request',
  SYSTEM_STATS: 'system:stats',
  RATE_LIMIT: 'ai:rate_limit',
  VOICE_STATE: 'voice:state',
  WATCHER_NOTIFICATION: 'watcher:notification',
  SCHEDULER_TASK_DONE: 'scheduler:task_done',
  TRAY_ANIMATE: 'tray:animate',
}
