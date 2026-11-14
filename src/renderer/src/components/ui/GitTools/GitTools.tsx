/**
 * Панель «Репозиторий» — висит в правом верхнем углу чата, прижата к стенке
 * окна, по умолчанию РАСКРЫТА. Внутри: план задачи (если он есть), изменения
 * рабочего дерева, изменения последнего запроса, ветка и коммит/push.
 *
 * Почему не «Инструменты Git»: панель показывает не только git, но и текущий
 * план/прогресс работы агента.
 *
 * Два разных счётчика изменений, их нельзя смешивать:
 *  1. «Изменения» — всё в рабочем дереве против HEAD (треканое + новые файлы);
 *  2. «Изменения запроса» — что сделал именно последний запрос (lastTurnChanges,
 *     тот же источник, что у ChangesBadge над инпутом).
 *
 * Состояний ровно два: раскрыто / свёрнуто (чип). Закрытие — только крестиком
 * или повторным кликом по чипу; клик по пустому месту панель не трогает.
 *
 * Данные: `git:repoSummary` (агрегат), `git:branchList`, `git:generateCommitMessage`
 * (локальная мини-модель), прогресс — `liveByChat[chatId].todo`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  CircleDashed,
  CornerUpLeft,
  FileDiff,
  GitBranch,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import type { LastTurnChanges } from '../../../../../shared/types'
import { useChatStore } from '../../../store/chat.store'
import { useUIStore } from '../../../store/ui.store'
import { useToast } from '../Toast/Toast'
import GitGraph from '../GitGraph/GitGraph'
import './GitTools.css'

type View = 'panel' | 'branches' | 'commit'

interface RepoSummary {
  success: boolean
  branch: string | null
  ahead: number
  behind: number
  clean: boolean
  files: number
  added: number
  deleted: number
  staged: number
  unstaged: number
  untracked: number
  error?: string
  notARepo?: boolean
}

interface BranchItem {
  name: string
  current?: boolean
  remote?: boolean
}

interface LiveTodoItem {
  text: string
  status: 'pending' | 'in_progress' | 'done' | 'skipped'
}

interface GitToolsProps {
  workdir?: string
  chatId?: string
  lang: 'ru' | 'en'
  /** План задачи (в т.ч. завершённый) — приходит из ChatPage, чтобы панель
   *  показывала прогресс и после окончания рана, а не только в live. */
  todo?: LiveTodoItem[] | null
  /** Изменения последнего запроса — считаются отдельно от состояния репозитория. */
  lastTurnChanges?: LastTurnChanges | null
}

const POPOVER_WIDTH = 420
/** Отступ от стенки окна: тот же, что у кластера chat-topright-actions (right: 10px). */
const EDGE_GAP = 10

