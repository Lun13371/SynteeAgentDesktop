# СТАДИЯ 01 — ФУНДАМЕНТ

> Цель: рабочий Electron скелет. После этой стадии приложение запускается,
> показывает пустое окно, живёт в трее, реагирует на горячие клавиши.
> Никакого AI пока — только оболочка.

---

## ЧТО БУДЕТ ГОТОВО ПОСЛЕ СТАДИИ

- Electron приложение запускается из C:\Projects\SynteeHelper
- Главное окно 1200x800, фиксированный размер, кастомный titlebar
- Трей иконка (цветной кристалл SVG)
- При закрытии — прячется в трей, не убивается
- Горячие клавиши работают глобально (даже когда окно скрыто)
- 4 отдельных окна созданы: Main, Overlay, Voice, Spotlight
- IPC bridge типизирован и работает
- Hot reload в dev режиме
- TypeScript без ошибок, структура проекта полная

---

## ТЕХНОЛОГИИ ЭТОЙ СТАДИИ

```
electron@36
electron-vite
react@18
typescript
electron-builder
electron-store
```

---

## ЗАДАЧИ

### 1. Инициализация проекта

```bash
cd C:\Projects\SynteeHelper
npm create @quick-start/electron syntee-helper --template react-ts
# или вручную:
npm init -y
npm install electron electron-vite react react-dom typescript
npm install -D @types/react @types/react-dom @types/node
```

Настроить electron.vite.config.ts:
- main: src/main/index.ts
- preload: src/preload/index.ts
- renderer: src/renderer/index.html

Настроить tsconfig.json с путями:
- @main -> src/main
- @renderer -> src/renderer
- @core -> src/core
- @shared -> src/shared

### 2. Главное окно (MainWindow.ts)

```typescript
// src/main/windows/MainWindow.ts
- Размер: 1200x800
- frame: false (кастомный titlebar)
- resizable: false
- backgroundColor: '#1a1a1a'
- titleBarStyle: 'hidden'
- При закрытии: event.preventDefault() → win.hide()
- Загружает: renderer/index.html
```

### 3. Оверлей окно (OverlayWindow.ts)

```typescript
// src/main/windows/OverlayWindow.ts
- fullscreen: true
- frame: false
- transparent: true
- alwaysOnTop: true
- skipTaskbar: true
- По умолчанию скрыто
- Покрывает все мониторы (суммарная ширина всех дисплеев)
```

### 4. Голосовое окно (VoiceWindow.ts)

```typescript
// src/main/windows/VoiceWindow.ts
- Небольшое: 300x300
- frame: false
- transparent: true
- alwaysOnTop: true
- skipTaskbar: true
- Позиция: правый нижний угол
- По умолчанию скрыто
```

### 5. Spotlight окно (SpotlightWindow.ts)

```typescript
// src/main/windows/SpotlightWindow.ts
- Размер: 600x80 (расширяется до 600x400 при результатах)
- frame: false
- transparent: true
- alwaysOnTop: true
- skipTaskbar: true
- Позиция: центр экрана, 30% от верха
- По умолчанию скрыто
- Закрывается по Escape и потере фокуса
```

### 6. Трей (TrayManager.ts)

```typescript
// src/main/tray/TrayManager.ts
- Иконка: assets/icons/tray/tray-idle.ico
- Три состояния иконки:
  - idle: обычная
  - listening: анимированная пульсация (3 кадра)
  - active: яркая
- Контекстное меню:
  [ Открыть Syntee ]
  [ Голосовой режим ]
  [ Spotlight ]
  ---
  [ Настройки ]
  [ О программе ]
  ---
  [ Выход ]
- Двойной клик → показать главное окно
```

### 7. Горячие клавиши (HotkeyManager.ts)

```typescript
// src/main/hotkeys/HotkeyManager.ts

Использовать: electron globalShortcut

Регистрировать:
- 'CommandOrControl+Shift+Space' → toggle главное окно
- 'CommandOrControl+Shift+S'     → показать оверлей
- 'CommandOrControl+Shift+V'     → toggle голосовой режим
- 'CommandOrControl+Space'       → toggle spotlight
- 'Alt+Q'                        → быстрый вопрос (spotlight с флагом)
- 'Alt+R'                        → читать выделенное
- 'Alt+T'                        → перевести выделенное
- 'Alt+S'                        → скриншот + анализ

Все хоткеи загружаются из electron-store (настройки пользователя).
При изменении в настройках — unregisterAll() → registerAll().
```

### 8. IPC Bridge (preload/api.ts)

