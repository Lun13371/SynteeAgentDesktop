/**
 * Авторизация ChatGPT-подписки (Codex).
 *
 * Два входа:
 *  1. Браузерный OAuth (PKCE, как Codex CLI / OpenCode) — кнопка «Войти через ChatGPT».
 *  2. Импорт уже сохранённого логина из `~/.codex/auth.json` (Codex CLI / ChatGPT app).
 *
 * Токены лежат в отдельном electron-store `codex-auth` и шифруются через
 * safeStorage (DPAPI на Windows) — как в tokenStore.ts для Syntee-Gateway.
 *
 * Запросы к моделям идут НЕ на api.openai.com, а на бэкенд ChatGPT:
 *   POST https://chatgpt.com/backend-api/codex/responses
 * с заголовками Authorization / chatgpt-account-id / originator и store:false.
 */
import Store from 'electron-store'
import { safeStorage } from 'electron'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelCapability, ModelMeta } from '../../shared/types'

// ── Константы (из openai/codex — публичный client_id CLI) ──────────────────
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
export const CODEX_SCOPE = 'openid profile email offline_access'
/** Allow-list redirect-портов Codex CLI: 1455 основной, 1457 запасной. */
export const CODEX_CALLBACK_PORT = 1455
export const CODEX_FALLBACK_PORT = 1457
export const CODEX_CALLBACK_PATH = '/auth/callback'
/** База бэкенда ChatGPT; OpenAI SDK добавляет `/responses`. */
export const CODEX_API_BASE = 'https://chatgpt.com/backend-api/codex'
/** Заглушка вместо API-ключа: SDK требует непустую строку, авторизация идёт токеном. */
export const CODEX_DUMMY_KEY = 'chatgpt-oauth'
/** JWT-claim, в котором лежит account id и тип подписки. */
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

export interface CodexAuthState {
  connected: boolean
  source: 'oauth' | 'import' | null
  email: string | null
  plan: string | null
  accountId: string | null
  /** ms epoch, когда истекает access-токен (по exp из JWT). */
  expiresAt: number | null
  lastLoginAt: string | null
}

interface StoredCodexAuth {
  encAccess: string | null
  encRefresh: string | null
  encIdToken: string | null
  accountId: string | null
  email: string | null
  plan: string | null
  expiresAt: number | null
  source: 'oauth' | 'import' | null
  lastLoginAt: string | null
}

// ── Хранилище ──────────────────────────────────────────────────────────────
let _store: Store<StoredCodexAuth> | null = null
function store(): Store<StoredCodexAuth> {
  if (!_store) {
    _store = new Store<StoredCodexAuth>({
      name: 'codex-auth',
      defaults: {
        encAccess: null, encRefresh: null, encIdToken: null,
        accountId: null, email: null, plan: null, expiresAt: null,
        source: null, lastLoginAt: null,
      },
    })
  }
  return _store
}

