# plugin.json — манифест

Единственный обязательный файл. Парсится при скане; невалидный JSON или отсутствие полей → плагин не попадает в список.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "author": "You",
  "description": "Короткое описание для списка в UI",
  "promptDescription": "Short description for the system prompt (~200 chars): what the plugin does and which tools it gives.",
  "main": "dist/index.js",
  "ui": "ui/panel.html",
  "readme": "readme.md",
  "configUi": "ui/settings.html",
  "permissions": ["fs:read", "net"],
  "config": [
    { "key": "apiKey", "label": "API-ключ", "type": "password", "default": "", "placeholder": "sk-…", "description": "Ключ сервиса" },
    { "key": "limit", "label": "Лимит", "type": "number", "default": 10 },
    { "key": "verbose", "label": "Подробный лог", "type": "boolean", "default": false }
  ],
  "builtin": false
}
```

## Поля

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `id` | string | ✓ | Уникальный slug, `[a-zA-Z][a-zA-Z0-9_-]*`, **должен совпадать с именем папки** |
| `name` | string | ✓ | Отображаемое имя |
| `version` | string | ✓ | Semver-подобная версия |
| `author` | string | | Автор |
| `description` | string | | Описание для карточки в UI |
| `promptDescription` | string | | ~200 символов для system prompt — AI видит это и понимает назначение плагина. **Пиши по-английски, перечисли тулы.** |
| `main` | string | ✓ | Entry-файл (относительный путь, **CJS-модуль**). Экспортирует `activate(syntee)` и опционально `deactivate()` |
| `ui` | string | | HTML-файл UI по умолчанию (для registerPanel без entry, ui.openModal без entry) |
| `readme` | string | | Путь до markdown-описания (по умолчанию `readme.md`) — рендерится в карточке |
| `configUi` | string | | Кастомный UI настроек (HTML-iframe ВМЕСТО декларативной формы `config`). Общается через `synteeBridge.call` → `syntee.ui.handle`, сохраняет через свой хендлер |
| `permissions` | string[] | | Права (см. секцию permissions). Неизвестные права молча вырезаются лоадером |
| `config` | Field[] | | Декларативная схема настроек — форма в карточке плагина. Значения читаются через `syntee.config.get(key)` |
| `builtin` | boolean | | Только для встроенных плагинов (ставится приложением). Не указывай в своих |

## Config-поля

`{ key, label, type: 'string' | 'password' | 'number' | 'boolean', default?, placeholder?, description? }`

Значения редактирует пользователь в UI; плагин читает их через `syntee.config.get(key)` / `getAll()`.

## Правила entry (main)

- CJS (`module.exports`), не ESM.
- `activate(syntee)` вызывается после спавна процесса; бросок ошибки → статус `error`.
- `deactivate()` вызывается при graceful stop (выключение/reload) — чисти таймеры, соединения, shortcut-ы.
- Внутри процесса доступен Node.js (`require('path')`, `console` и т.д.) — это изоляция процесса, а не песочница. Опасные операции гейтятся правами на уровне host-моста.
