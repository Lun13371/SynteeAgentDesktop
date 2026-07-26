/**
 * PTY-менеджер — настоящие интерактивные shell-сессии поверх node-pty.
 * Заменяет marker-based ShellSessionManager: те же возможности (cd/env
 * переживают между вызовами, AI-exec с маркером и exit code), но плюс
 * полноценный PTY — TUI-программы (vim, top, fzf), цвета, интерактивный
 * ввод, стриминг вывода в UI.
 *
 * Сессии per-chat (Map<sessionId, PtySession> + индекс по chatId).
 * AI run_command идёт через execInSession — пишет команду в PTY, ждёт
 * уникальный маркер с exit code; параллельно байты стримятся в xterm
 * (юзер видит команду и вывод живьём).
 *
 * Живёт в main-процессе (переживает перезапуск Worker'а на chat:send,
 * как и предыдущий ShellSessionManager).
 */
import * as pty from 'node-pty'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'wsl'

export interface ShellInfo {
  type: ShellType
  label: string
  /** Полный путь к исполняемому файлу или имя (если в PATH). */
  file: string
  args: string[]
  available: boolean
}

export interface SessionMeta {
  id: string
  chatId: string
  shell: ShellType
  title: string
  source: 'user' | 'agent'
  createdAt: number
  /** Помечена на удаление (процесс умер). */
  dead: boolean
}

interface PendingExec {
  markerId: string
  /** Скомпилированный регекс — создаётся один раз, не на каждый чанк. */
  markerRe: RegExp
  buf: string
  resolve: (r: { output: string; exitCode: number; timedOut?: boolean }) => void
  timer: NodeJS.Timeout
}

interface PtySession {
  id: string
  chatId: string
  shell: ShellType
  title: string
  source: 'user' | 'agent'
  createdAt: number
  proc: pty.IPty
  dead: boolean
  pending: PendingExec | null
  /** Буфер вывода до первого mount xterm — чтобы не потерять приглашение. */
  preMountBuf: string
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
/** Кап pre-mount буфера — при превышении дропаем хвост с маркером обрезки.
 *  Без этого команда с мегабайтами вывода + открытие панели = синхронный
 *  term.write(весь_буфер) → фриз рендерера на секунды. */
const PRE_MOUNT_BUF_CAP = 256 * 1024

let cachedShells: ShellInfo[] | null = null

/** Автодетект доступных shells на текущей системе (кешируется). */
export function detectShells(): ShellInfo[] {
  if (cachedShells) return cachedShells
  const isWin = process.platform === 'win32'
  const list: ShellInfo[] = []

  if (isWin) {
    // PowerShell — Windows PowerShell 5.1 (powershell.exe) или PowerShell 7+ (pwsh.exe).
    // Предпочитаем pwsh если установлен, иначе powershell.
    const pwsh = which('pwsh.exe') ?? which('powershell.exe')
    if (pwsh) {
      list.push({ type: 'powershell', label: 'PowerShell', file: pwsh, args: ['-NoLogo'], available: true })
    }

    // CMD
    const cmd = which('cmd.exe')
    if (cmd) {
      list.push({ type: 'cmd', label: 'Command Prompt', file: cmd, args: [], available: true })
    }

    // Git Bash — ищем в Program Files / Program Files (x86)
    const progFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const progFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const gitBashCandidates = [
      join(progFiles, 'Git', 'bin', 'bash.exe'),
      join(progFilesX86, 'Git', 'bin', 'bash.exe'),
    ]
    const gitBash = gitBashCandidates.find(p => existsSync(p))
    if (gitBash) {
      list.push({ type: 'bash', label: 'Git Bash', file: gitBash, args: ['-i', '-l'], available: true })
    }

    // WSL
    const wsl = which('wsl.exe')
    if (wsl) {
      list.push({ type: 'wsl', label: 'WSL (Ubuntu)', file: wsl, args: [], available: true })
    }
  } else {
    // Unix
    const bash = which('bash') ?? '/bin/bash'
    list.push({ type: 'bash', label: 'Bash', file: bash, args: ['-l'], available: existsSync(bash) })
    const zsh = which('zsh')
    if (zsh) list.push({ type: 'bash', label: 'Zsh', file: zsh, args: ['-l'], available: true })
  }

  cachedShells = list
  return list
}

/** Имитация `which` — ищет executable в PATH, возвращает полный путь или undefined. */
function which(name: string): string | undefined {
  try {
    const isWin = process.platform === 'win32'
    const cmd = isWin ? `where ${name}` : `which ${name}`
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    // `where` может вернуть несколько строк — берём первую
    return out.split(/\r?\n/)[0] || undefined
  } catch {
    return undefined
  }
}

class PtyManager {
  private sessions = new Map<string, PtySession>()
  private byChat = new Map<string, Set<string>>()
  private sender: BrowserWindow | null = null