function canEncrypt(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function encrypt(plain: string): string {
  if (!canEncrypt()) return `plain:${plain}`
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(stored: string | null): string | null {
  if (!stored) return null
  if (stored.startsWith('plain:')) return stored.slice('plain:'.length)
  if (!canEncrypt()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

// ── JWT ────────────────────────────────────────────────────────────────────
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

interface TokenFacts {
  accountId: string | null
  plan: string | null
  email: string | null
  expiresAt: number | null
}

/** Достаёт account id / план / email из пары access+id токенов. */
function readTokenFacts(accessToken: string, idToken: string | null, fallbackAccountId?: string | null): TokenFacts {
  const access = decodeJwtPayload(accessToken)
  const id = idToken ? decodeJwtPayload(idToken) : null
  const accessAuth = (access?.[JWT_CLAIM_PATH] ?? {}) as Record<string, unknown>
  const idAuth = (id?.[JWT_CLAIM_PATH] ?? {}) as Record<string, unknown>
  const accountId =
    (typeof accessAuth.chatgpt_account_id === 'string' ? accessAuth.chatgpt_account_id : null)
    ?? (typeof idAuth.chatgpt_account_id === 'string' ? idAuth.chatgpt_account_id : null)
    ?? fallbackAccountId
    ?? null
  const plan =
    (typeof accessAuth.chatgpt_plan_type === 'string' ? accessAuth.chatgpt_plan_type : null)
    ?? (typeof idAuth.chatgpt_plan_type === 'string' ? idAuth.chatgpt_plan_type : null)
    ?? null
  const email =
    (typeof access?.email === 'string' ? access.email : null)
    ?? (typeof id?.email === 'string' ? id.email : null)
  const exp = typeof access?.exp === 'number' ? access.exp * 1000 : null
  return { accountId, plan, email, expiresAt: exp }
}

// ── Публичное состояние ────────────────────────────────────────────────────
export function getCodexAuthState(): CodexAuthState {
  const s = store().store
  return {
    connected: Boolean(s.encAccess),
    source: s.source,
    email: s.email,
    plan: s.plan,
    accountId: s.accountId,
    expiresAt: s.expiresAt,
    lastLoginAt: s.lastLoginAt,
  }
}

export function getCodexAccountId(): string | null {
  return store().get('accountId')
}

/** Сколько секунд осталось до истечения access-токена (null — неизвестно). */
function secondsLeft(expiresAt: number | null): number | null {
  if (!expiresAt) return null
  return Math.round((expiresAt - Date.now()) / 1000)
}

function persistTokens(accessToken: string, refreshToken: string, idToken: string | null, source: 'oauth' | 'import', fallbackAccountId?: string | null): CodexAuthState {
  const facts = readTokenFacts(accessToken, idToken, fallbackAccountId)
  const s = store()
  s.set('encAccess', encrypt(accessToken))
  s.set('encRefresh', encrypt(refreshToken))
  s.set('encIdToken', idToken ? encrypt(idToken) : null)
  s.set('accountId', facts.accountId)
  s.set('plan', facts.plan)
  s.set('email', facts.email)
  s.set('expiresAt', facts.expiresAt)
  s.set('source', source)
  s.set('lastLoginAt', new Date().toISOString())
  return getCodexAuthState()
}

export function logoutCodex(): void {
  const s = store()
  s.set('encAccess', null)
  s.set('encRefresh', null)
  s.set('encIdToken', null)
  s.set('accountId', null)
  s.set('plan', null)
  s.set('email', null)
  s.set('expiresAt', null)
  s.set('source', null)
  s.set('lastLoginAt', null)
}

// ── Refresh ────────────────────────────────────────────────────────────────
let refreshPromise: Promise<string | null> | null = null

async function doRefresh(): Promise<string | null> {
  const refreshToken = decrypt(store().get('encRefresh'))
  if (!refreshToken) return null
  try {
    const res = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[codexAuth] refresh failed:', res.status, text.slice(0, 300))
      // 400/401 означает, что refresh-токен мёртв — логин нужен заново.
      if (res.status === 400 || res.status === 401) logoutCodex()
      return null
    }
    const json = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      id_token?: string
      expires_in?: number
    }
    if (!json.access_token || !json.refresh_token) {
      console.error('[codexAuth] refresh response missing tokens')
      return null
    }
    const idToken = json.id_token ?? decrypt(store().get('encIdToken'))
    persistTokens(json.access_token, json.refresh_token, idToken ?? null, store().get('source') ?? 'oauth', getCodexAccountId())
    return json.access_token
  } catch (error) {
    console.error('[codexAuth] refresh error:', error instanceof Error ? error.message : error)
    return null
  }
}

/** Форс-refresh (после 401 или по кнопке). Параллельные вызовы сливаются. */
export function forceRefreshCodexToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

/**
 * Актуальный access-токен: если по exp осталось меньше 60 секунд —
 * сначала refresh. null означает «нужен повторный вход».
 */
export async function getCodexAccessToken(): Promise<string | null> {
  const accessToken = decrypt(store().get('encAccess'))
  const left = secondsLeft(store().get('expiresAt'))
  if (!accessToken) return null
  if (left === null || left < 60) {
    return (await forceRefreshCodexToken()) ?? accessToken
  }
  return accessToken
}

/** Заголовки бэкенда ChatGPT для Codex-запросов. */
export function getCodexHeaders(token: string): Record<string, string> {
  const accountId = getCodexAccountId()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    originator: 'codex_cli_rs',
    'OpenAI-Beta': 'responses=experimental',
    'session_id': randomBytes(16).toString('hex'),
  }
  if (accountId) headers['chatgpt-account-id'] = accountId
  return headers
}

// ── OAuth: PKCE + локальный callback ──────────────────────────────────────
let pending: { url: string; verifier: string; state: string; server: Server | null; port: number } | null = null

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
  const url = new URL(CODEX_AUTHORIZE_URL)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', CODEX_CLIENT_ID)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', CODEX_SCOPE)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('id_token_add_organizations', 'true')
  url.searchParams.set('codex_cli_simplified_flow', 'true')
  url.searchParams.set('originator', 'codex_cli_rs')
  return url.toString()
}

