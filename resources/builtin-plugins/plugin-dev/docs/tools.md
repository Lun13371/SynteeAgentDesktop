# Тулы для AI — registerTool

Тул — функция, которую модель может вызывать как инструмент (как read_file или search_web у хоста). Тулы плагина попадают в схему агента, когда плагин **запущен** и его scope покрывает текущий чат.

```js
syntee.registerTool({
  name: 'get_weather',            // [a-zA-Z][a-zA-Z0-9_]*, короткое имя (без префикса)
  description: 'Get current weather for a city',
  parameters: {                   // JSON Schema
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      units: { type: 'string', enum: ['c', 'f'] },
    },
    required: ['city'],
  },
  handler: async (args) => {
    const r = await syntee.net.fetch('https://wttr.in/' + args.city + '?format=j1')
    const data = JSON.parse(r.body)
    return 'Погода в ' + args.city + ': ' + data.current_condition[0].temp_C + '°C'
  },
})
```

## Правила

- **Имя**: `[a-zA-Z][a-zA-Z0-9_]*`. Модель видит тул как `plugin__{pluginId}__{name}`.
- **Description** — по-английски, конкретно: что делает, когда звать, что вернёт. Это единственное, что видит модель кроме схемы.
- **Parameters** — JSON Schema (`type: 'object'`, `properties`, `required`). Без `parameters` — тул без аргументов.
- **Handler** — async или sync. Возврат: **строка** (текст для модели). Объекты сериализуй сам (`JSON.stringify`).
- Ошибка в handler → модель получит текст ошибки (не роняет процесс плагина).
- Права проверяются в handler-е как обычно (`net.fetch` требует `net` и т.д.).

## Инлайн-виджеты (rich-результат)

Тул может вернуть не текст, а JSON-маркер — тогда в чат рендерится **iframe-виджет** вместо текста:

```js
syntee.ui.registerWidget({ name: 'chart', entry: 'ui/chart.html', height: 260 })

// в handler-е тула:
return JSON.stringify({
  __plugin_ui__: true,
  widget: 'chart',                    // имя из registerWidget
  data: { labels: [...], values: [...] },  // попадёт в виджет
})
```

Виджет (ui/chart.html) получает `data` через мост — см. секцию **ui**.

## Динамические тулы

`registerTool` можно звать в любой момент (не только в activate): подписка на событие → регистрация тула по мере надобности. Список тулов в UI обновляется пушем.

## Что НЕ надо делать тулом

- Одноразовые действия пользователя → слэш-команда (см. **commands**).
- Фоновые задачи → scheduler + notifications.
- Тул должен быть полезен **модели** в диалоге.
