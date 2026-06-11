# SYNTEE HELPER — ПОЛНЫЙ ПЛАН РАЗРАБОТКИ

> Дата составления: 11 июня 2026
> Версия плана: 1.0

---

## ЧТО МЫ СТРОИМ

Syntee Helper — персональный AI-ассистент для Windows. Работает как агент:
видит экран, управляет системой, общается голосом и текстом, учится и
запоминает пользователя. Визуальный стиль — Liquid Glass (iOS 26).
Интерфейс полностью на Web (Electron + React + Vite).

---

## ТЕХНОЛОГИЧЕСКИЙ СТЕК

### Оболочка
- Electron 36 (окна, трей, горячие клавиши, IPC)
- React 18 + Vite (весь UI)
- TypeScript везде (frontend + electron main/preload)
- Framer Motion (анимации, spring physics)

### UI / Стиль
- CSS Modules + CSS переменные для тем
- Liquid Glass через backdrop-filter + кастомные CSS
- Шрифты: Inter, Plus Jakarta Sans, Geist, DM Sans (выбор в настройках)
- Иконки: Lucide React
- Компоненты: кастомные (без UI библиотек — свой дизайн)

### AI и Модели
- Провайдер: https://api.onlysq.ru/ai/openai (OpenAI-compatible)
- Чат/агент: основная модель (выбирается в настройках)
- Зрение/OCR: gemini-3.5-flash
- STT (речь в текст): gemini-3-flash
- TTS (текст в речь): gemini-3-flash
- Генерация изображений: imagen-3-flash
- Wake word (офлайн): Vosk
- Система провайдеров поиска: Tavily (основной) + резервные

### База данных
- SQLite через better-sqlite3 (история чатов, задачи, заметки, память)
- LanceDB (векторный семантический поиск по истории)
- Хранение: C:\Users\<user>\AppData\Roaming\SynteeHelper\

### Системная интеграция (Node.js)
- @nut-tree/nut-js — мышь, клавиатура
- screenshot-desktop + jimp — захват экрана
- active-win — активное окно
- Playwright — управление браузером
- node-record-lpcm16 — микрофон
- chokidar — наблюдение за файловой системой
- node-notifier — Windows уведомления

### Дополнительно
- Vosk — офлайн wake word "Синти"
- electron-builder — сборка .exe установщика
- electron-store — настройки пользователя

---

## АРХИТЕКТУРА ПРОЕКТА