```typescript
// src/preload/api.ts
// Типизированный мост renderer <-> main

contextBridge.exposeInMainWorld('syntee', {
  // Окна
  window: {
    hide: () => ipcRenderer.invoke('window:hide'),
    minimize: () => ipcRenderer.invoke('window:minimize'),
  },
  // Чат (заглушка пока)
  chat: {
    send: (msg) => ipcRenderer.invoke('chat:send', msg),
    onStream: (cb) => ipcRenderer.on('chat:stream', cb),
  },
  // Настройки
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, val) => ipcRenderer.invoke('settings:set', key, val),
    getAll: () => ipcRenderer.invoke('settings:getAll'),
  },
  // Система
  system: {
    getInfo: () => ipcRenderer.invoke('system:info'),
  },
})
```

### 9. Electron Store (настройки)

```typescript
// src/main/store/index.ts
import Store from 'electron-store'

const store = new Store({
  defaults: {
    theme: 'dark',
    accentColor: '#ffffff',
    hotkeys: {
      mainWindow: 'CommandOrControl+Shift+Space',
      overlay: 'CommandOrControl+Shift+S',
      voice: 'CommandOrControl+Shift+V',
      spotlight: 'CommandOrControl+Space',
    },
    apiKey: '',
    apiEndpoint: 'https://api.onlysq.ru/ai/openai',
    mainModel: 'gpt-4o',
    visionModel: 'gemini-3.5-flash',
    sttModel: 'gemini-3-flash',
    ttsModel: 'gemini-3-flash',
    imageModel: 'imagen-3-flash',
    language: 'ru',
    windowBounds: { x: null, y: null },
    onboardingCompleted: false,
    userName: '',
    fontSize: 'medium',
    fontFamily: 'Inter',
    glassOpacity: 'medium',
    animatedBackground: true,
    sounds: true,
    autostart: false,
    agentPermissions: {
      confirmDangerous: true,
      dryRunMode: false,
      forbiddenPaths: ['C:\\Windows', 'C:\\Program Files\\SynteeHelper'],
    },
    backupEnabled: true,
    backupPath: '',
    themeSchedule: {
      enabled: false,
      lightFrom: '08:00',
      darkFrom: '20:00',
    },
  }
})
```

### 10. Кастомный Titlebar (React компонент)

```tsx
// src/renderer/components/layout/TitleBar/TitleBar.tsx
- Логотип (SVG кристалл) слева
- Название "Syntee Helper" 
- Кнопки: свернуть, в трей (без кнопки закрыть — только трей)
- Drag регион для перетаскивания: -webkit-app-region: drag
- Кнопки не draggable: -webkit-app-region: no-drag
- Высота: 40px
```

### 11. electron-builder.yml

```yaml
appId: com.synteehelper.app
productName: Syntee Helper
directories:
  output: dist
win:
  target: nsis
  icon: assets/icons/icon.ico
  requestedExecutionLevel: asUser
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: false
  installerIcon: assets/icons/icon.ico
  installationDirectory: $PROGRAMFILES\SynteeHelper
files:
  - dist/**
  - assets/**
```

---

## СТРУКТУРА ФАЙЛОВ СОЗДАВАЕМЫХ В ЭТОЙ СТАДИИ

```
SynteeHelper/
├── src/
│   ├── main/
│   │   ├── index.ts                ← точка входа
│   │   ├── windows/
│   │   │   ├── MainWindow.ts
│   │   │   ├── OverlayWindow.ts
│   │   │   ├── VoiceWindow.ts
│   │   │   └── SpotlightWindow.ts
│   │   ├── tray/
│   │   │   └── TrayManager.ts
│   │   ├── hotkeys/
│   │   │   └── HotkeyManager.ts
│   │   └── ipc/
│   │       └── index.ts
│   ├── preload/
│   │   ├── index.ts
│   │   └── api.ts
│   ├── renderer/
│   │   ├── index.html
│   │   ├── main.tsx
│   │   └── App.tsx                 ← пустой, просто "Syntee работает"
│   └── shared/
│       ├── types/
│       │   └── ipc.types.ts
│       └── constants.ts
├── assets/
│   └── icons/
│       ├── icon.svg
│       └── tray/
│           ├── tray-idle.ico
│           └── tray-listening.ico
├── electron.vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── package.json
└── .env.example
```

---

## ПРОВЕРКА ГОТОВНОСТИ СТАДИИ

- [ ] npm run dev запускается без ошибок
- [ ] Главное окно появляется 1200x800
- [ ] Кастомный titlebar работает, окно перетаскивается
- [ ] Кнопка minimize работает
- [ ] Закрытие окна → иконка в трее (окно не убито)
- [ ] Двойной клик по трею → окно появляется
- [ ] Ctrl+Shift+Space → toggle окна (работает глобально)
- [ ] Ctrl+Shift+S → оверлей открывается (пустой прозрачный)
- [ ] Ctrl+Space → spotlight появляется по центру
- [ ] Меню трея работает, все пункты кликаются
- [ ] TypeScript: tsc --noEmit без ошибок
- [ ] electron-store сохраняет и читает настройки
