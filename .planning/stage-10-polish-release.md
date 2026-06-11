# СТАДИЯ 10 — ПОЛИРОВКА И РЕЛИЗ

> Цель: всё работает стабильно. Онбординг, установщик .exe, оптимизация,
> шифрование, PIN, автобэкап, логи, обработка ошибок.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Онбординг 10 шагов — красивый, анимированный
- Обучающий тур по интерфейсу (стрелочки)
- Установщик .exe (electron-builder NSIS, Program Files)
- Автоматическое создание AppData при первом запуске
- Vosk модель в установщике
- PIN на запуск (опционально)
- Шифрование SQLite (опционально)
- Режим инкогнито полная изоляция
- Автобэкап: ежедневно, хранит 7 копий
- Логи приложения (electron-log) с ротацией
- Оптимизация: lazy loading, виртуализация списков
- Error boundary в React, красивые страницы ошибок
- README.md с инструкцией запуска
- .env.example с описанием всех переменных

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
electron-builder — сборка .exe
electron-log — логирование
react-joyride — обучающий тур
@vavt/react-virtual — виртуализация длинных списков
```

---

## ЗАДАЧИ

### 1. Онбординг — 10 шагов

```tsx
// src/renderer/pages/Onboarding/OnboardingPage.tsx

// Общая структура:
// - Полноэкранный overlay поверх пустого окна
// - Прогресс индикатор вверху (10 точек)
// - Анимации: каждый шаг slide-in с spring

const STEPS = [
  {
    id: 'welcome',
    component: WelcomeStep,
    // Большой кристалл анимируется: вращается, пульсирует
    // Текст: "Привет. Я Syntee."
    // Подтекст: "Твой персональный AI-ассистент"
    // Кнопка: "Познакомимся" → шаг 2
  },
  {
    id: 'name',
    component: NameStep,
    // "Как тебя зовут?"
    // Большой input по центру
    // После ввода: "Привет, [имя]! Рад познакомиться."
  },
  {
    id: 'api_key',
    component: ApiKeyStep,
    // Поле ввода API ключа
    // Кнопка "Проверить" → анимация загрузки → "✓ Подключено!"
    // При ошибке: красная анимация + объяснение
  },
  {
    id: 'model',
    component: ModelStep,
    // Список моделей с описанием
    // Рекомендованная отмечена звёздочкой
    // Превью: "Напишу что-то умное..." → стриминг примера
  },
  {
    id: 'voice',
    component: VoiceStep,
    // Список голосов (женский/мужской/нейтральный)
    // Кнопка "Послушать" → TTS воспроизводит пример
  },
  {
    id: 'microphone',
    component: MicrophoneStep,
    // Визуализация уровня звука (полоска)
    // "Скажи 'Синти' для теста"
    // При срабатывании: анимация успеха
  },
  {
    id: 'hotkeys',
    component: HotkeysStep,
    // Показывает карточки со всеми хоткеями
    // Каждый хоткей можно перезаписать кликом
    // Анимация: карточки появляются одна за одной
  },
  {
    id: 'permissions',
    component: PermissionsStep,
    // Тогл-список разрешений агента
    // Объяснение каждого с иконкой
    // Рекомендованный режим уже выбран
  },
  {
    id: 'tour',
    component: TourStep,
    // "Покажу как это работает"
    // Кнопка "Начать тур" → запускает react-joyride
    // Кнопка "Пропустить" → сразу к финалу
  },
  {
    id: 'ready',
    component: ReadyStep,
    // Конфетти анимация
    // "Всё готово, [имя]! Чем могу помочь?"
    // Кнопка "Начать" → закрывает онбординг
    // После: первое сообщение от Syntee приветствует
  },
]
```

### 2. Обучающий тур (react-joyride)

```tsx
// src/renderer/components/Onboarding/Tour.tsx
import Joyride, { Step } from 'react-joyride'

