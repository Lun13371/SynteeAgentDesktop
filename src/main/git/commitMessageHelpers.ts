/**
 * Чистые хелперы для сообщения коммита: разбор диффа в «сигналы», выбор scope,
 * нормализация ответа модели и шаблонный фолбэк.
 *
 * Вынесены отдельно от commitMessage.ts, потому что там импортируется
 * LocalModelManager (тянет Electron) — а эти функции полезно гонять в тестах
 * и переиспользовать без запуска приложения.
 */

export interface FileStat {
  path: string
  added: number
  deleted: number
}

export interface CommitMessageStats {
  files: number
  added: number
  deleted: number
  untracked: number
}

/**
 * Строки в diff-хунках: заголовки @@ и значимые добавленные строки. Для
 * мини-модели это самый информативный сигнал — по именам функций/типов она
 * понимает, ЧТО изменилось, тогда как сырой дифф не осиливает и пишет
 * «обновить файлы».
 */
export function extractSignals(diff: string, limit = 18): string[] {
  const signals: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const line = raw.trim()
    if (line.length < 6 || line.length > 160) return
    const key = line.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    signals.push(line)
  }
  for (const line of diff.split('\n')) {
    const hunk = line.match(/^@@[^@]*@@\s*(.+)$/)
    if (hunk) {
      // Контекст хунка — обычно имя функции/класса, где правка.
      push(hunk[1].replace(/\s*\{\s*$/, ''))
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const body = line.slice(1)
      if (!body.trim()) continue
      // Только «несущие смысл» строки: объявления, вызовы, строковые тексты UI.
      if (!/(function|class|interface|type |const |let |export |import |=>|return |if \(|await |: string|case ')/.test(body)) continue
      push(body.slice(0, 140))
    }
  }
  return signals.slice(0, limit)
}

/** Добавленные строки с текстами интерфейса — тоже смысл, особенно для UI-правок. */
export function extractStrings(diff: string, limit = 8): string[] {
  const out: string[] = []
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const m = line.match(/'([^']{12,90})'|"([^"]{12,90})"|`([^`]{12,90})`/)
    const text = m?.[1] ?? m?.[2] ?? m?.[3]
    if (text) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Кандидаты в scope: самые «смысловые» сегменты путей. Модели 1.2B нельзя
 * доверять придумывание области — даём закрытый список, иначе она выдаёт
 * scope вида «файлы» или «src».
 */
export function scopeCandidates(files: string[]): string[] {
  const NOISE = new Set([
    'src', 'dist', 'out', 'build', 'node_modules', 'index', 'main', 'renderer',
    'preload', 'shared', 'lib', 'app', 'core', 'components', 'pages', 'scratch',
    'test', 'tests', 'docs', 'assets', 'ui',
  ])
  const score = new Map<string, number>()
  for (const file of files) {
    const parts = file.split(/[\\/]/).filter(Boolean)
    const base = (parts[parts.length - 1] ?? '').replace(/\.[^.]+$/, '')
    const dirs = parts.slice(0, -1).filter(p => !NOISE.has(p.toLowerCase()))
    // Папка ближе к файлу информативнее верхней.
    dirs.forEach((d, i) => {
      score.set(d, (score.get(d) ?? 0) + 1 + i * 0.5)
    })
    if (base.length > 2) score.set(base, (score.get(base) ?? 0) + 0.4)
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => name.toLowerCase().replace(/[^a-z0-9_-]/g, ''))
    .filter(name => name.length > 1)
}

/** Модель уходит в общее («обновить файлы», «изменения») — такие ответы бракуем. */
export function isTooGeneric(message: string): boolean {
  const body = message.replace(/^[a-z]+(\([^)]+\))?!?:\s*/i, '').trim()
  if (!body) return true
  if (body.split(/\s+/).length < 2) return true
  return /^(обнов|обновл|изменен|правк|различн|небольш|update|change|misc|various|improve files|refactor files)/i.test(body)
}

/** Достаём из ответа модели одну строку коммита и приводим к формату. */
export function normalizeCommitMessage(raw: string, scopes: string[] = []): string {
  let text = (raw ?? '').trim()
  if (!text) return ''

  // ```...```, «Вот сообщение коммита:», кавычки, бэктики, маркеры списка.
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```$/g, '').trim()
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  let line = lines[0] ?? ''
  line = line.replace(/^(commit message|сообщение коммита|commit|ответ)\s*:\s*/i, '')
  line = line.replace(/^[-*•\d.\s]+/, '')
  line = line.replace(/^["'`«]+|["'`»]+$/g, '')
  line = line.replace(/\s+/g, ' ').trim()
  line = line.replace(/[.;,]+$/, '').trim()
  if (!line) return ''

  // Модель иногда теряет тип — тогда сообщение всё равно полезно, но должно
  // оставаться валидным Conventional Commits.
  if (!/^[a-z]+(\([^)]+\))?!?:\s+\S/.test(line)) {
    line = `chore: ${line}`
  }

  // Scope приводим к закрытому списку: «src», «файлы», «ui/fix» — мусор,
  // который ломает историю и группировку в графе.
  const parsed = line.match(/^([a-z]+)(?:\(([^)]+)\))?(!?):\s*(.+)$/)
  if (parsed) {
    const [, type, scope, bang, subject] = parsed
    let cleanScope = (scope ?? '').trim().toLowerCase()
    if (cleanScope) {
      const parts = cleanScope.split(/[,\s/]+/).filter(Boolean)
      const known = parts.filter(p => scopes.includes(p))
      cleanScope = (known[0] ?? parts[parts.length - 1] ?? '').replace(/[^a-z0-9_-]/g, '')
    }
    line = cleanScope ? `${type}(${cleanScope})${bang}: ${subject}` : `${type}${bang}: ${subject}`
  }

  if (line.length > 100) {
    const cut = line.slice(0, 100)
    const space = cut.lastIndexOf(' ')
    line = (space > 40 ? cut.slice(0, space) : cut).replace(/[.;,]+$/, '')
  }
  return line
}

/** Шаблонное сообщение — когда модель недоступна или выдала мусор. */
export function fallbackMessage(stats: CommitMessageStats, files: string[], lang: 'ru' | 'en'): string {
  const scopes = scopeCandidates(files)
  const scope = scopes.length > 0 ? `(${scopes.slice(0, 2).join(',')})` : ''
  const names = files
    .map(f => (f.split(/[\\/]/).pop() ?? f).replace(/\.[^.]+$/, ''))
    .filter(Boolean)
    .slice(0, 3)
  const onlyNew = stats.untracked === stats.files && stats.files > 0
  const type = onlyNew ? 'feat' : stats.deleted > stats.added ? 'chore' : 'refactor'
  const subject = names.length > 0 ? names.join(', ') : `${stats.files}`
  if (lang === 'ru') {
    return onlyNew ? `${type}${scope}: добавить ${subject}` : `${type}${scope}: правки в ${subject}`
  }
  return onlyNew ? `${type}${scope}: add ${subject}` : `${type}${scope}: update ${subject}`
}