```
SynteeHelper/
├── .planning/                    # Планы и документация (не в сборку)
│   ├── PLAN.md                   # Этот файл
│   ├── stage-01-foundation.md
│   ├── stage-02-chat-ui.md
│   ├── stage-03-ai-core.md
│   ├── stage-04-overlay.md
│   ├── stage-05-voice.md
│   ├── stage-06-agent-system.md
│   ├── stage-07-memory-search.md
│   ├── stage-08-integrations.md
│   ├── stage-09-advanced-ui.md
│   └── stage-10-polish-release.md
│
├── src/
│   ├── main/                     # Electron Main процесс
│   │   ├── index.ts              # Точка входа Electron
│   │   ├── windows/              # Управление окнами
│   │   │   ├── MainWindow.ts
│   │   │   ├── OverlayWindow.ts
│   │   │   ├── VoiceWindow.ts
│   │   │   └── SpotlightWindow.ts
│   │   ├── tray/                 # Трей иконка и меню
│   │   │   └── TrayManager.ts
│   │   ├── hotkeys/              # Глобальные горячие клавиши
│   │   │   └── HotkeyManager.ts
│   │   ├── ipc/                  # IPC обработчики (мост main <-> renderer)
│   │   │   ├── index.ts
│   │   │   ├── chat.ipc.ts
│   │   │   ├── agent.ipc.ts
│   │   │   ├── system.ipc.ts
│   │   │   ├── voice.ipc.ts
│   │   │   └── settings.ipc.ts
│   │   └── updater/              # Авто-обновление (будущее)
│   │
│   ├── preload/                  # Electron Preload скрипты
│   │   ├── index.ts              # Общий preload
│   │   └── api.ts                # Типизированный bridge API
│   │
│   ├── renderer/                 # React приложение (весь UI)
│   │   ├── index.html
│   │   ├── main.tsx              # Точка входа React
│   │   ├── App.tsx               # Роутинг между окнами
│   │   │
│   │   ├── pages/                # Страницы приложения
│   │   │   ├── Chat/             # Главный чат
│   │   │   ├── Overlay/          # Оверлей с выделением
│   │   │   ├── Voice/            # Голосовой режим
│   │   │   ├── Spotlight/        # Быстрый инпут
│   │   │   ├── Settings/         # Настройки (все разделы)
│   │   │   ├── Onboarding/       # Онбординг + обучение
│   │   │   ├── Tasks/            # Трекер задач
│   │   │   ├── Notes/            # Дневник и заметки
│   │   │   ├── Stats/            # Статистика использования
│   │   │   └── AgentLogs/        # Логи действий агентов
│   │   │
│   │   ├── components/           # Переиспользуемые компоненты
│   │   │   ├── ui/               # Базовые UI элементы
│   │   │   │   ├── Button/
│   │   │   │   ├── Input/
│   │   │   │   ├── Card/         # Liquid Glass карточка
│   │   │   │   ├── Modal/
│   │   │   │   ├── Toast/
│   │   │   │   ├── Tooltip/
│   │   │   │   ├── Badge/
│   │   │   │   ├── Switch/
│   │   │   │   ├── Slider/
│   │   │   │   ├── Select/
│   │   │   │   ├── Tabs/
│   │   │   │   └── ProgressBar/
│   │   │   │
│   │   │   ├── chat/             # Компоненты чата
│   │   │   │   ├── ChatMessage/
│   │   │   │   ├── ChatInput/
│   │   │   │   ├── ChatHistory/
│   │   │   │   ├── MessageActions/
│   │   │   │   ├── CodeBlock/    # Подсветка кода
│   │   │   │   ├── MarkdownRenderer/
│   │   │   │   └── TypingIndicator/
│   │   │   │
│   │   │   ├── agent/            # Компоненты агента
│   │   │   │   ├── AgentTaskCard/
│   │   │   │   ├── AgentLogPanel/
│   │   │   │   ├── AgentTabs/    # Вкладки параллельных агентов
│   │   │   │   ├── PermissionModal/ # Окно разрешений
│   │   │   │   ├── DryRunPreview/
│   │   │   │   └── AgentProgress/
│   │   │   │
│   │   │   ├── overlay/          # Компоненты оверлея
│   │   │   │   ├── SelectionCanvas/ # Рисование выделения
│   │   │   │   ├── OverlayChat/
│   │   │   │   └── OverlayResult/
│   │   │   │
│   │   │   ├── voice/            # Голосовые компоненты
│   │   │   │   ├── VoiceWave/    # Пульсирующая волна
│   │   │   │   ├── SpeakingWave/ # Волна когда говорит
│   │   │   │   └── VoiceStatus/
│   │   │   │
│   │   │   ├── layout/           # Лэйаут компоненты
│   │   │   │   ├── Sidebar/
│   │   │   │   ├── TitleBar/     # Кастомный заголовок окна
│   │   │   │   ├── StatusBar/
│   │   │   │   └── ResizeHandle/
│   │   │   │
│   │   │   └── widgets/          # Виджеты
│   │   │       ├── PomodoroTimer/
│   │   │       ├── SystemMonitor/
│   │   │       ├── ClipboardHistory/
│   │   │       └── QuickCommands/
│   │   │
│   │   ├── store/                # Zustand store (глобальное состояние)
│   │   │   ├── index.ts
│   │   │   ├── chat.store.ts
│   │   │   ├── agent.store.ts
│   │   │   ├── settings.store.ts
│   │   │   ├── voice.store.ts
│   │   │   ├── ui.store.ts
│   │   │   └── memory.store.ts
│   │   │
│   │   ├── hooks/                # React хуки
│   │   │   ├── useChat.ts
│   │   │   ├── useAgent.ts
│   │   │   ├── useVoice.ts
│   │   │   ├── useSettings.ts
│   │   │   ├── useHotkeys.ts
│   │   │   ├── useTheme.ts
│   │   │   └── useStreamingText.ts
│   │   │
│   │   ├── styles/               # Глобальные стили
│   │   │   ├── globals.css
│   │   │   ├── themes/
│   │   │   │   ├── dark.css      # Тёмная тема
│   │   │   │   ├── light.css     # Светлая тема
│   │   │   │   ├── midnight.css  # Полночь (синяя)
│   │   │   │   └── forest.css    # Лес (зелёная)
│   │   │   ├── animations.css    # Кастомные анимации
│   │   │   └── liquid-glass.css  # Liquid Glass стили
│   │   │
│   │   └── utils/                # Утилиты фронтенда
│   │       ├── cn.ts             # classnames helper
│   │       ├── format.ts
│   │       └── markdown.ts
│   │
│   ├── core/                     # Ядро приложения (Node.js сервисы)
│   │   ├── ai/                   # AI интеграция
│   │   │   ├── AIClient.ts       # Базовый клиент (OpenAI-compatible)
│   │   │   ├── ChatService.ts    # Чат с историей
│   │   │   ├── VisionService.ts  # Анализ изображений
│   │   │   ├── STTService.ts     # Speech-to-Text
│   │   │   ├── TTSService.ts     # Text-to-Speech
│   │   │   ├── ImageGenService.ts # Генерация изображений
│   │   │   └── ModelRegistry.ts  # Реестр моделей и провайдеров
│   │   │
│   │   ├── agent/                # Агентская система
│   │   │   ├── AgentOrchestrator.ts  # Главный координатор
│   │   │   ├── AgentRunner.ts        # Запуск одного агента
│   │   │   ├── AgentPool.ts          # Пул параллельных агентов
│   │   │   ├── AgentLogger.ts        # Логирование действий
│   │   │   ├── ToolRegistry.ts       # Реестр инструментов
│   │   │   ├── PermissionGuard.ts    # Проверка разрешений
│   │   │   └── tools/                # Инструменты агента
│   │   │       ├── SystemTools.ts    # Файлы, процессы
│   │   │       ├── BrowserTools.ts   # Playwright браузер
│   │   │       ├── ScreenTools.ts    # Экран, скриншоты
│   │   │       ├── InputTools.ts     # Мышь, клавиатура
│   │   │       ├── SearchTools.ts    # Поиск в интернете
│   │   │       ├── TerminalTools.ts  # Терминал, команды
│   │   │       ├── FileTools.ts      # Файловые операции
│   │   │       └── MessengerTools.ts # Telegram, Discord
│   │   │
│   │   ├── memory/               # Система памяти
│   │   │   ├── MemoryManager.ts  # Управление памятью
│   │   │   ├── VectorStore.ts    # LanceDB интеграция
│   │   │   ├── MemoryExtractor.ts # Извлечение фактов из чата
│   │   │   └── ContextBuilder.ts  # Сборка контекста для AI
│   │   │
│   │   ├── database/             # База данных
│   │   │   ├── Database.ts       # Инициализация SQLite
│   │   │   ├── migrations/       # Миграции схемы
│   │   │   ├── repositories/     # Репозитории данных
│   │   │   │   ├── ChatRepo.ts
│   │   │   │   ├── MessageRepo.ts
│   │   │   │   ├── MemoryRepo.ts
│   │   │   │   ├── TaskRepo.ts
│   │   │   │   ├── NoteRepo.ts
│   │   │   │   └── StatsRepo.ts
│   │   │   └── schema.ts         # TypeScript типы схемы
│   │   │
│   │   ├── voice/                # Голосовая система
│   │   │   ├── WakeWordDetector.ts  # Vosk офлайн wake word
│   │   │   ├── AudioCapture.ts      # Захват с микрофона
│   │   │   ├── EmotionDetector.ts   # Распознавание эмоций
│   │   │   └── VoiceSession.ts      # Управление голосовой сессией
│   │   │
│   │   ├── screen/               # Работа с экраном
│   │   │   ├── ScreenCapture.ts  # Захват экрана
│   │   │   ├── RegionSelector.ts # Выделение области
│   │   │   └── ScreenWatcher.ts  # Фоновый мониторинг экрана
│   │   │
│   │   ├── system/               # Системная интеграция
│   │   │   ├── WindowManager.ts  # Активное окно, список окон
│   │   │   ├── ProcessManager.ts # Процессы, запуск программ
│   │   │   ├── ClipboardManager.ts # Буфер обмена + история
│   │   │   ├── NotificationManager.ts # Windows уведомления
│   │   │   ├── AutostartManager.ts    # Автозапуск с Windows
│   │   │   └── SystemMonitor.ts       # CPU, RAM, диск
│   │   │
│   │   ├── integrations/         # Внешние интеграции
│   │   │   ├── telegram/
│   │   │   │   └── TelegramService.ts
│   │   │   ├── discord/
│   │   │   │   └── DiscordService.ts
│   │   │   ├── github/
│   │   │   │   └── GitHubService.ts
│   │   │   ├── spotify/
│   │   │   │   └── SpotifyService.ts
│   │   │   ├── email/
│   │   │   │   └── EmailService.ts
│   │   │   ├── vscode/
│   │   │   │   └── VSCodeService.ts
│   │   │   └── search/
│   │   │       ├── SearchRouter.ts   # Переключение провайдеров
│   │   │       ├── TavilyProvider.ts
│   │   │       ├── BraveProvider.ts
│   │   │       └── WebFetchProvider.ts
│   │   │
│   │   ├── scheduler/            # Расписание задач
│   │   │   ├── TaskScheduler.ts
│   │   │   └── ChainRunner.ts    # Цепочки задач
│   │   │
│   │   └── plugins/              # Плагинная система
│   │       ├── PluginManager.ts
│   │       ├── PluginLoader.ts
│   │       └── types.ts          # Интерфейс плагина
│   │
│   └── shared/                   # Общие типы и утилиты
│       ├── types/                # TypeScript типы
│       │   ├── chat.types.ts
│       │   ├── agent.types.ts
│       │   ├── settings.types.ts
│       │   ├── memory.types.ts
│       │   └── ipc.types.ts
│       ├── constants.ts          # Константы приложения
│       └── utils/
│           ├── logger.ts
│           └── errors.ts
│
├── assets/                       # Статические ресурсы
│   ├── icons/
│   │   ├── icon.svg              # Логотип кристалл
│   │   ├── icon-16.png
│   │   ├── icon-32.png
│   │   ├── icon-64.png
│   │   ├── icon-128.png
│   │   ├── icon-256.png
│   │   └── tray/
│   │       ├── tray-idle.ico
│   │       ├── tray-listening.ico
│   │       └── tray-active.ico
│   ├── sounds/                   # UI звуки
│   │   ├── send.mp3
│   │   ├── receive.mp3
│   │   ├── wake.mp3
│   │   └── notification.mp3
│   └── models/                   # Vosk модель wake word
│       └── vosk-model-small-ru/
│
├── plugins/                      # Встроенные плагины
│   ├── weather/
│   ├── pomodoro/
│   └── file-search/
│
├── scripts/                      # Build и dev скрипты
│   ├── build.ts
│   ├── dev.ts
│   └── package-installer.ts
│
├── electron.vite.config.ts       # electron-vite конфиг
├── electron-builder.yml          # Сборка установщика
├── tsconfig.json
├── tsconfig.node.json
├── package.json
└── .env.example
```