const tourSteps: Step[] = [
  {
    target: '.sidebar',
    content: 'Здесь твоя история чатов. Создавай новые разговоры одним кликом.',
    placement: 'right',
  },
  {
    target: '.chat-input',
    content: 'Пиши сюда или нажми микрофон для голосового ввода.',
    placement: 'top',
  },
  {
    target: '.tray-icon-demo',
    content: 'Я живу в трее. Нажми Ctrl+Shift+Space чтобы открыть.',
    placement: 'bottom',
  },
  {
    target: '.overlay-hint',
    content: 'Нажми Ctrl+Shift+S чтобы выделить область экрана и спросить меня о ней.',
    placement: 'bottom',
  },
  {
    target: '.settings-btn',
    content: 'Все настройки здесь. Темы, горячие клавиши, интеграции и многое другое.',
    placement: 'left',
  },
]

// Кастомный стиль тултипов: Liquid Glass
// Стрелка: акцентный цвет
// Кнопки: такие же как в основном UI
```

### 3. Первый запуск — инициализация

```typescript
// src/main/index.ts

async function onFirstRun(): Promise<void> {
  const { app } = require('electron')
  const path = require('path')
  const fs = require('fs')

  // Создать папки AppData
  const appData = app.getPath('userData')
  const dirs = [
    path.join(appData, 'generated'),    // изображения
    path.join(appData, 'recordings'),    // записи экрана
    path.join(appData, 'backups'),       // бэкапы БД
    path.join(appData, 'voices'),        // кэш TTS
    path.join(appData, 'screenshots'),   // скриншоты агента
  ]
  dirs.forEach(d => fs.mkdirSync(d, { recursive: true }))

  // Инициализировать БД
  initDatabase()

  // Проверить Vosk модель
  const modelPath = path.join(process.resourcesPath, 'models/vosk-model-small-ru')
  if (!fs.existsSync(modelPath)) {
    // Показать сообщение о недостающей модели
    log.warn('Vosk model not found, wake word disabled')
  }

  // Пометить первый запуск
  store.set('firstRunComplete', true)
  store.set('firstRunDate', Date.now())
}
```

### 4. electron-builder.yml финальный

```yaml
appId: com.synteehelper.app
productName: Syntee Helper
copyright: Copyright © 2026

directories:
  output: release
  buildResources: assets

files:
  - dist/**/*
  - assets/models/**/*
  - assets/sounds/**/*
  - "!assets/icons/source/**"

extraResources:
  - from: assets/models/vosk-model-small-ru
    to: models/vosk-model-small-ru

win:
  target:
    - target: nsis
      arch: [x64]
  icon: assets/icons/icon.ico
  requestedExecutionLevel: asUser
  artifactName: "SynteeHelper-Setup-${version}.exe"

nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: false
  installerIcon: assets/icons/icon.ico
  uninstallerIcon: assets/icons/icon.ico
  installerHeader: assets/icons/installer-header.bmp
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: "Syntee Helper"
  include: assets/installer.nsh  # кастомные страницы установщика

publish: null  # без автообновления пока
```

### 5. AutoBackup.ts

```typescript
// src/core/system/AutoBackup.ts
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

export class AutoBackup {
  private interval: NodeJS.Timeout | null = null

  constructor(private dbPath: string) {}

  start(intervalMs = 24 * 60 * 60 * 1000): void { // раз в сутки
    this.backup() // сразу при запуске
    this.interval = setInterval(() => this.backup(), intervalMs)
  }

  backup(): void {
    const backupDir = path.join(app.getPath('userData'), 'backups')
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0]
    const backupPath = path.join(backupDir, `syntee-${timestamp}.db`)

    try {
      fs.copyFileSync(this.dbPath, backupPath)
      this.rotateBackups(backupDir, 7) // хранить 7 последних
    } catch (err) {
      console.error('Backup failed:', err)
    }
  }

  private rotateBackups(dir: string, keep: number): void {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('syntee-') && f.endsWith('.db'))
      .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtime.getTime() }))
      .sort((a, b) => b.time - a.time)

    files.slice(keep).forEach(f => {
      fs.unlinkSync(path.join(dir, f.name))
    })
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
```

### 6. PIN защита

```tsx
// src/renderer/pages/PinLock/PinLockPage.tsx
// Показывается при запуске если PIN включён в настройках