  setSender(w: BrowserWindow | null): void {
    this.sender = w
  }

  /** Создаёт новую PTY-сессию. */
  create(chatId: string, shell: ShellType, cwd?: string, source: 'user' | 'agent' = 'user', title?: string): string {
    const shells = detectShells()
    const info = shells.find(s => s.type === shell) ?? shells[0]
    if (!info) throw new Error(`No shell available for type ${shell}`)

    const id = randomUUID()
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8' } as Record<string, string>
    const effectiveCwd = cwd || homedir()

    const proc = pty.spawn(info.file, info.args, {
      name: 'xterm-color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: effectiveCwd,
      env,
    })

    const session: PtySession = {
      id,
      chatId,
      shell: info.type,
      title: title ?? info.label,
      source,
      createdAt: Date.now(),
      proc,
      dead: false,
      pending: null,
      preMountBuf: '',
    }

    proc.onData(data => {
      // 1. Копим pre-mount буфер (до первого xterm attach) — с капом чтобы
      //    избежать unbounded growth и фриза при flushPreMount. Полный
      //    вывод уже стримится в renderer через pty:data — preMountBuf
      //    нужен только для первого attach xterm.
      if (!session.dead) {
        if (session.preMountBuf.length < PRE_MOUNT_BUF_CAP) {
          session.preMountBuf += data
          if (session.preMountBuf.length > PRE_MOUNT_BUF_CAP) {
            session.preMountBuf =
              session.preMountBuf.slice(0, PRE_MOUNT_BUF_CAP) +
              '\r\n\x1b[2m[…pre-mount buffer truncated]\x1b[0m'
          }
        }
      }
      // 2. Стримим в renderer
      this.sender?.webContents.send('pty:data', id, data)
      // 3. Копим для pending exec (AI)
      if (session.pending) this.feedExec(session, data)
    })

    proc.onExit(({ exitCode }) => {
      session.dead = true
      this.sender?.webContents.send('pty:exit', id, exitCode)
      this.sender?.webContents.send('pty:session-list-changed', chatId)
      // Резолвим pending если был (процесс упал)
      if (session.pending) {
        const p = session.pending
        clearTimeout(p.timer)
        session.pending = null
        p.resolve({ output: p.buf, exitCode: exitCode ?? 1, timedOut: false })
      }
      // Не удаляем сразу из Map — UI может хотеть показать финальный вывод.
      // Удаляем по kill/cleanup.
    })

    this.sessions.set(id, session)
    let set = this.byChat.get(chatId)
    if (!set) { set = new Set(); this.byChat.set(chatId, set) }
    set.add(id)
    this.sender?.webContents.send('pty:session-list-changed', chatId)
    return id
  }

  private feedExec(session: PtySession, data: string): void {
    const p = session.pending
    if (!p) return
    p.buf += data
    // Ищем маркер только в хвосте буфера — новый data + backfill на случай
    // если маркер разрезан между чанками. Маркер ~50 chars, backfill 128.
    // Раньше было p.buf.match(new RegExp(...)) на КАЖДОМ чанке по ВЕСЬ буфер
    // → O(n²) для команды с N чанков вывода → блокировка main process.
    const backfill = Math.min(128, p.buf.length - data.length)
    const searchStart = Math.max(0, p.buf.length - data.length - backfill)
    const m = p.markerRe.exec(p.buf.slice(searchStart))
    if (!m || m.index === undefined) return
    const actualIndex = searchStart + m.index
    const exitCode = Number(m[1])
    // Обрезаем вывод до маркера (маркер не должен попасть в результат AI)
    const output = p.buf.slice(0, actualIndex)
    // Стираем маркер из PTY-экрана: очищаем текущую строку. AI-вывод уже
    // отрисован, маркер был на новой строке — затрём его.
    session.proc.write('\r\x1b[2K')
    // Резолв через wrapper — он же чистит timer/pending (см. execInSession).
    p.resolve({ output, exitCode, timedOut: false })
  }