---

## СТАДИИ РАЗРАБОТКИ (10 стадий, Вариант B)

| # | Название | Что готово после | Примерно |
|---|----------|-----------------|---------|
| 01 | Фундамент | Electron запускается, окна, трей, хоткеи, пустой UI | 1-2 дня |
| 02 | Чат UI | Полноценный красивый чат с анимациями, темами, сайдбаром | 3-5 дней |
| 03 | AI ядро | Реальный чат с AI, стриминг, история в БД, память | 3-4 дня |
| 04 | Оверлей | Circle-to-Search, выделение, popup с чатом | 3-4 дня |
| 05 | Голос | Wake word, STT, TTS, голосовой режим | 3-4 дня |
| 06 | Агент | Системные действия, браузер, файлы, разрешения | 5-7 дней |
| 07 | Память и поиск | Семантический поиск, память о пользователе, контекст | 3-4 дня |
| 08 | Интеграции | Telegram, Discord, GitHub, Spotify, Email, поиск | 5-7 дней |
| 09 | Продвинутый UI | Задачи, заметки, статистика, геймификация, виджеты | 4-5 дней |
| 10 | Полировка | Онбординг, установщик .exe, баги, оптимизация | 3-4 дня |

---

## КЛЮЧЕВЫЕ РЕШЕНИЯ

