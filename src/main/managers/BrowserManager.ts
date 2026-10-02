// ── BrowserManager: встроенный браузер (webview в правой панели) ──────────
//
// Архитектура (см. план 02.10.2026):
//  • Renderer (BrowserPanel) хостит <webview>-элементы — они в DOM, поэтому
//    весь React-UI (меню/модалки/поповеры) рендерится ПОВЕРХ браузера
//    нативно, без overlay-костылей WebContentsView.
//  • Регистрация: renderer при did-attach/webview-событиях шлёт
//    browser:registerTab {tabId, webContentsId} — менеджер держит реестр.
//  • ВЕСЬ контроль (AI-тулы + UI-навигация) идёт из main через
//    webContents.fromId(webContentsId): executeJavaScript (снапшот),
//    sendInputEvent (trusted-клики — сайты считают их реальным вводом),
//    capturePage (скриншоты). Renderer в операциях не участвует.
//  • AI-раунд-трип: worker → postMessage 'browser_op' → execute() →
//    'browser_op_reply' (паттерн manage_dots).
//  • request_access: AI просит включить browser_mode → AgentConfirmDialog
//    (переиспользуем существующий confirm-пайплайн agent:confirm) →
//    setChatBrowserMode → event BROWSER_MODE_CHANGED → worker мутирует
//    тулсет рана (browser-тулы появляются со следующего раунда).
//
// A11y-снапшот: инжект в страницу через executeJavaScript — DOM-обходчик
// строит YAML-дерево с ref'ами (паттерн Playwright MCP). Элементы хранятся
// в window.__syntee_refs (Map) в контексте страницы — умирают при навигации,
// модель обязана ре-снапшотиться после перехода.

import { ipcMain, webContents, session, app, dialog, BrowserWindow } from 'electron'
import { join } from 'path'
import { log } from '../../core/logger'
import { BROWSER_PARTITION, IPC_EVENTS } from '../../shared/constants'
import { getChatBrowserMode, setChatBrowserMode } from '../../core/db/chats'

/** Таб браузера в реестре менеджера. */
export interface BrowserTabEntry {
  tabId: string
  webContentsId: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  favicon?: string
}

/** Ответ browser_op для воркера (см. ai-worker.ts onBrowserAction). */
export interface BrowserOpResult {
  success: boolean
  output?: string
  error?: string
  /** request_access: подтверждено ли включение. */
  enabled?: boolean
  /** screenshot: base64 PNG (без data:-префикса) для vision-модели. */
  imageBase64?: string
}

/** Параметры browser_op из воркера. */
export interface BrowserOpPayload {
  action: string
  url?: string
  ref?: string
  text?: string
  submit?: boolean
  key?: string
  direction?: 'up' | 'down'
  amount?: number
  tabId?: string
  reason?: string
  ms?: number
}

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

class BrowserManagerImpl {
  private tabs = new Map<string, BrowserTabEntry>()
  private win: BrowserWindow | null = null
  /** Ленивый геттер окна: главное окно создаётся ПОСЛЕ регистрации IPC
   *  (main/index.ts: mainWindow.create() в конце whenReady). Eager
   *  setWindow(mainWindow.getWindow()) до create() передавал null НАВСЕГДА —
   *  pushTabState молча уходил в no-op, рендерер не получал состояние табов,
   *  webview не создавался (белый экран). Геттер решает на каждом вызове. */
  private winGetter: (() => BrowserWindow | null) | null = null
  /** Log-once: push пропущен из-за отсутствия окна (диагностика регрессий). */
  private pushSkipLogged = false

  /** @deprecated окно создаётся позже — использовать setWindowGetter. */
  setWindow(win: BrowserWindow | null): void {
    this.win = win
  }

  setWindowGetter(getter: () => BrowserWindow | null): void {
    this.winGetter = getter
  }

  /** Актуальное окно: приоритет — ленивый геттер (живое значение), fallback —
   *  setWindow (для тестов/явной установки). */
  private getWin(): BrowserWindow | null {
    if (this.winGetter) {
      try {
        const w = this.winGetter()
        if (w) return w
      } catch { /* fallthrough → this.win */ }
    }
    return this.win
  }