  /** AI-exec: пишет команду в PTY, ждёт маркер с exit code. */
  async execInSession(
    sessionId: string,
    command: string,
    timeoutSec: number,
  ): Promise<{ output: string; exitCode: number; timedOut?: boolean }> {
    const session = this.sessions.get(sessionId)
    if (!session) return { output: '', exitCode: 1 }
    if (session.dead) return { output: '[shell process exited]', exitCode: 1 }
    if (session.pending) return { output: '[shell busy]', exitCode: 1 }

    const markerId = `__SYNTEE_DONE_${randomUUID().replace(/-/g, '')}__`
    const isWinShell = session.shell === 'powershell' || session.shell === 'cmd'
    // PowerShell: отдаём $LASTEXITCODE (нативные exe — npm/git/tsc/node и т.д.
    // выставляют именно его), с fallback на $? для cmdlets, которые $LASTEXITCODE
    // не трогают. Старый вариант `$(if($?){0}else{1})` всегда давал 0/1 — AI
    // не видел реальный код и мог зациклиться на одной и той же "ошибке".
    //   $ec = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE }
    //         else { [int](-not $?) }
    // Совместимо с PS 5.1 (без тернарника/null-coalescing).
    const suffix = isWinShell
      ? (session.shell === 'powershell'
          ? `$ec = if ($LASTEXITCODE -ne $null) { [int]$LASTEXITCODE } else { [int](-not $?) }; Write-Output ("${markerId}:" + $ec)`
          : `echo ${markerId}:%errorlevel%`)
      : `echo "${markerId}:$?"`

    return new Promise(resolve => {
      let settled = false
      let killTimer: NodeJS.Timeout | undefined

      // Единый выход — гарантирует что resolve позвется ровно один раз
      // (dbl-resolve возможен: feedExec по маркеру + timeout-fallback),
      // и чистит ВСЕ таймеры + session.pending.
      const settle = (r: { output: string; exitCode: number; timedOut?: boolean }) => {
        if (settled) return
        settled = true
        if (killTimer) { clearTimeout(killTimer); killTimer = undefined }
        if (session.pending) {
          clearTimeout(session.pending.timer)
          session.pending = null
        }
        resolve(r)
      }

      const timer = setTimeout(() => {
        if (settled) return
        // Ctrl+C в PTY — прерывает текущую команду (npm install / build /
        // node / git и т.п.). Shell вернётся к промпту, env/cwd/история
        // сессии сохранятся — следующий run_command продолжится в той же
        // сессии, без "shell busy".
        session.proc.write('\x03')
        // Даём shell 2с на возврат промпта. Если за это время в поток успел
        // вывалиться маркер (часто так — echo уже стояло в очереди PTY
        // после C-c) — feedExec его сматчит и вызовет settle() с обычным
        // exitCode; fallback не сработает. Если за 2с промпт не вернулся
        // (висим в интерактивной проге типа vim/top, где Ctrl+C не помог) —
        // kill PTY и помечаем dead; chat.ipc.ts:870-877 на следующем
        // run_command увидит `!s.dead` и создаст новую сессию.
        killTimer = setTimeout(() => {
          if (settled) return
          // Сохраняем partial output — то, что команда успела напечатать
          // до таймаута (раньше это терялось — AI видел пустую строку).
          const partial = session.pending?.buf ?? ''
          try { session.proc.kill() } catch { /* already dead */ }
          session.dead = true
          settle({ output: partial, exitCode: 1, timedOut: true })
        }, 2000)
      }, Math.max(1, timeoutSec) * 1000)

      session.pending = { markerId, markerRe: new RegExp(`${markerId}:(\\d+)`), buf: '', resolve: settle, timer }
      // PTY интерпретирует '\r' как Enter (submit строки), не '\n' — обычный
      // pipe-подход (\n) здесь не работает, команда просто вставляется в
      // буфер строки и никогда не выполняется, из-за чего маркер не приходит
      // и exec виснет до таймаута ("shell busy" на следующих вызовах).
      session.proc.write(command + '\r')
      session.proc.write(suffix + '\r')
    })
  }