const SUCCESS_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Готово</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0f1115;color:#e6e8ee;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#171a21;border:1px solid #262b36;border-radius:16px;padding:32px 40px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{color:#9aa3b2;margin:0;font-size:14px}
</style></head><body><div class="card"><h1>ChatGPT подключён</h1>
<p>Можно закрыть эту вкладку и вернуться в Syntee.</p></div></body></html>`

function errorHtml(message: string): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ошибка</title></head>
<body style="font-family:system-ui;background:#0f1115;color:#f87171;padding:40px">
<h1>Не удалось войти</h1><p style="color:#9aa3b2">${message}</p></body></html>`
}

async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<
  { ok: true; access: string; refresh: string; idToken: string | null } | { ok: false; error: string }
> {
  try {
    const res = await fetch(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CODEX_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      }),
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` }
    const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; id_token?: string }
    if (!json.access_token || !json.refresh_token) {
      return { ok: false, error: 'В ответе нет access/refresh токена' }
    }
    return { ok: true, access: json.access_token, refresh: json.refresh_token, idToken: json.id_token ?? null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Стартует OAuth. Возвращает URL для браузера. Если порт 1455/1457 занят —
 * сервер не поднимается, и код придётся вставить вручную (completeCodexLoginManual).
 */
export async function startCodexLogin(): Promise<{ url: string; port: number; autoCapture: boolean }> {
  cancelCodexLogin()
  const { verifier, challenge } = createPkce()
  const state = randomBytes(16).toString('hex')

  let server: Server | null = null
  let port = 0
  for (const candidate of [CODEX_CALLBACK_PORT, CODEX_FALLBACK_PORT]) {
    server = await new Promise<Server | null>((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(null))
      srv.listen(candidate, '127.0.0.1', () => resolve(srv))
    })
    if (server) {
      port = candidate
      break
    }
  }

  const redirectUri = `http://127.0.0.1:${port || CODEX_CALLBACK_PORT}${CODEX_CALLBACK_PATH}`
  const url = buildAuthorizeUrl(redirectUri, challenge, state)
  pending = { url, verifier, state, server, port }

  if (server) {
    server.on('request', (req, res) => {
      void handleCallbackRequest(req.url ?? '', res)
    })
  }
  return { url, port: port || CODEX_CALLBACK_PORT, autoCapture: Boolean(server) }
}

export function cancelCodexLogin(): void {
  if (pending?.server) {
    try {
      pending.server.close()
    } catch { /* уже закрыт */ }
  }
  pending = null
}

export function isCodexLoginPending(): boolean {
  return pending !== null
}