### Почему LanceDB а не ChromaDB
ChromaDB требует Python. LanceDB имеет нативные Node.js биндинги —
всё остаётся в TypeScript без дополнительных процессов.

### Почему один процесс а не Python sidecar
Пользователь хочет один язык. Все системные задачи решаются через
Node.js библиотеки. Если что-то не получится — добавим Python
микросервис только для конкретной задачи.

### Почему Vosk для wake word
Полностью офлайн, бесплатно, не требует регистрации. Точность
достаточная для слова "Синти". Porcupine точнее но платный.

### Архитектура IPC
Renderer (React) никогда не вызывает Node.js напрямую.
Всё через типизированный IPC bridge в preload/api.ts.
Это безопасно и позволяет легко тестировать.

### Агентская система
Каждый агент — отдельный AgentRunner с собственным контекстом.
AgentOrchestrator управляет пулом. PermissionGuard проверяет
каждое действие перед выполнением. Все действия логируются.

---

## НАСТРОЙКИ — ПОЛНЫЙ СПИСОК РАЗДЕЛОВ

### Общие
- Тема (тёмная / светлая / авто по времени / полночь / лес)
- Акцентный цвет (цветопикер)
- Кастомный фон (загрузить картинку)
- Анимированный фон (вкл/выкл)
- Язык интерфейса (русский / английский)
- Запуск с Windows
- Поведение при закрытии (в трей)
- Время смены тем (рассвет/закат для авто)

