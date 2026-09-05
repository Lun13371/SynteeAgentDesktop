# Hello World — демо-плагин SynteeHelper (v3)

Демонстрирует всю систему плагинов. Копируй папку как шаблон для своих.

## Возможности (v3)

- **Тулы для AI**: `hello` (приветствие с config), `count_calls` (счётчик в KV + бейдж), `show_chart` (инлайн-виджет в чате), `search_memory` (поиск по памяти приложения)
- **Слэш-команды**: `/hello`, `/ask <вопрос>` (отправка агенту через chat.send)
- **Правая панель**: таб "Hello Stats" с внутренними табами (Статистика / Чат / Тема / Данные), бейджи
- **Модальная панель**: "О плагине"
- **RPC-мост**: `synteeBridge.call()` в iframe ↔ `syntee.ui.handle()` в плагине
- **Тема**: панель перекрашивается при смене темы приложения
- **Хук `chat:before-send`**: `!caps текст` → КАПС, `!deny` → отклонение отправки
- **События**: `chat:message`, `tool:call`, `theme:changed`

## Права (permissions)

`ui`, `chat`, `chats:read`, `memory`

## Файлы

- `plugin.json` — манифест
- `dist/index.js` — логика (CJS, activate/deactivate)
- `ui/panel.html` — правая панель (с библиотекой synteeBridge — копируй в свои панели)
- `ui/chart.html` — инлайн-виджет для тула show_chart
- `ui/about.html` — модальная панель

## Быстрый старт

1. Включи плагин во вкладке «Плагины» (ExtensionsPopover)
2. Открой правую панель → «+» → «Hello Stats»
3. Напиши в чат: `!caps hello world` — плагин перепишет сообщение
4. Попроси AI: «вызови show_chart» — в ленте появится график
