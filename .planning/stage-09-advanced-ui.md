# СТАДИЯ 09 — ПРОДВИНУТЫЙ UI И ФИЧИ

> Цель: трекер задач, заметки, Помодоро, статистика, геймификация,
> генерация изображений, запись экрана, diff viewer, кастомные фоны.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Трекер задач: список дел в сайдбаре, Syntee добавляет из чата
- Дневник и заметки: rich text, теги, поиск
- Таймер Помодоро: 25/5 мин, уведомления, статистика
- Статистика: красивые графики (recharts)
- Геймификация: XP очки, достижения, уровень отношений с Syntee
- Автосводка дня: каждый вечер генерируется итог дня
- Генерация изображений: imagen-3-flash прямо в чате
- Запись экрана + скриншот по команде
- Diff viewer: красивое было/стало для файлов
- Быстрые команды (/макросы)
- Виджеты системного мониторинга в статусбаре
- Фоновые звуки (белый шум/дождь/кафе)
- Дополнительные темы доработаны (полночь, лес)
- Кастомные фоны главного окна

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
recharts — графики статистики
react-diff-viewer-continued — diff viewer
react-joyride — обучающий тур (заготовка)
@tiptap/react — rich text редактор для заметок
```

---

## ЗАДАЧИ

### 1. Трекер задач

```typescript
// src/core/database — таблица tasks уже создана в стадии 03

// src/renderer/components/widgets/TaskTracker/TaskTracker.tsx
// В сайдбаре: компактный список задач

interface Task {
  id: string
  title: string
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'
  priority: 0 | 1 | 2  // low, medium, high
  dueDate?: number
  sourceChatId?: string  // добавлена из чата
}

// Syntee автоматически добавляет задачи когда видит в чате:
// "нужно сделать X", "не забудь Y", "запомни задачу Z"
// Через MemoryExtractor — отдельный промпт для извлечения задач

// UI: список с чекбоксами, drag-to-reorder, приоритеты цветом
// Анимация: при завершении задачи — strikethrough + fade + confetti
```

### 2. Дневник и заметки

```tsx
// src/renderer/pages/Notes/NotesPage.tsx
// Tiptap редактор — поддерживает markdown, форматирование, code blocks

// Структура:
// - Список заметок слева (поиск, теги)
// - Редактор справа
// - Syntee может: создавать, редактировать, структурировать заметки
// - Команды: /title, /summary, /tags (AI генерирует)

// Теги: кликабельные, фильтрация по тегу
// Поиск: по содержимому (SQLite FTS5)
// Сортировка: по дате, по названию, по тегу
```

### 3. Таймер Помодоро

```tsx
// src/renderer/components/widgets/PomodoroTimer/PomodoroTimer.tsx

interface PomodoroState {
  mode: 'work' | 'short_break' | 'long_break'
  timeLeft: number  // секунды
  session: number   // номер текущей сессии
  isRunning: boolean
}

// Настройки: 25/5/15 (стандарт), настраиваемые
// Уведомление при завершении через Windows toast + TTS
// Статистика: сколько помидоров сегодня/за неделю
// Виджет: компактный, всегда виден в правом углу чата
// Интеграция с трекером задач: привязать задачу к помодоро
```

### 4. Статистика

```tsx
// src/renderer/pages/Stats/StatsPage.tsx

// Секции:
// 1. Сегодня
//    - Сообщений отправлено/получено
//    - Задач выполнено
//    - Помидоров
//    - Голосовых сессий
//    - Время использования

// 2. График активности (recharts LineChart)
//    - 7/30/90 дней
//    - Сообщения по дням как тепловая карта (как GitHub)

// 3. Самые используемые функции
//    BarChart: чат / голос / оверлей / агент / задачи

// 4. Геймификация
//    - Уровень отношений (1-100)
//    - XP прогресс бар
//    - Достижения (badges)

// 5. Инсайты от Syntee
//    - AI генерирует наблюдения о паттернах использования
```

### 5. Геймификация

```typescript
// src/core/gamification/GamificationService.ts

interface Achievement {
  id: string
  name: string
  description: string
  icon: string  // emoji или SVG
  xp: number
  condition: () => boolean
}

const achievements: Achievement[] = [
  { id: 'first_message', name: 'Первый разговор', icon: '💬', xp: 10, ... },
  { id: 'power_user', name: 'Продвинутый пользователь', description: '100 сообщений', icon: '⚡', xp: 50, ... },
  { id: 'voice_master', name: 'Мастер голоса', description: '10 голосовых сессий', icon: '🎙️', xp: 30, ... },
  { id: 'agent_unleashed', name: 'Агент на воле', description: 'Первая задача агента', icon: '🤖', xp: 25, ... },
  { id: 'night_owl', name: 'Ночная сова', description: 'Использование после полуночи', icon: '🦉', xp: 15, ... },
  { id: 'memory_keeper', name: 'Хранитель памяти', description: '50 фактов в памяти', icon: '🧠', xp: 40, ... },
]

