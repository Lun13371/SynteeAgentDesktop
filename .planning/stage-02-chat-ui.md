# СТАДИЯ 02 — ЧАТ UI

> Цель: полноценный красивый интерфейс чата. После этой стадии Syntee
> выглядит как готовый продукт визуально — темы, анимации, Liquid Glass,
> сайдбар, Spotlight. AI пока заглушка (echo-ответы).

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Главное окно с полноценным UI (сайдбар + чат)
- Liquid Glass стиль везде внутри
- 4 темы: тёмная, светлая, полночь, лес
- Все анимации (Framer Motion): bounce кнопки, fade сообщений, spring переходы
- Анимированный фон (частицы / волны)
- Сайдбар 250px с историей чатов (моковые данные)
- Поле ввода с умными подсказками (заглушка)
- Markdown рендер с подсветкой кода
- Spotlight строка — красивая, по центру
- Кастомный Titlebar
- Переключение тем работает
- Drag & Drop файлов в чат работает (показывает превью)

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
framer-motion
zustand
react-markdown
react-syntax-highlighter
@radix-ui/react-tooltip
@radix-ui/react-dropdown-menu
lucide-react
```

---

## ЗАДАЧИ

### 1. Liquid Glass CSS система

```css
/* src/renderer/styles/liquid-glass.css */

:root {
  --glass-bg: rgba(255, 255, 255, 0.08);
  --glass-border: rgba(255, 255, 255, 0.12);
  --glass-blur: 20px;
  --glass-saturate: 180%;
  --glass-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.glass {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: 1px solid var(--glass-border);
  box-shadow: var(--glass-shadow);
}

.glass-strong {
  --glass-bg: rgba(255, 255, 255, 0.15);
  --glass-blur: 40px;
}

/* Эффект преломления (pseudo-element) */
.glass::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(255,255,255,0.1) 0%,
    transparent 50%,
    rgba(255,255,255,0.05) 100%
  );
  border-radius: inherit;
  pointer-events: none;
}
```

### 2. Система тем

```css
/* src/renderer/styles/themes/dark.css */
[data-theme="dark"] {
  --bg-primary: #1a1a1a;
  --bg-secondary: #242424;
  --text-primary: #f5f0e8;
  --text-secondary: #a0a0a0;
  --accent: #ffffff;
  --accent-hover: rgba(255,255,255,0.8);
  --border: rgba(255,255,255,0.1);
  --sidebar-bg: #141414;
}

/* src/renderer/styles/themes/light.css */
[data-theme="light"] {
  --bg-primary: #faf8f5;
  --bg-secondary: #f0ede8;
  --text-primary: #000000;
  --text-secondary: #666666;
  --accent: #000000;
  --glass-bg: rgba(0,0,0,0.05);
  --glass-border: rgba(0,0,0,0.08);
  --sidebar-bg: #f0ede8;
}

/* src/renderer/styles/themes/midnight.css */
[data-theme="midnight"] {
  --bg-primary: #0a0e1a;
  --bg-secondary: #0f1525;
  --text-primary: #e0e8ff;
  --accent: #4d9fff;
  --sidebar-bg: #080c16;
}

/* src/renderer/styles/themes/forest.css */
[data-theme="forest"] {
  --bg-primary: #0d1a0f;
  --bg-secondary: #122014;
  --text-primary: #d4f0d8;
  --accent: #4caf60;
  --sidebar-bg: #0a150c;
}
```

### 3. Анимированный фон

```tsx
// src/renderer/components/ui/AnimatedBackground/AnimatedBackground.tsx
// Три варианта (переключаются в настройках):

// 1. Частицы — маленькие точки плавают
// 2. Волны — медленные синусоидальные волны снизу
// 3. Сетка — тонкая сетка с пульсацией

// Реализация через Canvas API или CSS анимации
// Обязательно: requestAnimationFrame, cleanup при unmount
// Производительность: max 60fps, throttle при фокусе не на окне
// Можно отключить в настройках (для слабых машин)
```

### 4. Компоненты UI (базовые)

```tsx
// Button — с bounce анимацией
// src/renderer/components/ui/Button/Button.tsx

<motion.button
  whileTap={{ scale: 0.92 }}
  whileHover={{ scale: 1.03 }}
  transition={{ type: 'spring', stiffness: 400, damping: 17 }}
  className={cn('button', variant, size)}
>
  {children}
</motion.button>

// Варианты: primary, secondary, ghost, danger
// Размеры: sm, md, lg
// Скругления: 12px (мягкие)

// Input — с focus анимацией
// Glow эффект при фокусе через box-shadow с акцентным цветом

// Card — Liquid Glass карточка
// Базовый .glass + border-radius: 16px

// Modal — с backdrop blur + scale анимация появления
// Toast — уведомления снизу-справа, slide + fade
// Badge — маленькие метки
// Switch — кастомный toggle с spring анимацией
// Slider — кастомный с drag
```

### 5. Главный Layout

```tsx
// src/renderer/pages/Chat/ChatPage.tsx

┌─────────────────────────────────────────┐
│ TitleBar (40px)                         │
├──────────┬──────────────────────────────┤
│          │                              │
│ Sidebar  │      Chat Area               │
│ (250px)  │                              │
│          │  ┌────────────────────────┐  │
│ История  │  │ Сообщения (scroll)     │  │
│ чатов    │  │                        │  │
│          │  │ [User message]         │  │
│ + Новый  │  │ [Syntee message]       │  │
│   чат    │  │                        │  │
│          │  └────────────────────────┘  │
│          │  ┌────────────────────────┐  │
│          │  │ ChatInput              │  │
│          │  └────────────────────────┘  │
└──────────┴──────────────────────────────┘
```

### 6. Сайдбар

```tsx
// src/renderer/components/layout/Sidebar/Sidebar.tsx