### ИИ и Модели
- API провайдер + ключ + endpoint
- Основная модель чата
- Модель для зрения (gemini-3.5-flash)
- Модель STT (gemini-3-flash)
- Модель TTS (gemini-3-flash)
- Модель генерации изображений (imagen-3-flash)
- Температура (0.0 - 2.0)
- Максимум токенов
- Системный промпт (кастомизация)
- Стиль ответов (краткий / средний / развёрнутый)

### Голос
- Голос TTS (женский по умолчанию)
- Скорость речи
- Громкость
- Wake word (по умолчанию "Синти")
- Чувствительность микрофона
- Язык распознавания

### Горячие клавиши
- Открыть/скрыть главное окно (Ctrl+Shift+Space)
- Оверлей выделения (Ctrl+Shift+S)
- Голосовой режим (Ctrl+Shift+V)
- Spotlight строка (Ctrl+Space)
- Быстрый вопрос (Alt+Q)
- Читать выделенное (Alt+R)
- Перевести выделенное (Alt+T)

### Агент и Безопасность
- Уровень автономности (спрашивать всегда / только опасное / никогда)
- Dry Run режим (вкл/выкл)
- Список запрещённых папок
- Список запрещённых программ
- Разрешения: файлы, браузер, терминал, мессенджеры
- Шифрование БД (вкл/выкл)
- PIN на запуск

### Память и Данные
- Просмотр памяти по категориям (личное, работа, предпочтения, проекты)
- Очистить память
- Очистить историю чатов
- Экспорт истории (JSON / PDF / Markdown / TXT)
- Автобэкап (вкл/выкл, папка, частота)
- Размер занятого места

### Интеграции
- Telegram (токен бота, chat_id)
- Discord (токен, сервер)
- GitHub (Personal Access Token)
- Spotify (Client ID/Secret, OAuth)
- Email (Gmail/Outlook OAuth)
- VS Code (расширение или прямой доступ)
- Поиск: Tavily ключ + резервные провайдеры (Brave, DuckDuckGo)
- Браузер по умолчанию (автоопределение через Playwright)

### Уведомления
- Уведомления Windows (вкл/выкл)
- Звук уведомлений (системный / кастомный / без звука)
- Уведомления от агента
- Уведомления по расписанию

### Внешний вид
- Шрифт (Inter / Plus Jakarta Sans / Geist / DM Sans)
- Размер шрифта
- Прозрачность Liquid Glass (слабая / средняя / сильная)
- Прозрачность оверлея
- Позиция popup оверлея
- Звуковые эффекты UI (вкл/выкл)
- Фоновые звуки (белый шум / дождь / кафе / выкл)

---

## ОНБОРДИНГ — 10 ШАГОВ

1. Приветствие — анимация логотипа кристалл, "Привет, я Syntee"
2. Имя — "Как тебя зовут?" → обращение по имени
3. API ключ — ввод + живой тест запроса с анимацией
4. Выбор модели — список с описанием, рекомендованные отмечены
5. Голос — выбор голоса + кнопка "послушать пример"
6. Микрофон — визуализация уровня звука + тест wake word "Синти"
7. Горячие клавиши — показывает дефолтные, можно изменить
8. Разрешения агента — что делает без спроса, что спрашивает
9. Обучающий тур — стрелочки по интерфейсу
10. Готово — "Всё готово. Чем могу помочь, [имя]?"

---