  write(sessionId: string, data: string): void {
    const s = this.sessions.get(sessionId)
    // Блокируем ввод пока AI-команда выполняется (session.pending !== null).
    // Иначе юзер может напечатать в agent-сессию и испортить вывод/маркер →
    // execInSession не сматчит маркер → timeout → пустой/битый output.
    if (s && !s.dead && !s.pending) s.proc.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const s = this.sessions.get(sessionId)
    if (s && !s.dead) {
      try { s.proc.resize(Math.max(1, cols), Math.max(1, rows)) } catch { /* proc might be dying */ }
    }
  }

  kill(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    // Резолвим pending Promise ДО очистки — иначе worker виснет навсегда на
    // await onShellExec (proc.onExit не сработает т.к. s.pending уже null).
    if (s.pending) {
      clearTimeout(s.pending.timer)
      const p = s.pending
      s.pending = null
      p.resolve({ output: p.buf, exitCode: 1, timedOut: false })
    }
    try { s.proc.kill() } catch { /* already dead */ }
    this.sessions.delete(sessionId)
    const set = this.byChat.get(s.chatId)
    set?.delete(sessionId)
    if (set && set.size === 0) this.byChat.delete(s.chatId)
    this.sender?.webContents.send('pty:session-list-changed', s.chatId)
  }

  killByChat(chatId: string): void {
    const set = this.byChat.get(chatId)
    if (!set) return
    for (const id of Array.from(set)) this.kill(id)
  }

  /** Прерывает все pending exec для чата (используется при chat:stop).
   *  Worker уже терминирован — Promise resolve бесполезен, но нужно:
   *  1) Send Ctrl+C чтобы прервать текущую команду (shell вернётся к промпту).
   *  2) Очистить session.pending — иначе следующий execInSession получит
   *     '[shell busy]' и зависнет (chat.ipc.ts:870 не создаст новую сессию
   *     т.к. !s.dead, но pending занят). */
  interruptByChat(chatId: string): void {
    const set = this.byChat.get(chatId)
    if (!set) return
    for (const id of set) {
      const s = this.sessions.get(id)
      if (!s || !s.pending) continue
      try { s.proc.write('\x03') } catch { /* dead */ }
      clearTimeout(s.pending.timer)
      // Резолвим Promise иначе worker виснет на await onShellExec.
      // Раньше relied solely on worker.terminate() — но если interrupt
      // вызван без terminate (future-proof), Promise завис бы навсегда.
      const partial = s.pending.buf ?? ''
      const resolve = s.pending.resolve
      s.pending = null
      resolve({ output: partial, exitCode: 1, timedOut: true })
    }
  }

  listByChat(chatId: string): SessionMeta[] {
    const set = this.byChat.get(chatId)
    if (!set) return []
    const out: SessionMeta[] = []
    for (const id of set) {
      const s = this.sessions.get(id)
      if (!s) continue
      out.push({
        id: s.id, chatId: s.chatId, shell: s.shell, title: s.title,
        source: s.source, createdAt: s.createdAt, dead: s.dead,
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Достать pre-mount буфер (для xterm при первом attach) и сбросить его. */
  consumePreMount(sessionId: string): string {
    const s = this.sessions.get(sessionId)
    if (!s) return ''
    const buf = s.preMountBuf
    s.preMountBuf = ''
    return buf
  }

  getMeta(sessionId: string): SessionMeta | undefined {
    const s = this.sessions.get(sessionId)
    if (!s) return undefined
    return {
      id: s.id, chatId: s.chatId, shell: s.shell, title: s.title,
      source: s.source, createdAt: s.createdAt, dead: s.dead,
    }
  }

  killAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.kill(id)
  }
}

export const ptyManager = new PtyManager()