  /** Сессия браузера: персистентная, отдельная от сессии приложения.
   *  Расширения грузятся в неё; webview с partition=BROWSER_PARTITION
   *  автоматически подхватывает. Chrome-подобный UA — для сайтов и для
   *  скачивания CRX из Chrome Web Store. */
  getSession(): Electron.Session {
    const ses = session.fromPartition(BROWSER_PARTITION)
    if (!(ses as unknown as { __synteeUaSet?: boolean }).__synteeUaSet) {
      try { ses.setUserAgent(CHROME_UA) } catch { /* ok */ }
      ;(ses as unknown as { __synteeUaSet?: boolean }).__synteeUaSet = true
      this.attachSessionListeners(ses)
    }
    return ses
  }

  /** Скачивания: диалог сохранения (всегда — файлы из браузера не льём
   *  молча на диск) + тост-уведомление о результате. */
  private attachSessionListeners(ses: Electron.Session): void {
    ses.on('will-download', (_event, item) => {
      try {
        const downloadsDir = app.getPath('downloads')
        const defaultPath = join(downloadsDir, item.getFilename())
        // savePath = путь диалога; юзер может отменить → item.cancel().
        const showSave = this.getWin() && !this.getWin()?.isDestroyed()
          ? dialog.showSaveDialog(this.getWin()!, { title: 'Сохранить файл', defaultPath })
          : dialog.showSaveDialog({ title: 'Сохранить файл', defaultPath })
        void showSave.then(result => {
          if (result.canceled || !result.filePath) {
            item.cancel()
            return
          }
          item.setSavePath(result.filePath)
          item.once('done', (_e, state) => {
            const ok = state === 'completed'
            this.win?.webContents.send('plugins:toast', {
              text: ok ? `Файл сохранён: ${result.filePath}` : `Скачивание ${state === 'cancelled' ? 'отменено' : 'прервано'}`,
              kind: ok ? 'success' : 'error',
            })
          })
        })
      } catch (e) {
        log('[browser] will-download failed: %s', (e as Error).message)
        item.cancel()
      }
    })
  }

  // ── Реестр табов ────────────────────────────────────────────────────────

  registerTab(tabId: string, webContentsId: number): void {
    const prev = this.tabs.get(tabId)
    if (prev && prev.webContentsId === webContentsId) {
      this.updateTab(tabId, { loading: false })
      return
    }
    // webContentsId мог смениться (webview пересоздан) — перевешиваем.
    this.tabs.set(tabId, {
      tabId,
      webContentsId,
      url: prev?.url ?? 'about:blank',
      title: prev?.title ?? 'Новая вкладка',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    })
    this.attachGuestListeners(tabId, webContentsId)
    log('[browser] registerTab tabId=%s wcId=%d (total %d)', tabId, webContentsId, this.tabs.size)
    this.pushTabState()
  }

  unregisterTab(tabId: string): void {
    if (this.tabs.delete(tabId)) {
      // Закрыли активный — активируем первый оставшийся (иначе все webview
      // получают display:none → белый экран).
      if (this.activeTabId === tabId) {
        this.activeTabId = this.getTabs()[0]?.tabId ?? null
      }
      log('[browser] unregisterTab tabId=%s (total %d)', tabId, this.tabs.size)
      this.pushTabState()
    }
  }