// XP за действия:
// Отправить сообщение: +1 XP
// Голосовая команда: +2 XP
// Задача агента: +5 XP
// Выполнить задачу трекера: +3 XP
// Помодоро завершён: +5 XP

// Уровень = XP / 100, максимум 100
// Syntee комментирует повышение уровня через TTS
```

### 6. Генерация изображений

```typescript
// src/core/ai/ImageGenService.ts

export class ImageGenService {
  constructor(private ai: AIClient, private store: Store) {}

  async generate(prompt: string): Promise<string> {
    const model = this.store.get('imageModel') as string // imagen-3-flash
    
    // Используем images.generate endpoint
    const client = (this.ai as any).client
    const response = await client.images.generate({
      model,
      prompt,
      n: 1,
      size: '1024x1024',
    })
    
    // Вернуть URL или base64
    const imageUrl = response.data[0].url ?? response.data[0].b64_json
    
    // Сохранить локально
    if (response.data[0].b64_json) {
      const path = require('path')
      const { app } = require('electron')
      const { v4: uuidv4 } = require('uuid')
      const fs = require('fs')
      const outputPath = path.join(app.getPath('userData'), 'generated', `${uuidv4()}.png`)
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, Buffer.from(response.data[0].b64_json, 'base64'))
      return outputPath
    }
    
    return imageUrl
  }
}
// В чате: если AI решает что нужна картинка — вызывает инструмент generate_image
// Картинка отображается прямо в сообщении
```

### 7. Запись экрана

```typescript
// src/core/system/ScreenRecorder.ts
// Electron desktopCapturer API

export class ScreenRecorder {
  private mediaRecorder: MediaRecorder | null = null
  private chunks: Blob[] = []

  async startRecording(displayId?: string): Promise<void> {
    // В renderer процессе через IPC
  }

  stopRecording(): Promise<string> {
    // Остановить, сохранить MP4
    return Promise.resolve('')
  }
}

// IPC: renderer запрашивает источник через desktopCapturer
// Main возвращает список экранов/окон
// Renderer захватывает через MediaRecorder API
// Сохранить в AppData/recordings/
```

### 8. Diff Viewer

```tsx
// src/renderer/components/ui/DiffViewer/DiffViewer.tsx
import ReactDiffViewer from 'react-diff-viewer-continued'

// Когда агент изменяет файл:
// 1. Читает оригинал
// 2. Показывает DiffViewer: было / стало
// 3. Кнопки: "Применить" / "Отменить"

// Тема: dark для тёмных тем, light для светлых
// Отображение: unified или split (выбор)
```

### 9. Быстрые команды (макросы)

```typescript
// Хранятся в electron-store
// Формат:
interface QuickCommand {
  id: string
  trigger: string    // /погода, /summary, /code
  prompt: string     // полный промпт который отправится
  description: string
}

// Примеры:
// /погода → "Какая сегодня погода в [городе пользователя]?"
// /день → "Кратко подведи итог дня"
// /код → "Помоги с кодом который сейчас открыт в VS Code"

// В инпуте чата: начинаешь вводить / → autocomplete список команд
// В Spotlight: /команда → мгновенно выполняется
```

### 10. Кастомные фоны

```typescript
// В настройках: загрузить картинку → сохранить в AppData
// Применяется как CSS background на главное окно
// Opacity настраивается (не перекрывать контент)

// Совместимость с Liquid Glass: картинка за стеклом
// При тёмной теме: darkening overlay поверх картинки
```

---

## СТРУКТУРА ФАЙЛОВ СТАДИИ

```
src/renderer/pages/
  Tasks/TasksPage.tsx         ← новый
  Notes/NotesPage.tsx         ← новый
  Stats/StatsPage.tsx         ← новый
src/renderer/components/widgets/
  PomodoroTimer/              ← новый
  TaskTracker/                ← новый
  SystemMonitor/              ← обновить (полоски CPU/RAM)
src/renderer/components/ui/
  DiffViewer/                 ← новый
src/core/
  gamification/
    GamificationService.ts   ← новый
  ai/
    ImageGenService.ts        ← новый
  system/
    ScreenRecorder.ts         ← новый
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] Трекер задач: добавить задачу вручную и через чат
- [ ] Задача завершена → анимация и +XP
- [ ] Дневник: создать заметку, редактировать, найти по тегу
- [ ] Помодоро: запустить, уведомление через 25 мин
- [ ] Статистика: графики рисуются за последние 7 дней
- [ ] Достижение "Первый разговор" появляется после первого сообщения
- [ ] "Нарисуй кота в космосе" → картинка в чате
- [ ] Alt+S → скриншот + автоанализ
- [ ] Запись экрана: старт/стоп, файл сохранён
- [ ] Diff viewer показывается при изменении файла агентом
- [ ] /команда в инпуте → autocomplete
- [ ] Кастомный фон загружен → применился
- [ ] Фоновые звуки: дождь включается в настройках