export default function GitTools({ workdir, chatId, lang, todo: todoProp, lastTurnChanges }: GitToolsProps) {
  const t = (ru: string, en: string): string => (lang === 'en' ? en : ru)

  // Панель по стандарту раскрыта — прятать её каждый раз бессмысленно,
  // это основной рабочий инструмент, а не редкий поповер.
  const [open, setOpen] = useState(true)
  const [view, setView] = useState<View>('panel')
  const [menuOpen, setMenuOpen] = useState(false)
  const [graphOpen, setGraphOpen] = useState(false)

  const [summary, setSummary] = useState<RepoSummary | null>(null)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  /** true/false — знаем точно; null — ещё не проверяли. Вне git-репо панель не рисуем. */
  const [isRepo, setIsRepo] = useState<boolean | null>(null)

  const [branches, setBranches] = useState<BranchItem[]>([])
  const [branchQuery, setBranchQuery] = useState('')
  const [newBranch, setNewBranch] = useState<string | null>(null)

  const [draft, setDraft] = useState('')
  const [includeUnstaged, setIncludeUnstaged] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  const chipRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // План берём из ChatPage (в т.ч. завершённый), а если его не передали —
  // из live-состояния, как раньше.
  const liveTodo = useChatStore(s => (chatId ? s.liveByChat[chatId]?.todo ?? null : null)) as LiveTodoItem[] | null
  const todo = todoProp ?? liveTodo

  const progress = useMemo(() => {
    if (!todo || todo.length === 0) return null
    const visible = todo.filter(i => i.status !== 'skipped')
    if (visible.length === 0) return null
    return { items: visible, done: visible.filter(i => i.status === 'done').length, total: visible.length }
  }, [todo])

  const refresh = useCallback(async (): Promise<void> => {
    if (!workdir) return
    try {
      const res = (await window.syntee.git.repoSummary(workdir)) as RepoSummary
      if (res?.notARepo) {
        setSummary(null)
        setSummaryError(null)
        setIsRepo(false)
        return
      }
      if (res?.success) {
        setSummary(res)
        setSummaryError(null)
        setIsRepo(true)
      } else {
        setIsRepo(false)
        setSummaryError(res?.error ?? t('Не удалось прочитать репозиторий', 'Failed to read repository'))
      }
    } catch (e) {
      setSummaryError(String((e as Error)?.message ?? e))
    }
  }, [workdir, lang])

  const loadBranches = useCallback(async (): Promise<void> => {
    if (!workdir) return
    try {
      const res = await window.syntee.git.branchList(workdir, true)
      const list = (res?.branches ?? []) as Array<BranchItem | string>
      const current = (res?.current ?? null) as string | null
      setBranches(
        list.map(b => {
          if (typeof b === 'string') return { name: b, current: b === current }
          return { name: b.name, current: b.current ?? b.name === current, remote: b.remote }
        }),
      )
    } catch {
      setBranches([])
    }
  }, [workdir])

  /**
   * Панель прижата к правой стенке области чата (а когда правая панель закрыта —
   * это стенка окна) и раскрывается вниз. Позиция пересчитывается на resize:
   * панель большая, ей нельзя уезжать за край и нельзя наезжать на правую панель.
   */
  const place = useCallback((): void => {
    const chip = chipRef.current
    const rect = chip?.getBoundingClientRect()
    if (!rect) return
    // Ориентир — правый край области чата, а не чипа: чип висит с отступом,
    // из-за которого панель раньше не доходила до стенки.
    const host = chip?.closest('.chat-main') as HTMLElement | null
    const rightBound = host ? host.getBoundingClientRect().right : window.innerWidth
    const left = Math.max(EDGE_GAP, Math.min(rightBound, window.innerWidth) - POPOVER_WIDTH - EDGE_GAP)
    const top = rect.bottom + 8
    setPos({ left, top })
    // Высоту ограничиваем по факту: панель висит вверху и не должна уезжать за экран.
    const maxHeight = Math.max(280, window.innerHeight - top - 16)
    document.documentElement.style.setProperty('--git-tools-max-h', `${maxHeight}px`)
  }, [])

  const openPanel = useCallback((): void => {
    place()
    setOpen(true)
    setView('panel')
    setFormError(null)
    void refresh()
    void loadBranches()
  }, [place, refresh, loadBranches])

  const close = useCallback((): void => {
    setOpen(false)
    setMenuOpen(false)
    setView('panel')
    setNewBranch(null)
  }, [])

  // Сводку показываем сразу, не дожидаясь открытия: чип должен с первого кадра
  // показывать реальные цифры, а не пустую плашку.
  useEffect(() => {
    const id = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(id)
  }, [refresh])

  // Позиция панели зависит от размера окна и от ширины области чата (правая
  // панель может открыться/закрыться) — держим её актуальной.
  useEffect(() => {
    if (!open) return
    place()
    const onResize = (): void => place()
    window.addEventListener('resize', onResize)
    const host = chipRef.current?.closest('.chat-main') as HTMLElement | null
    const observer = host ? new ResizeObserver(onResize) : null
    if (host && observer) observer.observe(host)
    return () => {
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
    }
  }, [open, place])

  // Пока панель открыта — обновляем сводку (ветку/статистику мог поменять агент).
  useEffect(() => {
    if (!open) return
    const id = window.setInterval(() => void refresh(), 12_000)
    return () => window.clearInterval(id)
  }, [open, refresh])

  // Esc — только навигация назад/закрыть меню. Клик по пустому месту панель
  // НЕ закрывает: состояний ровно два (открыто/свернуто), и переключает их чип.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || graphOpen) return
      if (newBranch !== null) setNewBranch(null)
      else if (menuOpen) setMenuOpen(false)
      else if (view !== 'panel') setView('panel')
      else close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, graphOpen, view, menuOpen, newBranch, close])

  useEffect(() => {
    if (view === 'commit') window.setTimeout(() => textareaRef.current?.focus(), 60)
  }, [view])

  const generate = useCallback(async (): Promise<string> => {
    if (!workdir) return ''
    setGenerating(true)
    setFormError(null)
    try {
      const res = (await window.syntee.git.generateCommitMessage({ workdir, lang })) as {
        success: boolean
        message: string
        source: 'local' | 'fallback'
        error?: string
      }
      if (res?.message) setDraft(res.message)
      if (res?.source === 'fallback') {
        const why =
          res.error === 'local-model-not-ready'
            ? t('Локальная модель не готова — подставили шаблон', 'Local model not ready — used a template')
            : t('Модель ответила слишком общо — подставили шаблон', 'Model answer was too generic — used a template')
        useToast.getState().add(why, 'info')
      }
      return res?.message ?? ''
    } catch (e) {
      setFormError(String((e as Error)?.message ?? e))
      return ''
    } finally {
      setGenerating(false)
    }
  }, [workdir, lang])

  /** Коммит: пустое поле — сначала генерим сообщение (как «leave empty to generate»). */
  const doCommit = useCallback(
    async (andPush: boolean): Promise<void> => {
      if (!workdir || busy) return
      setBusy(true)
      setFormError(null)
      try {
        let message = draft.trim()
        if (!message) message = (await generate()).trim()
        if (!message) {
          setFormError(t('Не удалось составить сообщение — напишите вручную', 'Could not compose a message — type one'))
          return
        }
        const res = await window.syntee.git.commitAndPush({ workdir, message, includeUnstaged, push: andPush })
        if (!res?.success) {
          setFormError(res?.error ?? t('Не удалось закоммитить', 'Commit failed'))
          return
        }
        useToast.getState().add(andPush ? t('Коммит и push готовы', 'Committed and pushed') : t('Коммит создан', 'Commit created'), 'success')
        setDraft('')
        setView('panel')
        await refresh()
        await loadBranches()
      } catch (e) {
        setFormError(String((e as Error)?.message ?? e))
      } finally {
        setBusy(false)
      }
    },
    [workdir, busy, draft, includeUnstaged, generate, refresh, loadBranches, lang],
  )

  const doPush = useCallback(async (): Promise<void> => {
    if (!workdir || busy) return
    setBusy(true)
    setFormError(null)
    try {
      const res = await window.syntee.git.push({ workdir })
      if (!res?.success) {
        setFormError(res?.error ?? t('Не удалось запушить', 'Push failed'))
        return
      }
      useToast.getState().add(t('Запушено', 'Pushed'), 'success')
      await refresh()
    } catch (e) {
      setFormError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [workdir, busy, refresh, lang])

  const switchBranch = useCallback(
    async (branch: string): Promise<void> => {
      if (!workdir || busy) return
      setBusy(true)
      try {
        const res = await window.syntee.git.checkout({ workdir, branch })
        if (!res?.success) {
          useToast.getState().add(res?.error ?? t('Не удалось переключить ветку', 'Failed to switch branch'), 'error')
          return
        }
        await refresh()
        await loadBranches()
        setView('panel')
      } finally {
        setBusy(false)
      }
    },
    [workdir, busy, refresh, loadBranches, lang],
  )

  const createBranch = useCallback(
    async (name: string): Promise<void> => {
      if (!workdir || busy || !name.trim()) return
      setBusy(true)
      try {
        const res = await window.syntee.git.branchCreate({ workdir, branch: name.trim(), checkout: true })
        if (!res?.success) {
          useToast.getState().add(res?.error ?? t('Не удалось создать ветку', 'Failed to create branch'), 'error')
          return
        }
        setNewBranch(null)
        setBranchQuery('')
        await refresh()
        await loadBranches()
        setView('panel')
      } finally {
        setBusy(false)
      }
    },
    [workdir, busy, refresh, loadBranches, lang],
  )

  if (!workdir) return null
  // Вне git-репозитория панель не нужна — не занимаем угол.
  if (isRepo === false) return null

  const dirty = summary ? summary.files : 0
  const canCommit = dirty > 0
  const filteredBranches = branchQuery.trim()
    ? branches.filter(b => b.name.toLowerCase().includes(branchQuery.trim().toLowerCase()))
    : branches
  const localBranches = filteredBranches.filter(b => !b.remote)
  const remoteBranches = filteredBranches.filter(b => b.remote)
  const requestAdded = lastTurnChanges?.totalAdded ?? 0
  const requestDeleted = lastTurnChanges?.totalDeleted ?? 0
  const requestFiles = lastTurnChanges?.files.length ?? 0

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={`git-tools-chip${open ? ' is-open' : ''}`}
        onClick={() => (open ? close() : openPanel())}
        title={t('Репозиторий и план задачи', 'Repository and task plan')}
        aria-expanded={open}
      >
        <FileDiff size={13} className="git-tools-chip-icon" />
        <span className="git-tools-chip-label">{t('Обзор', 'Overview')}</span>
        {/* План есть → бейдж показывает прогресс; плана нет → изменения. */}
        {progress ? (
          <span className="git-tools-chip-progress">{progress.done}/{progress.total}</span>
        ) : summary && dirty > 0 ? (
          <span className="git-tools-chip-stats">
            <span className="git-tools-add">+{summary.added}</span>
            <span className="git-tools-del">−{summary.deleted}</span>
          </span>
        ) : summary ? (
          <span className="git-tools-chip-clean">{t('чисто', 'clean')}</span>
        ) : null}
        <ChevronDown size={12} className={`git-tools-chip-chevron${open ? ' is-open' : ''}`} />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={popRef}
              className="git-tools-popover"
              style={{ left: pos.left, top: pos.top, width: POPOVER_WIDTH }}
              initial={{ opacity: 0, y: -6, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.985 }}
              transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            >
              <header className="git-tools-header">
                <FileDiff size={15} className="git-tools-header-icon" />
                <span className="git-tools-title">{t('Обзор', 'Overview')}</span>
                {summary?.branch && <span className="git-tools-header-branch">{summary.branch}</span>}
                <div className="git-tools-header-actions">
                  <button
                    type="button"
                    className={`git-tools-icon-btn${menuOpen ? ' is-active' : ''}`}
                    onClick={() => setMenuOpen(m => !m)}
                    title={t('Ещё', 'More')}
                  >
                    <span className="git-tools-dots">···</span>
                  </button>
                  <button type="button" className="git-tools-icon-btn" onClick={close} title={t('Свернуть', 'Collapse')}>
                    <X size={14} />
                  </button>
                </div>
              </header>

              {menuOpen && (
                <div className="git-tools-menu">
                  <button type="button" className="git-tools-menu-item" onClick={() => { setMenuOpen(false); void refresh() }}>
                    <RefreshCw size={13} />
                    {t('Обновить', 'Refresh')}
                  </button>
                  <button
                    type="button"
                    className="git-tools-menu-item"
                    onClick={() => { setMenuOpen(false); setGraphOpen(true) }}
                  >
                    <ListChecks size={13} />
                    {t('Граф Git', 'Git Graph')}
                  </button>
                  <button
                    type="button"
                    className="git-tools-menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      useUIStore.getState().setAgentPanelTab('git')
                      useUIStore.getState().setAgentPanelOpen(true)
                      close()
                    }}
                  >
                    <FileDiff size={13} />
                    {t('Открыть панель Git', 'Open Git panel')}
                  </button>
                </div>
              )}

              {view === 'panel' && (
                <div className="git-tools-body">
                  {summaryError && <div className="git-tools-error">{summaryError}</div>}

                  <div className="git-tools-rows">
                    <button
                      type="button"
                      className="git-tools-row"
                      onClick={() => setView('commit')}
                      title={t('Коммит и push', 'Commit and push')}
                    >
                      <FileDiff size={14} className="git-tools-row-icon" />
                      <span className="git-tools-row-label">{t('Изменения', 'Changes')}</span>
                      <span className="git-tools-row-value">
                        {summary && dirty > 0 ? (
                          <>
                            <span className="git-tools-add">+{summary.added}</span>
                            <span className="git-tools-del">−{summary.deleted}</span>
                          </>
                        ) : (
                          <span className="git-tools-muted">{t('нет изменений', 'no changes')}</span>
                        )}
                      </span>
                    </button>

                    {/* Отдельная строка: что сделал именно последний запрос.
                        Не смешиваем с состоянием репозитория выше. */}
                    {lastTurnChanges && requestFiles > 0 && (
                      <div
                        className="git-tools-row git-tools-row--static"
                        title={t('Изменения последнего запроса', 'Changes of the last request')}
                      >
                        <CornerUpLeft size={14} className="git-tools-row-icon git-tools-row-icon--dim" />
                        <span className="git-tools-row-label">{t('Изменения запроса', 'Request changes')}</span>
                        <span className="git-tools-row-value">
                          <span className="git-tools-add">+{requestAdded}</span>
                          <span className="git-tools-del">−{requestDeleted}</span>
                          <span className="git-tools-muted">
                            {requestFiles} {t('файл(ов)', 'files')}
                          </span>
                        </span>
                      </div>
                    )}

                    <button
                      type="button"
                      className="git-tools-row"
                      onClick={() => { setView('branches'); void loadBranches() }}
                      title={t('Сменить ветку', 'Switch branch')}
                    >
                      <GitBranch size={14} className="git-tools-row-icon" />
                      <span className="git-tools-row-label">{t('Ветка', 'Branch')}</span>
                      <span className="git-tools-row-value">
                        <span className="git-tools-branch">{summary?.branch ?? '—'}</span>
                        <ChevronDown size={12} />
                      </span>
                    </button>

                    <button type="button" className="git-tools-row" onClick={() => setView('commit')}>
                      <CornerUpLeft size={14} className="git-tools-row-icon" />
                      <span className="git-tools-row-label">{t('Коммит или push', 'Commit or push')}</span>
                      <ChevronDown size={12} className="git-tools-row-chevron-right" style={{ transform: 'rotate(-90deg)' }} />
                    </button>
                  </div>

                  {/* ── План задачи — внизу панели, компактно ── */}
                  {progress && (
                    <section className="git-tools-plan">
                      <div className="git-tools-plan-head">
                        <ListChecks size={12} className="git-tools-row-icon" />
                        <span className="git-tools-plan-title">{t('План задачи', 'Task plan')}</span>
                        <span className="git-tools-plan-count">{progress.done}/{progress.total}</span>
                      </div>
                      <div className="git-tools-plan-bar">
                        <div
                          className="git-tools-plan-bar-fill"
                          style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                        />
                      </div>
                      <ul className="git-tools-plan-list">
                        {progress.items.map((item, i) => (
                          <li key={`${i}-${item.text.slice(0, 24)}`} className={`git-tools-plan-item is-${item.status}`}>
                            <span className="git-tools-plan-mark">
                              {item.status === 'done' ? (
                                <Check size={10} />
                              ) : item.status === 'in_progress' ? (
                                <Loader2 size={9} className="is-spinning" />
                              ) : (
                                <CircleDashed size={9} />
                              )}
                            </span>
                            <span className="git-tools-plan-text">{item.text}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </div>
              )}

              {view === 'branches' && (
                <div className="git-tools-subview">
                  <div className="git-tools-subview-head">
                    <button type="button" className="git-tools-icon-btn" onClick={() => setView('panel')} title={t('Назад', 'Back')}>
                      <ChevronLeft size={15} />
                    </button>
                    <span className="git-tools-subview-title">{t('Ветки', 'Branches')}</span>
                  </div>

                  <div className="git-tools-search">
                    <Search size={13} />
                    <input
                      value={branchQuery}
                      onChange={e => setBranchQuery(e.target.value)}
                      placeholder={t('Поиск веток', 'Search branches')}
                      spellCheck={false}
                    />
                  </div>

                  <div className="git-tools-branch-list">
                    {localBranches.map(b => (
                      <button
                        key={b.name}
                        type="button"
                        className={`git-tools-branch-item${b.current ? ' is-current' : ''}`}
                        onClick={() => (b.current ? setView('panel') : void switchBranch(b.name))}
                      >
                        <span className="git-tools-branch-check">{b.current ? <Check size={12} /> : <GitBranch size={12} />}</span>
                        <span className="git-tools-branch-body">
                          <span className="git-tools-branch-name">{b.name}</span>
                          {b.current && dirty > 0 && (
                            <span className="git-tools-branch-note">
                              {t(`Незакоммиченных файлов: ${dirty}`, `Uncommitted files: ${dirty}`)}
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                    {remoteBranches.length > 0 && (
                      <>
                        <div className="git-tools-branch-group">{t('Удалённые', 'Remote')}</div>
                        {remoteBranches.slice(0, 20).map(b => (
                          <button
                            key={b.name}
                            type="button"
                            className="git-tools-branch-item is-remote"
                            onClick={() => void switchBranch(b.name)}
                          >
                            <span className="git-tools-branch-check"><GitBranch size={12} /></span>
                            <span className="git-tools-branch-body">
                              <span className="git-tools-branch-name">{b.name}</span>
                            </span>
                          </button>
                        ))}
                      </>
                    )}
                    {filteredBranches.length === 0 && (
                      <div className="git-tools-empty">{t('Ничего не найдено', 'Nothing found')}</div>
                    )}
                  </div>

                  {newBranch === null ? (
                    <button type="button" className="git-tools-action-row" onClick={() => setNewBranch('')}>
                      <Plus size={13} />
                      {t('Создать новую ветку и перейти…', 'Create and switch to new branch…')}
                    </button>
                  ) : (
                    <div className="git-tools-new-branch">
                      <input
                        autoFocus
                        value={newBranch}
                        onChange={e => setNewBranch(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') void createBranch(newBranch)
                          if (e.key === 'Escape') setNewBranch(null)
                        }}
                        placeholder={t('имя-ветки', 'branch-name')}
                        spellCheck={false}
                      />
                      <button type="button" className="git-tools-mini-btn" onClick={() => void createBranch(newBranch)} disabled={busy || !newBranch.trim()}>
                        {t('Создать', 'Create')}
                      </button>
                    </div>
                  )}

                  <button type="button" className="git-tools-action-row" onClick={() => setGraphOpen(true)}>
                    <ListChecks size={13} />
                    {t('Граф Git', 'Git Graph')}
                  </button>
                </div>
              )}

              {view === 'commit' && (
                <div className="git-tools-subview">
                  <div className="git-tools-subview-head">
                    <button type="button" className="git-tools-icon-btn" onClick={() => setView('panel')} title={t('Назад', 'Back')}>
                      <ChevronLeft size={15} />
                    </button>
                    <span className="git-tools-subview-title">{summary?.branch ?? t('Ветка', 'Branch')}</span>
                    <span className="git-tools-subview-stats">
                      <span className="git-tools-add">+{summary?.added ?? 0}</span>
                      <span className="git-tools-del">−{summary?.deleted ?? 0}</span>
                    </span>
                  </div>

                  <div className="git-tools-message">
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault()
                          void doCommit(false)
                        }
                      }}
                      placeholder={t('Сообщение коммита (пусто — сгенерируем)', 'Commit message (leave empty to generate)')}
                      rows={3}
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="git-tools-generate"
                      onClick={() => void generate()}
                      disabled={generating || busy}
                      title={t('Сгенерировать сообщение локальной моделью', 'Generate message with local model')}
                    >
                      {generating ? <Loader2 size={13} className="is-spinning" /> : <Sparkles size={13} />}
                    </button>
                  </div>

                  <label className="git-tools-checkbox">
                    <input
                      type="checkbox"
                      checked={includeUnstaged}
                      onChange={e => setIncludeUnstaged(e.target.checked)}
                    />
                    <span>{t('Включить незастейдженные изменения', 'Include unstaged changes')}</span>
                    <span className="git-tools-checkbox-note">{dirty} {t('файл(ов)', 'files')}</span>
                  </label>

                  {formError && <div className="git-tools-error">{formError}</div>}

                  <div className="git-tools-actions">
                    <button
                      type="button"
                      className="git-tools-primary"
                      onClick={() => void doCommit(false)}
                      disabled={busy || !canCommit}
                      title="Ctrl+Enter"
                    >
                      {busy ? <Loader2 size={13} className="is-spinning" /> : <Check size={13} />}
                      {t('Коммит', 'Commit')}
                    </button>
                    <button type="button" className="git-tools-secondary" onClick={() => void doCommit(true)} disabled={busy || !canCommit}>
                      {t('Коммит и push', 'Commit and push')}
                    </button>
                    <button type="button" className="git-tools-secondary" onClick={() => void doPush()} disabled={busy}>
                      {t('Push', 'Push')}
                    </button>
                  </div>
                  <button
                    type="button"
                    className="git-tools-cancel"
                    onClick={() => { setDraft(''); setFormError(null); setView('panel') }}
                  >
                    {t('Отменить', 'Cancel')}
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      {/* Окно графа — с анимацией открытия и закрытия. */}
      <AnimatePresence>
        {graphOpen && <GitGraph key="git-graph" workdir={workdir} lang={lang} onClose={() => setGraphOpen(false)} />}
      </AnimatePresence>
    </>
  )
}