  updateTab(tabId: string, patch: Partial<BrowserTabEntry>): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    Object.assign(t, patch)
    this.pushTabState()
  }

  getTabs(): BrowserTabEntry[] {
    return Array.from(this.tabs.values())
  }

  /** Активный таб — первый в реестре (renderer шлёт registerTab для
   *  активного последним; активность трекается через tab_select). */
  private activeTab(): BrowserTabEntry | null {
    if (this.activeTabId) return this.tabs.get(this.activeTabId) ?? null
    const first = this.getTabs()[0]
    return first ?? null
  }

  private activeTabId: string | null = null

  setActiveTab(tabId: string): void {
    this.activeTabId = tabId
    this.pushTabState()
  }

  private wc(tabId?: string): Electron.WebContents | null {
    const id = tabId ?? this.activeTabId ?? undefined
    const entry = id ? this.tabs.get(id) : this.activeTab()
    if (!entry) return null
    try {
      const wc = webContents.fromId(entry.webContentsId)
      if (!wc || wc.isDestroyed()) return null
      return wc
    } catch {
      return null
    }
  }

  /** Push состояния табов в renderer (BrowserPanel). */
  private pushTabState(): void {
    const win = this.getWin()
    if (!win || win.isDestroyed()) {
      if (!this.pushSkipLogged) {
        this.pushSkipLogged = true
        log('[browser] pushTabState SKIPPED: no live window (getter=%s, eager=%s) — renderer не получит состояние табов',
          this.winGetter ? 'set' : 'none', this.win ? 'set' : 'null')
      }
      return
    }
    win.webContents.send(IPC_EVENTS.BROWSER_TAB_STATE, {
      tabs: this.getTabs(),
      activeTabId: this.activeTabId,
    })
  }

  /** Слушатели событий guest webContents → обновление реестра. */
  private attachGuestListeners(tabId: string, webContentsId: number): void {
    try {
      const wc = webContents.fromId(webContentsId)
      if (!wc || wc.isDestroyed()) return

      // Не тормозить таймеры страницы, когда панель скрыта (keep-alive прячет
      // через display:none) — AI-действия должны работать в фоне.
      try { wc.setBackgroundThrottling(false) } catch { /* ok */ }

      // window.open / target=_blank → новый таб панели, не попап.
      wc.setWindowOpenHandler(({ url }) => {
        this.newTab(url)
        return { action: 'deny' }
      })

      wc.on('did-start-loading', () => this.updateTab(tabId, { loading: true }))
      wc.on('did-stop-loading', () => {
        const entry = this.tabs.get(tabId)
        // Electron 44: canGoBack/canGoForward deprecated → navigationHistory.
        this.updateTab(tabId, {
          loading: false,
          canGoBack: safe(() => wc.navigationHistory.canGoBack()) ?? false,
          canGoForward: safe(() => wc.navigationHistory.canGoForward()) ?? false,
          url: safe(() => wc.getURL()) ?? entry?.url ?? 'about:blank',
        })
      })
      wc.on('did-navigate', (_e, url) => this.updateTab(tabId, { url }))
      wc.on('did-navigate-in-page', (_e, url) => this.updateTab(tabId, { url }))
      wc.on('page-title-updated', (_e, title) => this.updateTab(tabId, { title }))
      wc.on('page-favicon-updated', (_e, icons) => {
        const favicon = icons?.[icons.length - 1]
        if (favicon) this.updateTab(tabId, { favicon })
      })
    } catch (e) {
      log('[browser] attachGuestListeners failed: %s', (e as Error).message)
    }
  }

  // ── UI-операции (из renderer через browser.ipc) ─────────────────────────

  navigate(tabId: string, url: string): void {
    const target = normalizeUrl(url)
    const wc = this.wc(tabId)
    if (wc) {
      // Таб attached — навигация напрямую из main. НЕ пушим url в updateTab:
      // push → renderer обновит src-атрибут webview → двойная навигация
      // (loadURL + src-mutation) → GUEST_VIEW_MANAGER_CALL error у проигравшей.
      // url придёт из did-navigate-листенера (attachGuestListeners).
      this.updateTab(tabId, { loading: true })
      wc.loadURL(target).catch(err => {
        log('[browser] navigate failed: %s', (err as Error).message)
        this.updateTab(tabId, { loading: false })
      })
    } else {
      // Таб ещё не attached (webContentsId=-1, guest не создан): обновляем
      // url в реестре + push → renderer обновит src-атрибут webview —
      // Electron наблюдает изменение src и навигирует (MutationObserver
      // в webview-impl). Иначе navigate был бы тихим no-op.
      this.updateTab(tabId, { url: target, loading: true, title: 'Загрузка…' })
    }
  }

  goBack(tabId: string): void { this.wc(tabId)?.goBack() }
  goForward(tabId: string): void { this.wc(tabId)?.goForward() }
  reload(tabId: string): void { this.wc(tabId)?.reload() }

  newTab(url?: string): string {
    const tabId = `bt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    // Таб создаётся в renderer (webview-элемент); здесь — только запись в
    // реестре-заготовке. Renderer при did-attach вызовет registerTab с этим
    // tabId. URL применяется через атрибут src webview — поэтому стартовый
    // таб БЕЗ url получает дефолтную страницу (webview без src не создаёт
    // guest-процесс вообще — dom-ready не стреляет, белый экран).
    this.tabs.set(tabId, {
      tabId,
      webContentsId: -1, // до did-attach
      url: url ? normalizeUrl(url) : 'https://www.google.com',
      title: url ? 'Загрузка…' : 'Новая вкладка',
      loading: true,
      canGoBack: false,
      canGoForward: false,
    })
    if (!this.activeTabId) this.activeTabId = tabId
    this.pushTabState()
    return tabId
  }

  /** Активный таб (null если табов нет). */
  getActiveTabId(): string | null {
    return this.activeTabId
  }

  // ── AI-операции (browser_op из воркера) ─────────────────────────────────

  /** Главная точка входа AI-операций. Гейтинг по browserMode чата. */
  async execute(chatId: string, p: BrowserOpPayload): Promise<BrowserOpResult> {
    // request_access доступен всегда — это и есть путь включения.
    if (p.action === 'request_access') return this.handleRequestAccess(chatId, p.reason)

    const enabled = chatId ? getChatBrowserMode(chatId) : false
    if (!enabled) {
      return {
        success: false,
        error:
          'Browser control is disabled for this chat. Call request_access (capability: browser_control) with a reason to ask the user to enable it.',
      }
    }

    try {
      switch (p.action) {
        case 'navigate':       return await this.opNavigate(p.url)
        case 'back':           return this.opHistory('back')
        case 'forward':        return this.opHistory('forward')
        case 'reload':         return this.opReload()
        case 'snapshot':       return await this.opSnapshot()
        case 'click':          return await this.opClick(chatId, p.ref)
        case 'type':           return await this.opType(p.ref, p.text, p.submit)
        case 'press_key':      return await this.opPressKey(p.key)
        case 'scroll':         return await this.opScroll(p.direction, p.amount)
        case 'screenshot':     return await this.opScreenshot()
        case 'tabs':           return this.opTabsList()
        case 'tab_new':        return this.opTabNew(p.url)
        case 'tab_select':     return this.opTabSelect(p.tabId)
        case 'tab_close':      return this.opTabClose(p.tabId)
        case 'wait':           return await this.opWait(p.ms)
        default:
          return { success: false, error: `Unknown browser action: ${p.action}` }
      }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  // ── request_access: confirm через AgentConfirmDialog ────────────────────

  private async handleRequestAccess(chatId: string, reason?: string): Promise<BrowserOpResult> {
    if (!chatId) return { success: false, error: 'request_access: no chat context' }
    if (getChatBrowserMode(chatId)) {
      return { success: true, enabled: true, output: 'Browser control is already enabled for this chat.' }
    }

    const approved = await this.confirmBrowserAction(
      chatId,
      'request_access',
      { capability: 'browser_control', reason: reason ?? '' },
      'AI просит включить управление браузером для этой задачи. Включить?',
    )

    if (approved) {
      try { setChatBrowserMode(chatId, true) } catch { /* ok */ }
      // Синк UI: чип в StatusRow + тумблер в плюс-меню.
      const win = this.getWin()
      win?.webContents.send(IPC_EVENTS.BROWSER_MODE_CHANGED, { chatId, enabled: true })
      return {
        success: true,
        enabled: true,
        output: 'Browser control ENABLED. The browser_* tools are now available — use them immediately to continue the task.',
      }
    }
    return {
      success: true,
      enabled: false,
      output: 'The user declined browser control. Continue without browser tools.',
    }
  }

  // ── Реализации AI-операций ──────────────────────────────────────────────

  private async opNavigate(url?: string): Promise<BrowserOpResult> {
    if (!url) return { success: false, error: 'navigate: url is required' }
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available. Open the Browser panel (right panel) first.' }
    const target = normalizeUrl(url)
    try {
      await wc.loadURL(target)
      // Ждём dom-ready-ish: loadURL резолвится на did-finish-load.
      const title = safe(() => wc.getURL()) === target ? safe(() => wc.getTitle()) : target
      return { success: true, output: `Navigated to ${target}${title ? ` — ${title}` : ''}. Page refs from previous snapshots are gone — take a new snapshot before interacting.` }
    } catch (e) {
      return { success: false, error: `Navigation failed: ${(e as Error).message}` }
    }
  }

  private opHistory(dir: 'back' | 'forward'): BrowserOpResult {
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available.' }
    if (dir === 'back') { if (!wc.canGoBack()) return { success: false, error: 'Cannot go back: no history.' }; wc.goBack() }
    else { if (!wc.canGoForward()) return { success: false, error: 'Cannot go forward: no history.' }; wc.goForward() }
    return { success: true, output: `Went ${dir}. Refs are gone — take a new snapshot.` }
  }

  private opReload(): BrowserOpResult {
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available.' }
    wc.reload()
    return { success: true, output: 'Page reloaded. Refs are gone — take a new snapshot.' }
  }

  private async opSnapshot(): Promise<BrowserOpResult> {
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available. Open the Browser panel first.' }
    const tree = await wc.executeJavaScript(SNAPSHOT_SCRIPT, false)
    if (typeof tree !== 'string' || !tree) {
      return { success: false, error: 'Snapshot failed: the page did not return an accessibility tree.' }
    }
    const url = safe(() => wc.getURL()) ?? ''
    const title = safe(() => wc.getTitle()) ?? ''
    return { success: true, output: `Page: ${title}\nURL: ${url}\n\n${tree}` }
  }

  private async opClick(chatId: string, ref?: string): Promise<BrowserOpResult> {
    if (!ref) return { success: false, error: 'click: ref is required (take a snapshot first)' }
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available.' }
    const rect = await this.getRefRect(wc, ref)
    if (!rect) return { success: false, error: `Element [ref=${ref}] not found. The page may have navigated — take a new snapshot.` }

    // Опасный клик (отправка формы) → подтверждение юзера (AgentConfirmDialog).
    if (chatId) {
      const isSubmit = await this.isSubmitLike(wc, ref)
      if (isSubmit) {
        const approved = await this.confirmBrowserAction(
          chatId,
          'browser_click',
          { ref, action: 'submit form' },
          'Модель хочет отправить форму на странице. Разрешить?',
        )
        if (!approved) {
          return { success: true, output: 'The user declined the form submission. Do not retry this click unless the user asks.' }
        }
      }
    }

    const cx = Math.round(rect.x + rect.width / 2)
    const cy = Math.round(rect.y + rect.height / 2)
    // Trusted-клик: sendInputEvent генерирует isTrusted-события — сайты
    // принимают их как реальный ввод пользователя (в отличие от dispatchEvent).
    wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy })
    wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
    return { success: true, output: `Clicked [ref=${ref}] at (${cx}, ${cy}).` }
  }

  /** Похоже ли элемент на отправку формы (submit-кнопка / кнопка в форме). */
  private async isSubmitLike(wc: Electron.WebContents, ref: string): Promise<boolean> {
    try {
      const r = await wc.executeJavaScript(
        `(() => { const el = (window.__syntee_refs && window.__syntee_refs.get(${JSON.stringify(ref)})); if (!el) return false;
          const tag = el.tagName;
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (tag === 'INPUT' && ['submit', 'button'].includes(type)) return !!el.closest('form');
          if (tag === 'BUTTON') {
            if (type === 'submit') return true;
            if (!type && el.closest('form')) return true;
          }
          return false; })()`,
        false,
      )
      return r === true
    } catch {
      return false
    }
  }

  /** Универсальный confirm через AgentConfirmDialog (переиспользуем
   *  существующий пайплайн agent:confirm). Возвращает approved. */
  private confirmBrowserAction(
    chatId: string,
    toolName: string,
    args: Record<string, unknown>,
    title: string,
  ): Promise<boolean> {
    return new Promise(resolve => {
      const win = this.getWin()
      if (!win || win.isDestroyed()) return resolve(false)
      const reqId = `browser-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      let settled = false
      const finish = (approved: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(approved)
      }
      const timer = setTimeout(() => finish(false), 90_000)
      if (typeof timer.unref === 'function') timer.unref()
      ipcMain.once(`agent:confirm:response:${reqId}`, (_e, approved: boolean) => finish(!!approved))
      win.webContents.send('agent:confirm', {
        reqId,
        toolName,
        args: { ...args, _title: title, chatId },
        dangerLevel: 'warn',
      })
      void chatId
    })
  }

  private async opType(ref?: string, text?: string, submit?: boolean): Promise<BrowserOpResult> {
    if (!ref) return { success: false, error: 'type: ref is required (take a snapshot first)' }
    if (text === undefined) return { success: false, error: 'type: text is required' }
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available.' }
    // Фокус на элемент (trusted-клик), затем insertText (как Input.insertText
    // в Playwright — вставка текста целиком, триггерит input-события).
    const rect = await this.getRefRect(wc, ref)
    if (!rect) return { success: false, error: `Element [ref=${ref}] not found. Take a new snapshot.` }
    const cx = Math.round(rect.x + rect.width / 2)
    const cy = Math.round(rect.y + rect.height / 2)
    wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy })
    wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
    await sleep(60)
    wc.insertText(text)
    if (submit) {
      await sleep(60)
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      wc.sendInputEvent({ type: 'char', keyCode: 'Enter' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      return { success: true, output: `Typed into [ref=${ref}] and pressed Enter. Refs may be gone after navigation — take a new snapshot.` }
    }
    return { success: true, output: `Typed "${text.slice(0, 80)}"${text.length > 80 ? '…' : ''} into [ref=${ref}].` }
  }

  private async opPressKey(key?: string): Promise<BrowserOpResult> {
    if (!key) return { success: false, error: 'press_key: key is required' }
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available.' }
    wc.sendInputEvent({ type: 'keyDown', keyCode: key })
    wc.sendInputEvent({ type: 'char', keyCode: key })
    wc.sendInputEvent({ type: 'keyUp', keyCode: key })
    return { success: true, output: `Pressed key: ${key}.` }
  }

  private async opScroll(direction?: 'up' | 'down', amount?: number): Promise<BrowserOpResult> {
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available.' }
    const dy = direction === 'up' ? -(amount ?? 600) : (amount ?? 600)
    wc.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaY: dy })
    return { success: true, output: `Scrolled ${direction ?? 'down'} by ${Math.abs(dy)}px.` }
  }

  private async opScreenshot(): Promise<BrowserOpResult> {
    const wc = this.wc()
    if (!wc) return { success: false, error: 'No browser tab available.' }
    try {
      const image = await wc.capturePage()
      if (image.isEmpty()) {
        return { success: false, error: 'Screenshot failed: the page is not visible (browser panel hidden?). Open the Browser panel and retry.' }
      }
      const base64 = image.toPNG().toString('base64')
      return {
        success: true,
        imageBase64: base64,
        output: `Screenshot captured (${Math.round(base64.length * 0.75 / 1024)} KB PNG).`,
      }
    } catch (e) {
      return { success: false, error: `Screenshot failed: ${(e as Error).message}` }
    }
  }

  private opTabsList(): BrowserOpResult {
    const tabs = this.getTabs().map((t, i) =>
      `${i + 1}. [${t.tabId}]${t.tabId === this.activeTabId ? ' (active)' : ''} ${t.title} — ${t.url}`
    )
    if (tabs.length === 0) return { success: false, error: 'No browser tabs open. Open the Browser panel (right panel) first.' }
    return { success: true, output: `Browser tabs (${tabs.length}):\n${tabs.join('\n')}` }
  }

  private opTabNew(url?: string): BrowserOpResult {
    const tabId = this.newTab(url)
    // Renderer создаст webview по pushTabState и зарегистрирует его.
    return { success: true, output: `New browser tab [${tabId}] opening${url ? ` at ${normalizeUrl(url)}` : ''}. Wait a moment, then use tab_select + snapshot.` }
  }

  private opTabSelect(tabId?: string): BrowserOpResult {
    if (!tabId) return { success: false, error: 'tab_select: tab_id is required (see tabs list)' }
    if (!this.tabs.has(tabId)) return { success: false, error: `Tab ${tabId} not found. Use tabs to list open tabs.` }
    this.setActiveTab(tabId)
    // Renderer переключит видимость webview по pushTabState.
    return { success: true, output: `Switched to tab [${tabId}]. Take a snapshot to see its content.` }
  }

  private opTabClose(tabId?: string): BrowserOpResult {
    if (!tabId) return { success: false, error: 'tab_close: tab_id is required' }
    if (!this.tabs.has(tabId)) return { success: false, error: `Tab ${tabId} not found.` }
    this.unregisterTab(tabId)
    return { success: true, output: `Closed tab [${tabId}].` }
  }

  private async opWait(ms?: number): Promise<BrowserOpResult> {
    const t = Math.min(Math.max(ms ?? 1000, 100), 10_000)
    await sleep(t)
    return { success: true, output: `Waited ${t}ms.` }
  }

  /** Прямоугольник элемента по ref (getBoundingClientRect в контексте страницы). */
  private async getRefRect(wc: Electron.WebContents, ref: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    try {
      const r = await wc.executeJavaScript(
        `(() => { const el = (window.__syntee_refs && window.__syntee_refs.get(${JSON.stringify(ref)})); if (!el || !el.isConnected) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
        false,
      )
      if (!r || typeof r.x !== 'number' || r.width === 0 || r.height === 0) return null
      return r
    } catch {
      return null
    }
  }
}

export const browserManager = new BrowserManagerImpl()

// ── Утилиты ───────────────────────────────────────────────────────────────

function normalizeUrl(input: string): string {
  const s = input.trim()
  if (/^(https?|file|about|chrome|data):/i.test(s)) return s
  // Без схемы: если похоже на домен — https, иначе поиск в Google.
  if (/^[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function safe<T>(fn: () => T): T | null {
  try { return fn() } catch { return null }
}

// ── Снапшот-скрипт: a11y-дерево с ref'ами (Playwright MCP-style) ──────────
//
// Инжектится через executeJavaScript. Обходит видимые интерактивные и
// структурные элементы, строит YAML-подобное дерево, складывает элементы
// в window.__syntee_refs (Map<string, Element>). Ref'ы живут до навигации.
const SNAPSHOT_SCRIPT = String.raw`
(() => {
  const refs = window.__syntee_refs || (window.__syntee_refs = new Map());
  refs.clear();
  let counter = 0;
  const lines = [];

  const INTERACTIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS']);
  const HEADING = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

  function roleOf(el) {
    const t = el.tagName;
    const aria = el.getAttribute('role');
    if (aria) return aria;
    if (t === 'A') return el.getAttribute('href') ? 'link' : 'generic';
    if (t === 'BUTTON') return 'button';
    if (t === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'password') return 'textbox';
      return 'textbox';
    }
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'IMG') return 'img';
    if (HEADING.has(t)) return 'heading';
    if (t === 'TABLE') return 'table';
    if (t === 'UL' || t === 'OL') return 'list';
    if (t === 'LI') return 'listitem';
    if (t === 'DETAILS') return 'group';
    return null;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    if (el.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes((el.getAttribute('type') || 'text').toLowerCase())) {
      const ph = el.getAttribute('placeholder');
      const lbl = el.labels && el.labels[0] ? el.labels[0].textContent : null;
      return lbl || ph || '';
    }
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return txt.length > 80 ? txt.slice(0, 77) + '…' : txt;
  }

  function visible(el) {
    const s = window.getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    return true;
  }

  function walk(el, depth) {
    for (const child of el.children) {
      const tag = child.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG' || tag === 'PATH') continue;
      if (!visible(child)) continue;

      const role = roleOf(child);
      const name = nameOf(child);
      let ref = null;

      if (role && (INTERACTIVE.has(tag) || ['link', 'button', 'textbox', 'combobox', 'checkbox', 'radio', 'menuitem', 'tab', 'option', 'switch'].includes(role))) {
        counter += 1;
        ref = 'e' + counter;
        refs.set(ref, child);
      }

      const indent = '  '.repeat(depth);
      let line = indent + '- ' + (role || tag.toLowerCase());
      if (name) line += ' "' + name.replace(/"/g, "'") + '"';
      const href = child.getAttribute && child.getAttribute('href');
      if (href && href.length < 60) line += ' [href=' + href + ']';
      if (child.tagName === 'INPUT') {
        const type = (child.getAttribute('type') || 'text').toLowerCase();
        line += ' [type=' + type + ']';
        if (child.value) line += ' [value="' + String(child.value).slice(0, 40) + '"]';
      }
      if (child.tagName === 'SELECT') {
        const opts = Array.from(child.options).slice(0, 8).map(o => o.value || o.textContent.trim()).filter(Boolean);
        if (opts.length) line += ' [options=' + opts.join('|') + ']';
      }
      if (ref) line += ' [ref=' + ref + ']';
      lines.push(line);

      // Рекурсия ограничена: гигантские DOM не рвём — глубина 12, узлов 1200.
      if (depth < 12 && lines.length < 1200) walk(child, depth + 1);
    }
  }

  walk(document.body, 0);
  return lines.join('\n');
})()
`
