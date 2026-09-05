/**
 * Plugin Dev — встроенная студия разработки плагинов SynteeHelper.
 *
 * Даёт AI и пользователю всё для создания плагинов:
 *   - plugin_docs      — полная документация plugin API (docs/*.md, секциями)
 *   - create_plugin    — скаффолдинг нового плагина в {userData}/plugins
 *   - list_plugins     — список установленных плагинов с манифестами
 *   - read_plugin      — исходники плагина (манифест + entry)
 *   - validate_plugin  — проверка манифеста/прав/entry
 *   - delete_plugin    — удаление плагина (кроме встроенных)
 *
 * UI: правая панель «Plugin Dev» — браузер документации + мастер создания
 * (iframe ui/index.html, RPC через synteeBridge → ui.handle).
 *
 * CJS-модуль, исполняется в изолированном utilityProcess.
 */

/** @param {import('../../../src/core/plugins/pluginHost').SynteePluginApi} syntee */
module.exports.activate = function (syntee) {
  const path = require('path')

  // {userData}/plugins — plugin-dev сам лежит там (встроенные синхронизируются
  // в глобальную папку при запуске приложения).
  const pluginsDir = path.dirname(syntee.pluginDir)

  // ── Документация ────────────────────────────────────────────────────────
  const DOCS = [
    { id: 'index', title: 'Обзор и быстрый старт' },
    { id: 'architecture', title: 'Архитектура плагина (многофайловость)' },
    { id: 'runtimes', title: 'Рантаймы: Node.js и Python' },
    { id: 'manifest', title: 'plugin.json — манифест' },
    { id: 'permissions', title: 'Права (permissions)' },
    { id: 'tools', title: 'Тулы для AI (registerTool)' },
    { id: 'commands', title: 'Слэш-команды (registerCommand)' },
    { id: 'ui', title: 'UI: панели, iframe, synteeBridge' },
    { id: 'contributions', title: 'Вклады: виджеты, поиск, темы, фон' },
    { id: 'api-core', title: 'API: storage, fs, clipboard, уведомления' },
    { id: 'api-chat', title: 'API: чаты, проекты, память' },
    { id: 'api-ai', title: 'API: AI, агент, MCP' },
    { id: 'api-system', title: 'API: сеть, git, планировщик, трей' },
    { id: 'events', title: 'События и хуки' },
    { id: 'examples', title: 'Примеры и шаблоны' },
  ]

  async function readDoc(section) {
    const id = String(section || 'index')
    const meta = DOCS.find(d => d.id === id)
    if (!meta) {
      return 'Неизвестная секция: ' + id + '\nДоступные: ' + DOCS.map(d => d.id).join(', ')
    }
    const file = path.join(syntee.pluginDir, 'docs', id + '.md')
    const content = await syntee.fs.readFile(file)
    return '# ' + meta.title + '\n\n' + content
  }

  function docsIndex() {
    return [
      '# SynteeHelper Plugin API — документация',
      '',
      'Полная документация API плагинов SynteeHelper. Читай секции тулом plugin_docs с параметром section.',
      '',
      ...DOCS.map(d => '- **' + d.id + '** — ' + d.title),
      '',
      'Быстрый старт: секция **index**. Для создания плагина не пиши файлы руками — ',
      'вызови тул create_plugin (он сгенерирует корректный скаффолд).',
    ].join('\n')
  }

  syntee.registerTool({
    name: 'plugin_docs',
    description:
      'Документация plugin API SynteeHelper. Без section — оглавление. Секции: ' +
      DOCS.map(d => d.id).join(', ') +
      '. Вызывай перед созданием плагина или при сомнениях в API.',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: DOCS.map(d => d.id),
          description: 'Секция документации (без параметра — оглавление)',
        },
      },
    },
    handler: async (args) => {
      if (!args.section) return docsIndex()
      return readDoc(args.section)
    },
  })

  // ── Чтение установленных плагинов ───────────────────────────────────────
  async function readManifestOf(id) {
    try {
      const raw = await syntee.fs.readFile(path.join(pluginsDir, id, 'plugin.json'))
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  const VALID_PERMISSIONS = [
    'net', 'fs:read', 'fs:write', 'fs:write:any', 'clipboard', 'notifications', 'ui',
    'chat', 'chats:read', 'chats:write', 'projects:read', 'projects:write', 'memory',
    'ai', 'scheduler', 'shortcuts', 'process:exec', 'overlay', 'tray',
    'context', 'secrets', 'git', 'mcp', 'webhook', 'agent', 'hooks',
  ]

  syntee.registerTool({
    name: 'list_plugins',
    description: 'Список установленных плагинов SynteeHelper: id, имя, версия, права, встроенный или пользовательский.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      const ids = (await syntee.fs.listDir(pluginsDir)).filter(e => /^[a-zA-Z][\w-]*$/.test(e))
      const lines = ['# Установленные плагины (' + pluginsDir + ')', '']
      for (const id of ids) {
        const m = await readManifestOf(id)
        if (!m) continue
        lines.push(
          '- **' + id + '** v' + (m.version || '?') + (m.builtin ? ' (встроенный)' : '') +
          ' — ' + (m.description || m.name || '') +
          (m.permissions ? '\n  права: ' + m.permissions.join(', ') : ''),
        )
      }
      return lines.join('\n')
    },
  })

  syntee.registerTool({
    name: 'read_plugin',
    description: 'Исходники плагина: plugin.json + entry-файл (dist/index.js). Для анализа и отладки чужих/своих плагинов.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id плагина (имя папки в plugins)' },
        file: { type: 'string', description: 'Опционально: конкретный файл внутри папки плагина (напр. dist/index.js, ui/panel.html)' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const id = String(args.id || '')
      if (!/^[a-zA-Z][\w-]*$/.test(id)) return 'Некорректный id: ' + id
      const dir = path.join(pluginsDir, id)
      const st = await syntee.fs.stat(dir)
      if (!st.exists) return 'Плагин не найден: ' + id

      const file = args.file ? String(args.file) : null
      if (file) {
        const full = path.join(dir, file)
        if (!full.startsWith(dir)) return 'Путь вне папки плагина'
        const fst = await syntee.fs.stat(full)
        if (!fst.exists) return 'Файл не найден: ' + file
        let content = await syntee.fs.readFile(full)
        if (content.length > 40000) content = content.slice(0, 40000) + '\n\n... (обрезано, всего ' + content.length + ' символов)'
        return '# ' + id + '/' + file + '\n\n```\n' + content + '\n```'
      }

      const manifest = await readManifestOf(id)
      if (!manifest) return 'В папке ' + id + ' нет валидного plugin.json'
      let entry = ''
      try {
        entry = await syntee.fs.readFile(path.join(dir, manifest.main))
        if (entry.length > 40000) entry = entry.slice(0, 40000) + '\n\n... (обрезано)'
      } catch { entry = '(entry не читается)' }
      return (
        '# ' + id + ' — plugin.json\n\n```json\n' +
        JSON.stringify(manifest, null, 2) +
        '\n```\n\n# ' + id + ' — ' + manifest.main + '\n\n```js\n' + entry + '\n```'
      )
    },
  })

  syntee.registerTool({
    name: 'validate_plugin',
    description: 'Проверяет плагин: валидность plugin.json (id/name/main), существование entry, корректность прав, наличие readme. Возвращает отчёт с ошибками и предупреждениями.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id плагина (имя папки в plugins)' } },
      required: ['id'],
    },
    handler: async (args) => {
      const id = String(args.id || '')
      if (!/^[a-zA-Z][\w-]*$/.test(id)) return 'Некорректный id: ' + id
      const dir = path.join(pluginsDir, id)
      const st = await syntee.fs.stat(dir)
      if (!st.exists) return 'Плагин не найден: ' + id

      const errors = []
      const warnings = []
      let manifest = null
      try {
        manifest = JSON.parse(await syntee.fs.readFile(path.join(dir, 'plugin.json')))
      } catch {
        errors.push('plugin.json отсутствует или не парсится как JSON')
      }
      if (manifest) {
        if (manifest.id !== id) errors.push('id в манифесте (' + manifest.id + ') != имени папки (' + id + ')')
        if (!manifest.name) errors.push('нет name')
        if (!manifest.main) errors.push('нет main (entry point)')
        if (manifest.main) {
          const est = await syntee.fs.stat(path.join(dir, manifest.main))
          if (!est.exists) errors.push('entry не найден: ' + manifest.main)
        }
        if (manifest.ui) {
          const ust = await syntee.fs.stat(path.join(dir, manifest.ui))
          if (!ust.exists) errors.push('ui-файл не найден: ' + manifest.ui)
        }
        const perms = manifest.permissions || []
        const bad = perms.filter(p => !VALID_PERMISSIONS.includes(p))
        if (bad.length) errors.push('неизвестные права (будут проигнорированы): ' + bad.join(', '))
        if (!perms.length) warnings.push('нет прав — плагин не сможет вызывать host-API')
        if (!manifest.promptDescription) warnings.push('нет promptDescription — AI не увидит описание плагина в промпте')
      }
      const rst = await syntee.fs.stat(path.join(dir, 'readme.md'))
      if (!rst.exists) warnings.push('нет readme.md (описание для карточки в UI)')

      const ok = errors.length === 0
      return [
        '# Валидация плагина ' + id + ': ' + (ok ? 'OK' : 'ЕСТЬ ОШИБКИ'),
        '',
        ...(errors.length ? ['## Ошибки', ...errors.map(e => '- ❌ ' + e)] : []),
        ...(warnings.length ? ['## Предупреждения', ...warnings.map(w => '- ⚠️ ' + w)] : []),
        ...(ok && !warnings.length ? ['Ошибок и предупреждений нет.'] : []),
      ].join('\n')
    },
  })

  // ── Создание плагина ────────────────────────────────────────────────────
  function buildEntryTemplate(spec) {
    const tools = Array.isArray(spec.tools) ? spec.tools : []
    const commands = Array.isArray(spec.commands) ? spec.commands : []
    const withUi = spec.withUi === true

    const toolRegs = tools.map(t => {
      const params = t.parameters
        ? JSON.stringify(t.parameters, null, 6).replace(/\n/g, '\n      ')
        : "{ type: 'object', properties: {} }"
      return (
        "  syntee.registerTool({\n" +
        "    name: '" + t.name + "',\n" +
        "    description: " + JSON.stringify(t.description || ('Tool ' + t.name)) + ",\n" +
        "    parameters: " + params + ",\n" +
        "    handler: async (args) => {\n" +
        "      // TODO: реализуй логику\n" +
        "      syntee.log('" + t.name + " вызван:', JSON.stringify(args))\n" +
        "      return 'OK'\n" +
        "    },\n" +
        "  })\n"
      )
    }).join('\n')

    const cmdRegs = commands.map(c =>
      "  syntee.registerCommand({\n" +
      "    name: '" + c.name + "',\n" +
      "    description: " + JSON.stringify(c.description || ('Command ' + c.name)) + ",\n" +
      "    handler: async (args) => {\n" +
      "      // TODO: реализуй логику. args — строка после /" + c.name + "\n" +
      "      syntee.log('/" + c.name + ":', args)\n" +
      "      return 'Готово'\n" +
      "    },\n" +
      "  })\n"
    ).join('\n')

    const uiReg = withUi
      ? "\n  // Панель в правой части приложения (ui/panel.html).\n" +
        "  syntee.registerPanel({ id: '" + spec.id + "-panel', slot: 'right', title: " + JSON.stringify(spec.name) + ", entry: 'ui/panel.html' })\n" +
        "  // RPC из панели: synteeBridge.call('ping', {...}) → хендлер ниже.\n" +
        "  syntee.ui.handle('ping', async (args) => ({ pong: true, args }))\n"
      : ''

    return (
      "/**\n" +
      " * " + (spec.name || spec.id) + " — плагин SynteeHelper.\n" +
      (spec.description ? " * " + spec.description + "\n" : '') +
      " *\n" +
      " * CJS-модуль, исполняется в изолированном utilityProcess.\n" +
      " * API: см. документацию — тул plugin_docs плагина plugin-dev.\n" +
      " */\n" +
      "\n" +
      "/** @param {any} syntee */\n" +
      "module.exports.activate = function (syntee) {\n" +
      "  syntee.log('activated')\n" +
      "\n" +
      (toolRegs || "  // Регистрация тулов для AI — syntee.registerTool({ name, description, parameters, handler })\n") +
      "\n" +
      (cmdRegs || "  // Слэш-команды — syntee.registerCommand({ name, description, handler(args) })\n") +
      uiReg +
      "\n" +
      "  // События хоста — см. секцию events документации:\n" +
      "  // syntee.on('chat:message', (p) => { ... })\n" +
      "}\n" +
      "\n" +
      "module.exports.deactivate = function () {\n" +
      "  // Очистка: остановить таймеры, закрыть соединения.\n" +
      "}\n"
    )
  }

  // ── Многофайловая структура (structure: 'multi') ────────────────────────
  // index.js — только wiring; логика по модулям. См. docs/architecture.md.
  function buildMultiFiles(spec) {
    const tools = Array.isArray(spec.tools) ? spec.tools : []
    const commands = Array.isArray(spec.commands) ? spec.commands : []
    const withUi = spec.withUi === true
    const name = spec.name || spec.id

    // dist/index.js — точка входа: только подключение модулей.
    const indexJs = [
      '/**',
      ' * ' + name + ' — плагин SynteeHelper (многофайловая структура).',
      (spec.description ? ' * ' + spec.description : null),
      ' *',
      ' * dist/index.js — только wiring (подключение модулей). Логика — в модулях.',
      ' * Архитектура: docs/architecture.md (тул plugin_docs).',
      ' */',
      '',
      "const { registerTools } = require('./tools')",
      "const { registerCommands } = require('./commands')",
      withUi ? "const { registerPanel, registerHandlers } = require('./ui')" : null,
      "const state = require('./state')",
      '',
      '/** @param {any} syntee */',
      'module.exports.activate = function (syntee) {',
      "  state.init(syntee)",
      "  syntee.log('activated')",
      '',
      '  registerTools(syntee)',
      '  registerCommands(syntee)',
      withUi ? '  registerPanel(syntee)' : null,
      withUi ? '  registerHandlers(syntee)' : null,
      '',
      "  // События хоста — см. plugin_docs(section=events)",
      "  // syntee.on('chat:message', (p) => { ... })",
      '}',
      '',
      'module.exports.deactivate = function () {',
      '  // Очистка: state.cleanup() останавливает всё, что зарегистрировано.',
      '  state.cleanup()',
      '}',
      '',
    ].filter(l => l !== null).join('\n')

    // dist/state.js — общее состояние + доступ к API для модулей.
    const stateJs = [
      '/**',
      ' * state — общее состояние плагина + ссылка на API.',
      ' * Модули получают syntee через state.api, а не параметром —',
      ' * чтобы handlers/таймеры всегда имели доступ.',
      ' */',
      'let api = null',
      'const timers = new Set()   // всё, что надо остановить в deactivate',
      '',
      'module.exports = {',
      '  get api() { return api },',
      '  init(syntee) { api = syntee },',
      '',
      '  /** Таймер с авто-регистрацией для cleanup. */',
      '  every(intervalMs, fn) {',
      '    const t = setInterval(fn, intervalMs)',
      '    timers.add(t)',
      '    return () => { clearInterval(t); timers.delete(t) }',
      '  },',
      '',
      '  cleanup() {',
      '    for (const t of timers) clearInterval(t)',
      '    timers.clear()',
      '    api = null',
      '  },',
      '}',
      '',
    ].join('\n')

    // dist/tools.js — тулы для AI.
    const toolDefs = tools.length
      ? tools.map(t => {
        const params = t.parameters
          ? JSON.stringify(t.parameters, null, 2).replace(/\n/g, '\n    ')
          : "{ type: 'object', properties: {} }"
        return (
          "  {\n" +
          "    name: '" + t.name + "',\n" +
          "    description: " + JSON.stringify(t.description || ('Tool ' + t.name)) + ",\n" +
          "    parameters: " + params + ",\n" +
          "    handler: async (args) => {\n" +
          "      // TODO: реализуй логику\n" +
          "      state.api.log('" + t.name + " вызван:', JSON.stringify(args))\n" +
          "      return 'OK'\n" +
          "    },\n" +
          "  },"
        )
      }).join('\n')
      : "  // TODO: добавь тулы — { name, description, parameters, handler }"
    const toolsJs = [
      '/** tools — тулы для AI (registerTool). Логика здесь, wiring в index.js. */',
      "const state = require('./state')",
      '',
      'function registerTools(syntee) {',
      '  const defs = [',
      toolDefs,
      '  ]',
      '  for (const d of defs) syntee.registerTool(d)',
      '}',
      '',
      'module.exports = { registerTools }',
      '',
    ].join('\n')

    // dist/commands.js — слэш-команды.
    const cmdDefs = commands.length
      ? commands.map(c =>
        "  {\n" +
        "    name: '" + c.name + "',\n" +
        "    description: " + JSON.stringify(c.description || ('Command ' + c.name)) + ",\n" +
        "    handler: async (args) => {\n" +
        "      // TODO: реализуй. args — строка после /" + c.name + "\n" +
        "      state.api.log('/" + c.name + ":', args)\n" +
        "      return 'Готово'\n" +
        "    },\n" +
        "  },",
      ).join('\n')
      : "  // TODO: добавь команды — { name, description, handler }"
    const commandsJs = [
      '/** commands — слэш-команды (registerCommand). */',
      "const state = require('./state')",
      '',
      'function registerCommands(syntee) {',
      '  const defs = [',
      cmdDefs,
      '  ]',
      '  for (const d of defs) syntee.registerCommand(d)',
      '}',
      '',
      'module.exports = { registerCommands }',
      '',
    ].join('\n')

    const files = {
      'dist/index.js': indexJs,
      'dist/state.js': stateJs,
      'dist/tools.js': toolsJs,
      'dist/commands.js': commandsJs,
    }

    // dist/ui.js + многофайловый UI (html/css/js раздельно).
    if (withUi) {
      files['dist/ui.js'] = [
        '/** ui — панель в правой части + RPC-хендлеры для iframe. */',
        "const state = require('./state')",
        '',
        'function registerPanel(syntee) {',
        "  syntee.registerPanel({ id: '" + spec.id + "-panel', slot: 'right', title: " + JSON.stringify(name) + ", entry: 'ui/panel.html' })",
        '}',
        '',
        'function registerHandlers(syntee) {',
        "  // RPC из панели: synteeBridge.call('ping', {...}) → хендлеры ниже.",
        "  syntee.ui.handle('ping', async (args) => ({ pong: true, args }))",
        "  // Push в панель: syntee.ui.emit('update', {...}) → synteeBridge.on('update', cb)",
        '}',
        '',
        'module.exports = { registerPanel, registerHandlers }',
        '',
      ].join('\n')
      files['ui/panel.html'] = [
        '<!DOCTYPE html>',
        '<html lang="ru">',
        '<head>',
        '<meta charset="UTF-8">',
        '<title>' + name + '</title>',
        '<link rel="stylesheet" href="css/panel.css">',
        '</head>',
        '<body>',
        '  <h3>' + name + '</h3>',
        '  <p>Панель плагина. RPC — через мост (js/bridge.js).</p>',
        '  <pre id="out">…</pre>',
        '  <button id="ping">ping → syntee.ui.handle</button>',
        '  <script src="js/bridge.js"><\/script>',
        '  <script src="js/panel.js"><\/script>',
        '</body>',
        '</html>',
      ].join('\n')
      files['ui/css/panel.css'] = [
        '/* Стиль панели. CSS-переменные темы приходят от хоста. */',
        'body { font-family: var(--font-main, system-ui); margin: 0; padding: 12px; background: transparent; color: var(--text, #eee); }',
        'button { cursor: pointer; }',
        'pre { white-space: pre-wrap; word-break: break-all; }',
        '',
      ].join('\n')
      files['ui/js/bridge.js'] = buildBridgeJs()
      files['ui/js/panel.js'] = [
        '// Логика панели. Мост — js/bridge.js (synteeBridge.call / .on).',
        "document.getElementById('ping').onclick = async () => {",
        "  try { document.getElementById('out').textContent = JSON.stringify(await synteeBridge.call('ping', { hi: 1 })) }",
        "  catch (e) { document.getElementById('out').textContent = 'ERR ' + e.message }",
        '}',
        '',
        '// Push из плагина: syntee.ui.emit(\'update\', data)',
        "synteeBridge.on('update', (data) => {",
        "  document.getElementById('out').textContent = JSON.stringify(data)",
        '})',
        '',
      ].join('\n')
    }

    return files
  }

  /** Мост synteeBridge для iframe-панелей (отдельный файл в multi-структуре). */
  function buildBridgeJs() {
    return [
      '// synteeBridge — RPC-мост с процессом плагина (postMessage-протокол).',
      '// Документация: plugin_docs(section=ui).',
      'const synteeBridge = (() => {',
      '  let seq = 0',
      '  const pending = new Map()',
      '  const handlers = new Map()',
      '  window.addEventListener("message", (e) => {',
      '    const d = e.data',
      '    if (!d || d.source !== "syntee-plugin-host") return',
      '    if (d.rpc && pending.has(d.id)) {',
      '      const p = pending.get(d.id); pending.delete(d.id)',
      '      d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || "RPC error"))',
      '      return',
      '    }',
      '    if (d.theme) { document.documentElement.dataset.dark = d.theme.dark ? "1" : "0"; return }',
      '    // Push от плагина (ui.emit) приходит обёрнутым в { __rpc__: true, method, data }.',
      '    if (d.data && d.data.__rpc__) {',
      '      ;(handlers.get(d.data.method) || []).forEach(cb => { try { cb(d.data.data) } catch (err) { console.error(err) } })',
      '      return',
      '    }',
      '    if (d.data !== undefined) {',
      '      ;(handlers.get("*") || []).forEach(cb => { try { cb(d.data) } catch (err) { console.error(err) } })',
      '    }',
      '  })',
      '  return {',
      '    call(method, args) {',
      '      const id = "rpc-" + (++seq)',
      '      return new Promise((resolve, reject) => {',
      '        pending.set(id, { resolve, reject })',
      '        parent.postMessage({ source: "syntee-plugin", rpc: true, id, method, args }, "*")',
      '      })',
      '    },',
      '    on(method, cb) {',
      '      if (!handlers.has(method)) handlers.set(method, [])',
      '      handlers.get(method).push(cb)',
      '    },',
      '  }',
      '})()',
      '',
    ].join('\n')
  }

  function buildPanelHtml(spec) {
    return [
      '<!DOCTYPE html>',
      '<html lang="ru">',
      '<head>',
      '<meta charset="UTF-8">',
      '<title>' + spec.name + '</title>',
      '<style>',
      '  body { font-family: var(--font-main, system-ui); margin: 0; padding: 12px; background: transparent; color: var(--text, #eee); }',
      '  button { cursor: pointer; }',
      '</style>',
      '</head>',
      '<body>',
      '  <h3>' + spec.name + '</h3>',
      '  <p>Панель плагина. Общение с процессом плагина — через RPC-мост:</p>',
      '  <pre id="out">…</pre>',
      '  <button id="ping">ping → syntee.ui.handle</button>',
      '  <script>',
      '    // ── Мост synteeBridge (postMessage-протокол) ──',
      '    const synteeBridge = (() => {',
      '      let seq = 0',
      '      const pending = new Map()',
      '      const handlers = new Map()',
      '      window.addEventListener("message", (e) => {',
      '        const d = e.data',
      '        if (!d || d.source !== "syntee-plugin-host") return',
      '        if (d.rpc && pending.has(d.id)) {',
      '          const p = pending.get(d.id); pending.delete(d.id)',
      '          d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || "RPC error"))',
      '        } else if (d.data !== undefined) {',
      '          ;(handlers.get(d.method || "*") || []).forEach(cb => { try { cb(d.data) } catch (err) { console.error(err) } })',
      '        }',
      '      })',
      '      return {',
      '        call(method, args) {',
      '          const id = "rpc-" + (++seq)',
      '          return new Promise((resolve, reject) => {',
      '            pending.set(id, { resolve, reject })',
      '            parent.postMessage({ source: "syntee-plugin", rpc: true, id, method, args }, "*")',
      '          })',
      '        },',
      '        on(method, cb) {',
      '          if (!handlers.has(method)) handlers.set(method, [])',
      '          handlers.get(method).push(cb)',
      '        },',
      '      }',
      '    })()',
      '    document.getElementById("ping").onclick = async () => {',
      '      try { document.getElementById("out").textContent = JSON.stringify(await synteeBridge.call("ping", { hi: 1 })) }',
      '      catch (e) { document.getElementById("out").textContent = "ERR " + e.message }',
      '    }',
      '  <\/script>',
      '</body>',
      '</html>',
    ].join('\n')
  }

  // ── Python-шаблон (runtime: 'python') ───────────────────────────────────
  // Один dist/main.py: регистрации + логика. SDK импортируется из PYTHONPATH
  // (хост кладёт туда {userData}/python-sdk). См. docs/runtimes.md.
  function buildPythonEntry(spec) {
    const tools = Array.isArray(spec.tools) ? spec.tools : []
    const commands = Array.isArray(spec.commands) ? spec.commands : []
    const pyFn = (n) => 'tool_' + String(n).replace(/[^a-zA-Z0-9_]/g, '_')
    const cmdFn = (n) => 'cmd_' + String(n).replace(/[^a-zA-Z0-9_]/g, '_')

    const toolBlocks = tools.map(t => {
      const params = t.parameters
        ? JSON.stringify(t.parameters)
        : '{"type": "object", "properties": {}}'
      return [
        '@syntee.tool(' + JSON.stringify(t.name) + ', ' + JSON.stringify(t.description || '') + ', parameters=' + params + ')',
        'def ' + pyFn(t.name) + '(args):',
        '    """Логика тула ' + t.name + '. Верни str или JSON-сериализуемый объект."""',
        '    # syntee.log("вызван ' + t.name + ': " + str(args))',
        '    return {"ok": True, "echo": args}',
        '',
      ].join('\n')
    }).join('\n')

    const cmdBlocks = commands.map(c => [
      '@syntee.command(' + JSON.stringify(c.name) + ', ' + JSON.stringify(c.description || '') + ')',
      'def ' + cmdFn(c.name) + '(args):',
      '    """Слэш-команда /' + c.name + ' — args: строка после имени."""',
      '    return "/' + c.name + ' получил: " + args',
      '',
    ].join('\n')).join('\n')

    return [
      '"""' + (spec.name || spec.id) + ' — Python-плагин SynteeHelper.',
      '',
      (spec.description || ''),
      '',
      'SDK: from syntee import syntee (кладётся хостом в PYTHONPATH).',
      'Дока: plugin_docs(section=runtimes).',
      '"""',
      '',
      'from syntee import syntee',
      '',
      ...(toolBlocks ? ['# ── Тулы для AI ' + '─'.repeat(30), toolBlocks] : ['# Тулы не зарегистрированы — добавь @syntee.tool(...)']),
      ...(cmdBlocks ? ['', '# ── Слэш-команды ' + '─'.repeat(28), cmdBlocks] : []),
      '',
      '# ── События хоста (см. plugin_docs section=events) ' + '─'.repeat(10),
      '# @syntee.on("chat:message")',
      '# def on_message(payload):',
      '#     syntee.log("message: " + str(payload.get("content", "")))',
      '',
      '# ── Очистка при выключении ' + '─'.repeat(22),
      '@syntee.deactivate',
      'def on_shutdown():',
      '    pass',
      '',
      '# Запуск цикла обработки — обязательно последняя строка:',
      'syntee.run()',
      '',
    ].join('\n')
  }

  async function createPlugin(spec) {
    const id = String(spec.id || '')
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) {
      throw new Error('id должен быть [a-zA-Z][a-zA-Z0-9_-]* (получено: ' + JSON.stringify(id) + ')')
    }
    if (id === 'plugin-dev') throw new Error('Нельзя перезаписать plugin-dev')
    const target = path.join(pluginsDir, id)
    const st = await syntee.fs.stat(target)
    if (st.exists && !spec.overwrite) {
      throw new Error('Плагин ' + id + ' уже существует. Передай overwrite: true для замены.')
    }

    const perms = Array.isArray(spec.permissions)
      ? spec.permissions.filter(p => VALID_PERMISSIONS.includes(p))
      : []
    if (Array.isArray(spec.permissions)) {
      const bad = spec.permissions.filter(p => !VALID_PERMISSIONS.includes(p))
      if (bad.length) console.warn('[plugin-dev] отфильтрованы неизвестные права:', bad)
    }
    // Права, без которых скаффолд нежизнеспособен.
    if (spec.withUi && !perms.includes('ui')) perms.push('ui')

    const runtime = spec.runtime === 'python' ? 'python' : 'node'

    const manifest = {
      id,
      name: String(spec.name || id),
      version: String(spec.version || '0.1.0'),
      author: String(spec.author || ''),
      description: String(spec.description || ''),
      promptDescription: String(spec.promptDescription || spec.description || '').slice(0, 200),
      main: runtime === 'python' ? 'dist/main.py' : 'dist/index.js',
      readme: 'readme.md',
      permissions: perms,
    }
    if (runtime === 'python') {
      manifest.runtime = 'python'
      const reqs = Array.isArray(spec.requirements)
        ? spec.requirements.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim())
        : []
      if (reqs.length) manifest.requirements = reqs
    }
    if (spec.withUi && runtime !== 'python') manifest.ui = 'ui/panel.html'
    if (Array.isArray(spec.config) && spec.config.length) manifest.config = spec.config

    const files = {
      'plugin.json': JSON.stringify(manifest, null, 2) + '\n',
      'dist/index.js': buildEntryTemplate({ ...spec, id }),
      'readme.md': [
        '# ' + manifest.name,
        '',
        spec.description || '',
        '',
        '## Структура',
        '',
        runtime === 'python'
          ? '- dist/main.py — вся логика (Python SDK: from syntee import syntee)' +
            (manifest.requirements ? '\n- requirements: ' + manifest.requirements.join(', ') + ' (ставятся автоматически при первом запуске)' : '')
          : spec.structure === 'multi'
            ? '- dist/index.js — wiring (подключение модулей)\n- dist/tools.js — тулы для AI\n- dist/commands.js — слэш-команды\n- dist/state.js — общее состояние' +
              (spec.withUi ? '\n- dist/ui.js — панель + RPC-хендлеры\n- ui/panel.html + css/ + js/ — UI (мост в js/bridge.js)' : '')
            : '- dist/index.js — вся логика',
        '',
        '## Тулы',
        ...(Array.isArray(spec.tools) && spec.tools.length
          ? spec.tools.map(t => '- **' + t.name + '** — ' + (t.description || ''))
          : ['(не зарегистрированы)']),
        '',
        'Сгенерировано плагином Plugin Dev ' + new Date().toISOString().slice(0, 10) + '.',
      ].join('\n'),
    }
    if (runtime === 'python') {
      // Python-плагин: единый dist/main.py (SDK в PYTHONPATH хоста).
      delete files['dist/index.js']
      files['dist/main.py'] = buildPythonEntry({ ...spec, id })
    } else if (spec.structure === 'multi') {
      // Многофайловая структура: index.js — wiring, логика по модулям.
      const multi = buildMultiFiles({ ...spec, id })
      delete files['dist/index.js']
      Object.assign(files, multi)
    }
    if (spec.withUi && runtime !== 'python' && spec.structure !== 'multi') {
      files['ui/panel.html'] = buildPanelHtml({ ...spec, name: manifest.name })
    }

    await syntee.fs.writeFiles(files, { baseDir: target })

    syntee.log('создан плагин ' + id + ' → ' + target)
    const nextLines = [
      'Плагин создан в ' + target,
      'Hot-reload watcher подхватит папку автоматически — плагин появится в списке (вкладка «Плагины» / extensions).',
      'Включи его в UI (toggle) — при первом включении покажется consent-диалог прав.',
      'Правь код — плагин перезапускается сам (fs.watch, дебаунс 800мс).',
    ]
    if (runtime === 'python') {
      nextLines.push(
        'Это Python-плагин: нужен установленный Python 3.8+ (детект: python → python3 → py -3; override через runtimePath или SYNTEE_PYTHON).',
        manifest.requirements
          ? 'Зависимости (' + manifest.requirements.join(', ') + ') установятся автоматически при первом запуске (pip); статус и кнопка установки — в карточке плагина.'
          : 'Зависимости не объявлены; добавь requirements: [...] в plugin.json при необходимости.',
        'UI-панели (withUi) для Python-плагинов пока не генерируются — логика в dist/main.py.',
      )
    }
    return {
      ok: true,
      dir: target,
      manifest,
      next: nextLines.join('\n'),
    }
  }

  syntee.registerTool({
    name: 'create_plugin',
    description:
      'Создаёт новый плагин SynteeHelper в {userData}/plugins. ' +
      'runtime:"node" (по умолчанию): structure:"multi" (рекомендуется для всего кроме тривиальных) — многофайловая архитектура dist/index.js + tools.js + commands.js + state.js (+ ui.js и ui/ при withUi); structure:"single" — всё в одном index.js. ' +
      'runtime:"python" — логика на Python (dist/main.py, SDK from syntee import syntee; нужен Python 3.8+, зависимости из requirements ставятся автоматически). ' +
      'Параметры: id (обязательно, [a-zA-Z][a-zA-Z0-9_-]*), runtime ("node"|"python"), structure ("single"|"multi", только для node), name, description, promptDescription (~200 символов), permissions (массив из секции permissions доков), ' +
      'tools: [{name, description, parameters(JSON Schema)}], commands: [{name, description}], requirements: [pip-спецификации, только python], withUi: bool, config: [{key,label,type,default}], overwrite: bool. ' +
      'Перед созданием сложного плагина прочитай plugin_docs(section=architecture), для Python — section=runtimes.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id плагина = имя папки' },
        runtime: {
          type: 'string',
          enum: ['node', 'python'],
          description: 'Рантайм логики: node (JS/CJS, по умолчанию) или python (sidecar-процесс, SDK from syntee import syntee)',
        },
        structure: {
          type: 'string',
          enum: ['single', 'multi'],
          description: 'Архитектура node-плагина: multi (рекомендуется) — модули по файлам; single — всё в index.js',
        },
        name: { type: 'string', description: 'Отображаемое имя' },
        description: { type: 'string', description: 'Описание для UI' },
        promptDescription: { type: 'string', description: 'Короткое описание для system prompt (~200 симв.)' },
        permissions: { type: 'array', items: { type: 'string' }, description: 'Права из plugin_docs(section=permissions)' },
        requirements: {
          type: 'array',
          items: { type: 'string' },
          description: 'Python-зависимости (pip-спецификации: "requests", "rich>=13"). Только при runtime:"python"; ставятся автоматически при первом запуске',
        },
        tools: {
          type: 'array',
          description: 'Тулы для регистрации в шаблоне',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              parameters: { type: 'object', description: 'JSON Schema параметров' },
            },
            required: ['name'],
          },
        },
        commands: {
          type: 'array',
          description: 'Слэш-команды для регистрации в шаблоне',
          items: {
            type: 'object',
            properties: { name: { type: 'string' }, description: { type: 'string' } },
            required: ['name'],
          },
        },
        withUi: { type: 'boolean', description: 'Сгенерировать UI-панель (ui/panel.html + registerPanel)' },
        config: { type: 'array', 'description': 'Схема настроек (форма в карточке плагина)' },
        overwrite: { type: 'boolean', description: 'Заменить существующий плагин с этим id' },
        version: { type: 'string' },
        author: { type: 'string' },
      },
      required: ['id'],
    },
    handler: async (args) => {
      const res = await createPlugin(args)
      return res.next + '\n\nПапка: ' + res.dir
    },
  })

  syntee.registerTool({
    name: 'delete_plugin',
    description: 'Удаляет плагин из {userData}/plugins (папку целиком). Встроенные плагины удалить нельзя.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id плагина' },
        confirm: { type: 'boolean', description: 'Должно быть true — защита от случайного вызова' },
      },
      required: ['id', 'confirm'],
    },
    handler: async (args) => {
      if (args.confirm !== true) return 'Передай confirm: true для удаления'
      const id = String(args.id || '')
      if (!/^[a-zA-Z][\w-]*$/.test(id)) return 'Некорректный id'
      if (id === 'plugin-dev') return 'plugin-dev — встроенный плагин, удаление запрещено'
      const manifest = await readManifestOf(id)
      if (manifest && manifest.builtin) return id + ' — встроенный плагин, удаление запрещено'
      const dir = path.join(pluginsDir, id)
      const st = await syntee.fs.stat(dir)
      if (!st.exists) return 'Плагин не найден: ' + id
      await syntee.fs.delete(dir)
      syntee.log('удалён плагин ' + id)
      return 'Плагин ' + id + ' удалён. Список в UI обновится автоматически.'
    },
  })

  // ── Слэш-команда /plugin_dev ────────────────────────────────────────────
  syntee.registerCommand({
    name: 'plugin_dev',
    description: 'Открыть студию разработки плагинов (доки + мастер)',
    icon: 'puzzle',
    handler: async () => {
      syntee.ui.openModal({ title: 'Plugin Dev — студия плагинов' })
      return 'Студия открыта. Документация для AI — тул plugin_docs.'
    },
  })

  // ── UI: правая панель (браузер доков + мастер) ──────────────────────────
  syntee.registerPanel({
    id: 'plugin-dev',
    slot: 'right',
    title: 'Plugin Dev',
    icon: 'puzzle',
    entry: 'ui/index.html',
  })

  // RPC из iframe-панели.
  syntee.ui.handle('listDocs', async () => DOCS)
  syntee.ui.handle('getDoc', async (args) => readDoc(args.section))
  syntee.ui.handle('createPlugin', async (args) => createPlugin(args))
  syntee.ui.handle('listPlugins', async () => {
    const ids = (await syntee.fs.listDir(pluginsDir)).filter(e => /^[a-zA-Z][\w-]*$/.test(e))
    const out = []
    for (const id of ids) {
      const m = await readManifestOf(id)
      if (m) out.push({ id, name: m.name, version: m.version, builtin: !!m.builtin, description: m.description || '' })
    }
    return out
  })
  syntee.ui.handle('readPlugin', async (args) => {
    const m = await readManifestOf(String(args.id || ''))
    return m ? JSON.stringify(m, null, 2) : null
  })

  syntee.log('Plugin Dev активирован. Доки: ' + DOCS.length + ' секций. Папка плагинов: ' + pluginsDir)
}

module.exports.deactivate = function () {
  // Ничего не чистим: процессы/таймеры не создаём.
}