Анимация: motion.div с sliding (width: 0 → 250px)
Содержит:
  - Логотип + имя "Syntee" вверху
  - Кнопка "Новый чат" (+ иконка)
  - Список чатов (группировка: Сегодня, Вчера, Эта неделя, Ранее)
  - Каждый чат: название (первые 30 символов), время
  - При наведении: кнопки переименовать / удалить (появляются с fade)
  - Внизу: аватар пользователя + имя + шестерёнка настроек
  
Состояния:
  - Expanded (250px) — по умолчанию
  - Collapsed (0px) — по кнопке или на маленьких экранах
  
Drag для resize не нужен (фиксированный размер)
```

### 7. Чат область

```tsx
// src/renderer/components/chat/ChatMessage/ChatMessage.tsx

Анимация появления: 
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ type: 'spring', stiffness: 300, damping: 25 }}

User сообщение:
  - Справа
  - Liquid Glass карточка с акцентной рамкой
  - Аватар пользователя

Syntee сообщение:
  - Слева
  - Кристалл иконка 28px
  - Имя "Syntee" над сообщением
  - Markdown рендер
  - Кнопки под сообщением: копировать, озвучить, закрепить

Действия при наведении (появляются плавно):
  - Копировать
  - Озвучить
  - Закрепить
  - Редактировать (только user)
  - Удалить

Закреплённые сообщения:
  - Золотая звёздочка
  - Раздел "Закреплённые" вверху сайдбара

Индикатор печати (когда AI генерирует):
  - Три точки с bounce анимацией
  - Имя "Syntee пишет..."
```

### 8. Поле ввода

```tsx
// src/renderer/components/chat/ChatInput/ChatInput.tsx

Дизайн:
  - Liquid Glass карточка внизу
  - Textarea с auto-resize (1 строка → до 6 строк)
  - Enter = отправить, Shift+Enter = новая строка
  
Кнопки в поле:
  - Прикрепить файл (скрепка)
  - Голос (микрофон)
  - Режим инкогнито (маска)
  - Отправить (стрелка) — с bounce при клике

Умные подсказки (заглушка в этой стадии):
  - При вводе → dropdown с предложениями
  - Выбрать стрелками, Enter применить

Drag & Drop:
  - Принимает файлы и картинки
  - При drag-over: подсветка области
  - После drop: превью файла/картинки с кнопкой удалить
```

### 9. Markdown рендер

```tsx
// src/renderer/components/chat/MarkdownRenderer/MarkdownRenderer.tsx

Использовать: react-markdown + react-syntax-highlighter

Что рендерить:
  - Заголовки (h1-h3)
  - Жирный, курсив, зачёркнутый
  - Код inline (моноширинный с background)
  - Блоки кода с подсветкой синтаксиса + кнопка "Копировать"
  - Списки (ul, ol)
  - Таблицы
  - Цитаты (blockquote с левой рамкой)
  - Ссылки (открывают в браузере, не внутри Electron)

Тема подсветки: oneDark для тёмной темы, oneLight для светлой
```

### 10. Spotlight строка

```tsx
// src/renderer/pages/Spotlight/SpotlightPage.tsx

Дизайн:
  - Центр экрана, 30% от верха
  - Ширина 600px
  - Liquid Glass карточка с сильным blur
  - Иконка Syntee слева в инпуте
  - Placeholder: "Спросите что угодно..."
  
Анимация появления:
  initial={{ opacity: 0, scale: 0.95, y: -10 }}
  animate={{ opacity: 1, scale: 1, y: 0 }}
  transition: spring

Результаты под инпутом (когда есть текст):
  - Быстрые команды (/команды)
  - Недавние чаты
  - Предложения

Закрытие: Escape, клик за пределами, потеря фокуса
```

### 11. Zustand Store

```typescript
// src/renderer/store/ui.store.ts
interface UIStore {
  theme: 'dark' | 'light' | 'midnight' | 'forest'
  accentColor: string
  sidebarOpen: boolean
  animatedBackground: boolean
  currentPage: 'chat' | 'settings' | 'tasks' | 'notes' | 'stats'
  setTheme: (theme) => void
  toggleSidebar: () => void
}

// src/renderer/store/chat.store.ts
interface ChatStore {
  chats: Chat[]
  currentChatId: string | null
  messages: Message[]
  isTyping: boolean
  pinnedMessages: Message[]
  createChat: () => void
  selectChat: (id) => void
  addMessage: (msg) => void
  pinMessage: (id) => void
}
```

### 12. Переключение тем

```tsx
// src/renderer/hooks/useTheme.ts

- Читает тему из settings store
- Применяет data-theme атрибут к document.documentElement
- Следит за временем суток если включен авто-режим:
  - Светлая с 08:00 до 20:00
  - Тёмная с 20:00 до 08:00
- При смене темы: плавный transition 300ms на всём body
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] Все 4 темы переключаются, всё выглядит хорошо
- [ ] Liquid Glass эффект виден на карточках, инпуте, сайдбаре
- [ ] Анимированный фон работает, не лагает
- [ ] Сайдбар открывается/закрывается плавно
- [ ] Сообщения появляются снизу вверх с fade
- [ ] Bounce на кнопках работает при клике
- [ ] Markdown рендерится (жирный, код, списки)
- [ ] Подсветка кода с кнопкой "Копировать"
- [ ] Drag & Drop файла → превью показывается
- [ ] Spotlight открывается Ctrl+Space по центру
- [ ] Spotlight закрывается по Escape
- [ ] TypeScript без ошибок
- [ ] Нет мерцаний при анимациях
- [ ] На обоих мониторах всё выглядит корректно