// 4-значный PIN
// 3 попытки, потом блокировка на 1 минуту
// Анимация встряхивания при неверном PIN
// Хранение: хэш PIN в electron-store (bcrypt)
```

### 7. Оптимизация производительности

```typescript
// 1. Виртуализация длинных списков сообщений
// src/renderer/components/chat/ChatHistory/VirtualizedMessages.tsx
// react-virtual или @tanstack/react-virtual

// 2. Lazy loading страниц
// src/renderer/App.tsx
const SettingsPage = lazy(() => import('./pages/Settings/SettingsPage'))
const StatsPage = lazy(() => import('./pages/Stats/StatsPage'))
const NotesPage = lazy(() => import('./pages/Notes/NotesPage'))

// 3. Throttle скриншотов в голосовом режиме
// 4. Debounce на поиск и автодополнение
// 5. Мемоизация тяжёлых компонентов через useMemo/useCallback
// 6. Отключение анимаций при prefers-reduced-motion
```

### 8. Error Boundary

```tsx
// src/renderer/components/ui/ErrorBoundary/ErrorBoundary.tsx
import { Component, ErrorInfo } from 'react'

export class ErrorBoundary extends Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Логировать в electron-log через IPC
    window.syntee.system.logError(error.message, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-page glass">
          <div className="error-crystal">💎</div>
          <h2>Что-то пошло не так</h2>
          <p>Syntee словил баг. Перезагружаем...</p>
          <button onClick={() => window.location.reload()}>
            Перезагрузить
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
```

### 9. README.md и документация

```markdown
# Syntee Helper

Персональный AI-ассистент для Windows с поддержкой голоса, агентов и Circle-to-Search.

## Быстрый старт

1. Установить SynteeHelper-Setup-x.x.x.exe
2. При первом запуске пройти онбординг
3. Ввести API ключ (https://api.onlysq.ru)

## Разработка

\`\`\`bash
cd C:\Projects\SynteeHelper
npm install
npm run dev
\`\`\`

## Сборка

\`\`\`bash
npm run build
npm run dist
\`\`\`

## Горячие клавиши

| Действие | Хоткей |
|----------|--------|
| Главное окно | Ctrl+Shift+Space |
| Оверлей | Ctrl+Shift+S |
| Голос | Ctrl+Shift+V |
| Spotlight | Ctrl+Space |
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/renderer/pages/
  Onboarding/
    OnboardingPage.tsx       ← новый
    steps/
      WelcomeStep.tsx
      NameStep.tsx
      ApiKeyStep.tsx
      ModelStep.tsx
      VoiceStep.tsx
      MicrophoneStep.tsx
      HotkeysStep.tsx
      PermissionsStep.tsx
      TourStep.tsx
      ReadyStep.tsx
  PinLock/
    PinLockPage.tsx          ← новый
src/renderer/components/
  Onboarding/
    Tour.tsx                 ← новый
  ui/
    ErrorBoundary/           ← новый
src/core/system/
  AutoBackup.ts              ← новый
electron-builder.yml         ← финализировать
README.md                    ← новый
.env.example                 ← новый
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] npm run dist создаёт SynteeHelper-Setup.exe без ошибок
- [ ] Установка в Program Files работает
- [ ] После установки: создана иконка на рабочем столе
- [ ] Первый запуск: онбординг открывается автоматически
- [ ] Все 10 шагов онбординга работают
- [ ] Обучающий тур проходится от начала до конца
- [ ] Пропуск онбординга → возврат через настройки
- [ ] PIN включён → при запуске появляется экран ввода
- [ ] Неверный PIN 3 раза → блокировка 1 минуту
- [ ] Автобэкап: файл создаётся в AppData/backups/
- [ ] Старые бэкапы удаляются (больше 7 не хранится)
- [ ] electron-log: логи пишутся в AppData/logs/
- [ ] Error boundary: при ошибке компонента → красивая страница
- [ ] Виртуализация: 1000 сообщений в чате — нет лагов
- [ ] Lazy loading: настройки загружаются только при открытии
- [ ] Всё работает на 2 мониторах
- [ ] TypeScript: tsc --noEmit без ошибок
- [ ] npm audit: критических уязвимостей нет