async function handleCallbackRequest(rawUrl: string, res: import('node:http').ServerResponse): Promise<void> {
  const url = new URL(rawUrl, `http://127.0.0.1:${pending?.port ?? CODEX_CALLBACK_PORT}`)
  if (url.pathname !== CODEX_CALLBACK_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
    return
  }
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorHtml(error))
    cancelCodexLogin()
    return
  }
  if (!code || !pending || state !== pending.state) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(errorHtml('Некорректный callback (нет кода или не совпал state).'))
    return
  }

  const redirectUri = `http://127.0.0.1:${pending.port}${CODEX_CALLBACK_PATH}`
  const result = await exchangeCode(code, pending.verifier, redirectUri)
  if (!result.ok) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(errorHtml(result.error))
    cancelCodexLogin()
    return
  }
  const stateAfter = persistTokens(result.access, result.refresh, result.idToken, 'oauth')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(SUCCESS_HTML)
  cancelCodexLogin()
  notifyAuthChanged(stateAfter)
}

/**
 * Ручной вход: пользователь копирует redirect-URL из адресной строки браузера
 * (страница может не открыться, если порт занят) — принимаем URL, `code#state`
 * или голый код.
 */
export async function completeCodexLoginManual(input: string): Promise<{ ok: boolean; error?: string; state?: CodexAuthState }> {
  if (!pending) return { ok: false, error: 'Сначала начните вход — ссылка авторизации ещё не создана' }
  const value = input.trim()
  let code: string | null = null
  let state: string | null = null
  try {
    const parsed = new URL(value)
    code = parsed.searchParams.get('code')
    state = parsed.searchParams.get('state')
  } catch {
    if (value.includes('#')) {
      const [c, s] = value.split('#', 2)
      code = c
      state = s ?? null
    } else if (value.includes('code=')) {
      const params = new URLSearchParams(value)
      code = params.get('code')
      state = params.get('state')
    } else {
      code = value
    }
  }
  if (!code) return { ok: false, error: 'В ссылке нет параметра code' }
  if (state && state !== pending.state) return { ok: false, error: 'state не совпадает — начните вход заново' }

  const redirectUri = `http://127.0.0.1:${pending.port}${CODEX_CALLBACK_PATH}`
  const result = await exchangeCode(code, pending.verifier, redirectUri)
  if (!result.ok) return { ok: false, error: result.error }
  const authState = persistTokens(result.access, result.refresh, result.idToken, 'oauth')
  cancelCodexLogin()
  return { ok: true, state: authState }
}

// ── Импорт логина из Codex CLI ─────────────────────────────────────────────
function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

/**
 * Читает `~/.codex/auth.json` (логин Codex CLI / ChatGPT app) и сохраняет
 * токены в наше хранилище. Ключ доступа не копируется как API-ключ.
 */