## ГОРЯЧИЕ КЛАВИШИ (дефолт)

| Действие | Хоткей |
|----------|--------|
| Главное окно | Ctrl+Shift+Space |
| Оверлей выделения | Ctrl+Shift+S |
| Голосовой режим | Ctrl+Shift+V |
| Spotlight строка | Ctrl+Space |
| Быстрый вопрос | Alt+Q |
| Читать выделенное вслух | Alt+R |
| Перевести выделенное | Alt+T |
| Скриншот + анализ | Alt+S |

---

## МОДЕЛИ ПО УМОЛЧАНИЮ

| Задача | Модель |
|--------|--------|
| Основной чат | gpt-4o (меняется в настройках) |
| Зрение / OCR | gemini-3.5-flash |
| STT | gemini-3-flash |
| TTS | gemini-3-flash |
| Генерация изображений | imagen-3-flash |
| Wake word | Vosk (офлайн) |

---

## ТЕМЫ

| Тема | Фон | Описание |
|------|-----|----------|
| Тёмная | #1a1a1a | Нейтральный тёмный |
| Светлая | тёплый белый | Кремовый оттенок |
| Полночь | тёмно-синий | Ночная атмосфера |
| Лес | тёмно-зелёный | Природная тема |

Акцент: белый по умолчанию, меняется в настройках.
Текст тёмная: кремовый (#f5f0e8).
Текст светлая: чёрный (#000000).
Скругления: мягкие (12-16px).

---

## ПРОВАЙДЕРЫ ПОИСКА

| Провайдер | Приоритет | Описание |
|-----------|-----------|----------|
| Tavily | 1 (основной) | AI-оптимизированный поиск |
| Brave Search | 2 (резерв) | 2000 запросов/мес бесплатно |
| Web Fetch | 3 (резерв) | Прямой fetch URL |
| DuckDuckGo | 4 (резерв) | Scraping fallback |

---

## ФИЧИ ПО СТАДИЯМ (сводная таблица)

| Фича | Стадия |
|------|--------|
| Electron shell, окна, трей | 01 |
| Горячие клавиши глобальные | 01 |
| Liquid Glass UI, темы, анимации | 02 |
| Чат интерфейс (сайдбар, история) | 02 |
| Markdown, подсветка кода | 02 |
| Spotlight строка | 02 |
| AI чат со стримингом | 03 |
| SQLite история чатов | 03 |
| Память о пользователе | 03 |
| Умные подсказки при вводе | 03 |
| Оверлей выделения экрана | 04 |
| Circle-to-Search (анализ области) | 04 |
| Popup чат в оверлее | 04 |
| Перевод выделенного текста | 04 |
| Читать выделенное вслух | 04 |
| Wake word "Синти" (Vosk) | 05 |
| STT (gemini-3-flash) | 05 |
| TTS (gemini-3-flash) | 05 |
| Голосовой оверлей (волна) | 05 |
| Распознавание эмоций | 05 |
| Агент: файлы, терминал | 06 |
| Агент: мышь, клавиатура | 06 |
| Агент: браузер (Playwright) | 06 |
| Система разрешений | 06 |
| Dry Run режим | 06 |
| Откат действий | 06 |
| Параллельные агенты (вкладки) | 06 |
| Мультиагентность | 06 |
| Агент-наблюдатель | 06 |
| LanceDB семантический поиск | 07 |
| Векторная память | 07 |
| Контекст буфера обмена | 07 |
| Захват экрана в фоне | 07 |
| Контекст активного окна | 07 |
| Telegram интеграция | 08 |
| Discord интеграция | 08 |
| GitHub интеграция | 08 |
| Spotify интеграция | 08 |
| Email интеграция | 08 |
| VS Code интеграция | 08 |
| Поиск (Tavily + резерв) | 08 |
| Расписание задач | 08 |
| Цепочки задач | 08 |
| Трекер задач | 09 |
| Дневник и заметки | 09 |
| Таймер Помодоро | 09 |
| Статистика + графики | 09 |
| Геймификация (очки, уровни) | 09 |
| Автосводка дня | 09 |
| Генерация изображений | 09 |
| Запись экрана | 09 |
| Diff viewer | 09 |
| Онбординг (10 шагов) | 10 |
| Обучающий тур | 10 |
| Установщик .exe | 10 |
| Системный мониторинг | 10 |
| Автобэкап | 10 |
| Режим инкогнито | 10 |
