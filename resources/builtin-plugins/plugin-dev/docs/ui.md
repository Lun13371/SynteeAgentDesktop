# UI: панели, iframe, мост synteeBridge

UI плагина — HTML-файл, рендерящийся в **sandboxed iframe** (без `allow-same-origin` — DOM приложения недоступен). Файлы отдаются по кастомному протоколу:

```
syntee-plugin://{pluginId}/{относительный/путь}
```

Хост отдаёт только файлы из папки плагина (path traversal закрыт).

## Слоты и регистрация

```js
// Кнопка в низу сайдбара (клик → слэш-команда плагина)
syntee.registerUi({ slot: 'sidebar', type: 'button', label: 'Мой плагин', icon: 'star', command: 'mycmd' })

// Панель — таб в правой панели приложения (keep-alive, бейджи)
syntee.registerPanel({ id: 'main', slot: 'right', title: 'Мой плагин', icon: 'star', entry: 'ui/panel.html' })

// Модальная панель (по требованию)
syntee.ui.openModal({ entry: 'ui/form.html', title: 'Форма', width: 480, height: 360 })
syntee.ui.closeModal()

// Бейдж на правой панели (число или null — сброс)
syntee.ui.setBadge('main', 3)
```

Слоты `registerPanel`: `'right'` (таб правой панели), `'modal'`, `'sidebar'`. Entry — путь относительно папки плагина; по умолчанию `manifest.ui`.

Требуется permission `'ui'`.

## Мост synteeBridge (внутри iframe)

Хост НЕ инъектит мост — подключи шим в свой HTML:

```html
<script>
const synteeBridge = (() => {
  let seq = 0
  const pending = new Map()
  const handlers = new Map()
  window.addEventListener('message', (e) => {
    const d = e.data
    if (!d || d.source !== 'syntee-plugin-host') return
    if (d.rpc && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id)
      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'RPC error'))
    } else if (d.data !== undefined) {
      ;(handlers.get(d.method || '*') || []).forEach(cb => { try { cb(d.data) } catch (err) { console.error(err) } })
    }
  })
  return {
    call(method, args) {           // → syntee.ui.handle(method) в процессе плагина
      const id = 'rpc-' + (++seq)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        parent.postMessage({ source: 'syntee-plugin', rpc: true, id, method, args }, '*')
      })
    },
    on(method, cb) {               // push из плагина: syntee.ui.emit(method, data)
      if (!handlers.has(method)) handlers.set(method, [])
      handlers.get(method).push(cb)
    },
  }
})()
</script>
```

### Прямые host-методы из iframe (без хопа в процесс плагина)

`synteeBridge.call(method, args)` с этими именами идёт сразу в main (права манифеста проверяются):

`fs.readFile`, `fs.listDir`, `fs.stat`, `config.get`, `config.getAll`, `ui.getTheme`, `clipboard.readText`, `clipboard.writeText`, `storage.get`, `storage.set`, `storage.delete`, `chats.list`, `chats.get`, `projects.list`, `projects.current`, `memory.search`, `ai.listModels`

Все остальные методы → RPC в `syntee.ui.handle(method, handler)` процесса плагина.

## Сторона плагина

```js
// RPC-хендлеры (вызовы из iframe)
syntee.ui.handle('getStats', async (args) => ({ calls: 42 }))
syntee.ui.handle('save', async (args) => { await syntee.storage.set('draft', args.text); return { saved: true } })

// Push во все свои iframe (synteeBridge.on('update', cb) в панели)
syntee.ui.emit('update', { count: 43 })

// Legacy-канал (fire-and-forget postMessage)
syntee.ui.onMessage((data) => { /* сообщение из iframe */ })
syntee.ui.postMessage({ hello: true })   // → во все свои панели
```

## Тема

```js
const { theme, accentColor, dark } = await syntee.ui.getTheme()
syntee.on('theme:changed', (p) => { /* { theme, accentColor, dark } */ })
```

При загрузке и смене темы хост сам шлёт в iframe `{source:'syntee-plugin-host', theme:{…}}` — шим выше можно расширить. Используй CSS-переменные (`--text`, `--bg`, `--accent`…) для нативного вида.

## Кастомный UI настроек — configUi

`manifest.configUi: 'ui/settings.html'` — iframe в карточке плагина вместо декларативной формы `config`. Панель читает/пишет настройки через `synteeBridge.call('…')` → свои `ui.handle`-хендлеры (например, хранит в `storage` или `secrets`).

## Ограничения iframe

- Sandbox: нет доступа к DOM приложения, localStorage родителя, файловой системе напрямую.
- CSP хоста: скрипты только из своей папки (через syntee-plugin://), инлайн-`<script>` в своих файлах работает.
- Один HTML = один iframe; для сложных экранов делай SPA внутри одного файла.