export async function importCodexAuthFromCli(): Promise<{ ok: boolean; error?: string; state?: CodexAuthState }> {
  const path = join(codexHome(), 'auth.json')
  try {
    const raw = await readFile(path, 'utf8')
    const json = JSON.parse(raw) as {
      auth_mode?: string
      OPENAI_API_KEY?: string | null
      tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string }
      last_refresh?: string
    }
    const tokens = json.tokens
    if (!tokens?.access_token || !tokens.refresh_token) {
      if (json.OPENAI_API_KEY) {
        return { ok: false, error: 'В auth.json только API-ключ, входа по подписке нет. Войдите через ChatGPT в Codex CLI или через браузерный вход здесь.' }
      }
      return { ok: false, error: 'В auth.json нет access/refresh токенов' }
    }
    const state = persistTokens(
      tokens.access_token,
      tokens.refresh_token,
      tokens.id_token ?? null,
      'import',
      tokens.account_id ?? null,
    )
    return { ok: true, state }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      return { ok: false, error: `Файл не найден: ${path}. Сначала выполните вход в Codex CLI (codex login) или приложении ChatGPT.` }
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ── Каталог моделей подписки ───────────────────────────────────────────────
/**
 * Версия клиента, которую бэкенд Codex требует в query. Значение пониже
 * (например 0.99.0) отдаёт урезанный ответ; 1.0.0 — полный список моделей
 * с display_name, контекстом и уровнями reasoning.
 */
export const CODEX_CLIENT_VERSION = '1.0.0'

interface CodexModelDescriptor {
  slug?: string
  display_name?: string
  description?: string
  visibility?: string
  context_window?: number
  max_context_window?: number
  input_modalities?: string[]
  model_specialty?: string
  supports_search_tool?: boolean
  supported_in_api?: boolean
  supported_reasoning_levels?: Array<{ effort?: string }>
}

export interface CodexModelsResult {
  ok: boolean
  error?: string
  models: ModelMeta[]
}

/** Слаг → ModelMeta (без хардкода: всё берём из ответа бэкенда). */
function mapCodexModel(raw: CodexModelDescriptor): ModelMeta {
  const id = raw.slug ?? ''
  const modalities = raw.input_modalities ?? ['text']
  const levels = (raw.supported_reasoning_levels ?? [])
    .map(l => l.effort)
    .filter((e): e is string => typeof e === 'string' && e.length > 0)
  const capabilities: ModelCapability[] = ['tools', 'reasoning']
  if (modalities.includes('image')) capabilities.push('vision')
  const specialty = (raw.model_specialty ?? '').toLowerCase()
  if (specialty.includes('code')) capabilities.push('code')

  return {
    id,
    providerId: 'openai-codex',
    name: raw.display_name || id,
    contextWindow: raw.context_window || raw.max_context_window || 0,
    // Цены 0: запросы идут за счёт квоты подписки, а не по токенам.
    inputPrice: 0,
    outputPrice: 0,
    speed: /mini|luna|instant/i.test(id) ? 'fast' : 'medium',
    capabilities,
    inputModalities: modalities,
    description: raw.description ?? '',
    reasoning: { supported: levels.length > 0, levels },
    ...(levels.length > 0 ? { reasoningOptions: [{ type: 'effort' as const, values: levels }] } : {}),
  }
}

/**
 * Живой каталог моделей ChatGPT-подписки.
 * GET https://chatgpt.com/backend-api/codex/models?client_version=…
 * Бэкенд сам фильтрует по тарифу аккаунта; мы дополнительно отбрасываем
 * служебные модели с visibility: 'hide' (codex-auto-review, gpt-reserve).
 */
export async function fetchCodexModels(): Promise<CodexModelsResult> {
  const token = await getCodexAccessToken()
  if (!token) {
    return { ok: false, error: 'Нет входа по подписке ChatGPT — подключите её в настройках провайдера', models: [] }
  }
  try {
    const url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`
    const res = await fetch(url, {
      headers: { ...getCodexHeaders(token), Accept: 'application/json' },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let detail = `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(text) as { detail?: string; error?: { message?: string } }
        detail = parsed.detail ?? parsed.error?.message ?? detail
      } catch {
        if (text) detail = `${detail}: ${text.slice(0, 160)}`
      }
      if (res.status === 401) await forceRefreshCodexToken()
      return { ok: false, error: detail, models: [] }
    }
    const json = (await res.json()) as { models?: CodexModelDescriptor[] }
    const models = (json.models ?? [])
      .filter(m => m.slug && m.visibility !== 'hide')
      .map(mapCodexModel)
      .filter(m => m.id)
    return { ok: true, models }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), models: [] }
  }
}

// ── Уведомление рендерера ──────────────────────────────────────────────────
type AuthListener = (state: CodexAuthState) => void
const listeners = new Set<AuthListener>()

export function onCodexAuthChanged(listener: AuthListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notifyAuthChanged(state: CodexAuthState): void {
  for (const listener of listeners) {
    try {
      listener(state)
    } catch { /* listener не должен ломать флоу */ }
  }
}