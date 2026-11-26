import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { SLASH_COMMANDS, type SlashCommand } from '../../../../../shared/slashCommands'
import type { Attachment, MentionItem } from '../../../../../shared/types'
import { useExtensionsStore } from '../../../store/extensions.store'

type IconName = Parameters<typeof AppIcon>[0]['name']
type SectionId = 'files' | 'skills' | 'mcp' | 'plugins' | 'commands'
type SkillRow = ReturnType<typeof useExtensionsStore.getState>['skills'][number]
type McpRow = ReturnType<typeof useExtensionsStore.getState>['mcpServers'][number]
type PluginRow = ReturnType<typeof useExtensionsStore.getState>['plugins'][number]

interface ChatInputPlusMenuProps {
  /** Контейнер инпут-бара (.chat-input-box) — панель встаёт на всю его ширину от левого края. */
  anchorRef: React.RefObject<HTMLDivElement | null>
  onAttachClick: () => void
  /** Кол-во защищённых переменных (секретов) — бейдж у пункта меню. */
  secretsCount?: number
  /** Открыть модалку защищённых переменных. */
  onProtectedVarsClick?: () => void
  planningMode?: boolean
  onPlanningModeChange?: (v: boolean) => void
  imageMode?: boolean
  onImageModeChange?: (v: boolean) => void
  askMode?: boolean
  onAskModeChange?: (v: boolean) => void
  browserMode?: boolean
  onBrowserModeChange?: (v: boolean) => void
  lang: 'ru' | 'en'
  chatId?: string
  workdir?: string
  projectId?: string | null
  attachments?: Attachment[]
  maxAttachments?: number
  /** Прикрепить файл/картинку из поиска проекта (возвращает false при лимите/дубликате). */
  onAttachItem?: (item: MentionItem) => boolean
  /** Прикрепить MCP-сервер к сообщению (чип в тексте; main инжектит его тулы). */
  onAttachMcp?: (server: { id: string; name: string }) => boolean
  customCommands?: SlashCommand[]
  /** Вставить slash-команду в инпут (ChatInput.selectCommand). */
  onInsertCommand?: (cmd: SlashCommand) => void
  /** Одноразовая оркестрация: активна ли сейчас (бейдж/подсветка пункта). */
  orchestrationActive?: boolean
  /** Включить блок оркестрации над инпутом (то же, что /orchestrate). */
  onOrchestrate?: () => void
}

// ── Анимации ─────────────────────────────────────────────────────────────
const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]
const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1]

const panelVariants: Variants = {
  hidden: (direction: number) => ({ opacity: 0, y: direction * 8 }),
  visible: { opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE_OUT } },
  exit: (direction: number) => ({ opacity: 0, y: direction * 5, transition: { duration: 0.12, ease: EASE_IN } }),
}

// Волну проигрывают три группы при открытии панели, не отдельные строки.
const groupVariants: Variants = {
  hidden: ({ direction }: { direction: number }) => ({ opacity: 0.45, y: direction * 3 }),
  visible: ({ index }: { index: number }) => ({
    opacity: 1, y: 0, transition: { delay: index * 0.024, duration: 0.15, ease: EASE_OUT },
  }),
}

const bodyVariants: Variants = {
  hidden: { height: 0, opacity: 0 },
  visible: {
    height: 'auto',
    opacity: 1,
    transition: { height: { duration: 0.2, ease: EASE_OUT }, opacity: { duration: 0.14, delay: 0.02 } },
  },
  exit: {
    height: 0,
    opacity: 0,
    transition: { height: { duration: 0.15, ease: EASE_IN }, opacity: { duration: 0.09 } },
  },
}

/** Визуальный тумблер (клик обрабатывает строка/плитка целиком). */
function Switch({ on, reducedMotion }: { on: boolean; reducedMotion: boolean }) {
  return (
    <span className={`plus-switch${on ? ' plus-switch--on' : ''}`} aria-hidden="true">
      <motion.span
        className="plus-switch-thumb"
        initial={false}
        animate={{ x: on ? 16 : 2 }}
        transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 30 }}
      />
    </span>
  )
}

function Category({ icon, tint, label, sub, count, open, onToggle, quick, reducedMotion, children }: {
  icon: IconName
  tint: string
  label: string
  sub?: string
  count?: number
  open: boolean
  onToggle: () => void
  quick?: { icon: IconName; title: string; onClick: () => void }
  reducedMotion: boolean
  children: ReactNode
}) {
  return (
    <div className={`plus-cat${open ? ' plus-cat--open' : ''}`} style={{ '--cat': tint } as React.CSSProperties}>
      <div className="plus-cat-headrow">
        <button type="button" className="plus-cat-head" onClick={onToggle} aria-expanded={open}>
          <span className="plus-cat-icon"><AppIcon name={icon} size="sm" /></span>
          <span className="plus-cat-text">
            <span className="plus-cat-label">{label}</span>
            {sub && <span className="plus-cat-sub">{sub}</span>}
          </span>
          {!!count && <span className="plus-cat-count">{count}</span>}
          <motion.span className="plus-cat-chev" animate={{ rotate: open ? 180 : 0 }} transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: EASE_OUT }}>
            <AppIcon name="chevronDown" size="xs" />
          </motion.span>
        </button>
        {quick && (
          <button
            type="button"
            className="plus-cat-quick"
            title={quick.title}
            aria-label={quick.title}
            onClick={e => { e.stopPropagation(); quick.onClick() }}
          >
            <AppIcon name={quick.icon} size="xs" />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="plus-cat-body"
            variants={bodyVariants}
            initial={reducedMotion ? false : 'hidden'}
            animate="visible"
            exit={reducedMotion ? undefined : 'exit'}
          >
            <div className="plus-cat-inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * Кнопка «+» → панель на всю ширину инпут-бара (от его левого края), со скроллом
 * и раскрывающимися категориями: файлы проекта, скиллы, MCP-серверы, команды.
 * Тумблеры режимов — сетка в две колонки (одиночная кнопка — на всю ширину),
 * текстовые действия — строки на всю ширину. Portal в body, позиция меряется
 * по anchorRef и пересчитывается при ресайзе окна и раскрытии категорий.
 */
export function ChatInputPlusMenu({
  anchorRef,
  onAttachClick,
  secretsCount = 0,
  onProtectedVarsClick,
  planningMode,
  onPlanningModeChange,
  imageMode,
  onImageModeChange,
  askMode,
  onAskModeChange,
  browserMode,
  onBrowserModeChange,
  lang,
  chatId,
  workdir,
  projectId,
  attachments = [],
  maxAttachments = 10,
  onAttachItem,
  onAttachMcp,
  customCommands = [],
  onInsertCommand,
  orchestrationActive = false,
  onOrchestrate,
}: ChatInputPlusMenuProps) {
  const t = (ru: string, en: string) => (lang === 'en' ? en : ru)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number; openUp: boolean } | null>(null)
  const reducedMotion = !!useReducedMotion()
  const direction = pos?.openUp ? 1 : -1
  const [sections, setSections] = useState<Record<SectionId, boolean>>({ files: false, skills: false, mcp: false, plugins: false, commands: false })
  const [fileQuery, setFileQuery] = useState('')
  const [fileResults, setFileResults] = useState<MentionItem[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [pendingSkill, setPendingSkill] = useState<string | null>(null)
  const [pendingMcp, setPendingMcp] = useState<string | null>(null)
  const [pendingPlugin, setPendingPlugin] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const fileToken = useRef(0)

  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const plusWrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const skills = useExtensionsStore(s => s.skills)
  const skillsLoading = useExtensionsStore(s => s.skillsLoading)
  const skillsError = useExtensionsStore(s => s.skillsError)
  const mcpServers = useExtensionsStore(s => s.mcpServers)
  const mcpLoading = useExtensionsStore(s => s.mcpLoading)
  const plugins = useExtensionsStore(s => s.plugins)
  const pluginsLoading = useExtensionsStore(s => s.pluginsLoading)
  const loadSkills = useExtensionsStore(s => s.loadSkills)
  const loadMcpServers = useExtensionsStore(s => s.loadMcpServers)
  const loadPlugins = useExtensionsStore(s => s.loadPlugins)
  const setSkillState = useExtensionsStore(s => s.setSkillState)

  const showNotice = useCallback((msg: string) => {
    setNotice(msg)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600)
  }, [])
  useEffect(() => () => { if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current) }, [])

  // ── Позиция: полная ширина инпут-бара, рост вверх от его верхней кромки ──
  const place = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const above = r.top > 240
    const maxH = above
      ? Math.max(200, Math.min(560, r.top - 16))
      : Math.max(200, Math.min(560, window.innerHeight - r.bottom - 16))
    const h = menuRef.current ? Math.min(menuRef.current.offsetHeight, maxH) : 340
    const top = above ? Math.max(8, r.top - h - 10) : r.bottom + 10
    const next = { top, left: r.left, width: r.width, maxH, openUp: above }
    setPos(prev => (prev && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.maxH === next.maxH && prev.openUp === next.openUp) ? prev : next)
  }, [anchorRef])

  useLayoutEffect(() => {
    if (!open) return
    place()
    const ro = new ResizeObserver(() => place())
    if (menuRef.current) ro.observe(menuRef.current)
    window.addEventListener('resize', place)
    return () => { ro.disconnect(); window.removeEventListener('resize', place) }
  }, [open, place])

  // ── Закрытие: клик снаружи + Esc ──
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (plusWrapRef.current?.contains(e.target as Node)) return
      if (menuRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const t0 = window.setTimeout(() => document.addEventListener('mousedown', close), 0)
    window.addEventListener('keydown', key)
    return () => { window.clearTimeout(t0); document.removeEventListener('mousedown', close); window.removeEventListener('keydown', key) }
  }, [open])

  // ── Данные категорий: грузим при открытии панели (счётчики в шапках) ──
  useEffect(() => {
    if (!open) return
    void loadSkills(projectId ?? undefined)
    void loadMcpServers(projectId ?? undefined)
    void loadPlugins(projectId ?? undefined)
  }, [open, projectId, loadSkills, loadMcpServers, loadPlugins])

  // ── Поиск файлов проекта (debounce + race-guard) ──
  useEffect(() => {
    if (!open || !sections.files) return
    const q = fileQuery.trim()
    if (!q) { setFileResults([]); setFileLoading(false); return }
    setFileLoading(true)
    const token = ++fileToken.current
    const timer = window.setTimeout(() => {
      window.syntee.mentions.search({ workdir, query: q, limit: 24, chatId })
        .then((items: MentionItem[]) => {
          if (token !== fileToken.current) return
          setFileResults((items ?? []).filter(i => i.type === 'file' || i.type === 'image'))
          setFileLoading(false)
        })
        .catch(() => {
          if (token !== fileToken.current) return
          setFileResults([])
          setFileLoading(false)
        })
    }, 160)
    return () => window.clearTimeout(timer)
  }, [fileQuery, sections.files, open, workdir, chatId])

  const toggleSection = useCallback((id: SectionId) => {
    setSections(s => ({ ...s, [id]: !s[id] }))
  }, [])

  const commands = useMemo(() => {
    const customNames = new Set(customCommands.map(c => c.name))
    return [...SLASH_COMMANDS.filter(c => !customNames.has(c.name)), ...customCommands]
  }, [customCommands])

  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(s => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [skills, skillQuery])

  const enabledSkills = skills.filter(s => s.state.enabled).length
  const enabledMcp = mcpServers.filter(s => s.enabled).length
  const enabledPlugins = plugins.filter(p => p.state.enabled).length

  const toggles: Array<{ key: string; icon: IconName; tint: string; label: string; title: string; on: boolean; change?: (v: boolean) => void }> = [
    { key: 'planning', icon: 'fileText', tint: '#60a5fa', label: t('Планирование', 'Planning'), title: t('Режим плана: исследование + план без правок', 'Plan mode: research + plan, no edits'), on: !!planningMode, change: onPlanningModeChange },
    { key: 'image', icon: 'image', tint: '#f472b6', label: t('Генерация изображений', 'Image generation'), title: t('Генерация изображений по описанию', 'Generate images from a description'), on: !!imageMode, change: onImageModeChange },
    { key: 'ask', icon: 'messageSquare', tint: '#34d399', label: t('Ask — только чтение', 'Ask — read only'), title: t('Ответ без правок кода и запуска команд', 'Answer without editing code or running commands'), on: !!askMode, change: onAskModeChange },
    { key: 'browser', icon: 'monitor', tint: '#22d3ee', label: t('Управление браузером', 'Browser control'), title: t('browser_*-тулы для встроенного браузера', 'browser_* tools for the built-in browser'), on: !!browserMode, change: onBrowserModeChange },
  ]

  const attachFromSearch = (item: MentionItem) => {
    if (attachments.some(a => a.path && a.path === item.path)) {
      showNotice(t('Этот файл уже прикреплён', 'This file is already attached'))
      return
    }
    if (attachments.length >= maxAttachments) {
      showNotice(t(`Лимит вложений — ${maxAttachments}`, `Attachment limit is ${maxAttachments}`))
      return
    }
    if (onAttachItem?.(item) === false) showNotice(t('Не удалось прикрепить файл', 'Could not attach the file'))
  }

  const toggleSkill = async (sk: SkillRow) => {
    const next = !sk.state.enabled
    setPendingSkill(sk.id)
    useExtensionsStore.setState(s => ({ skills: s.skills.map(x => x.id === sk.id ? { ...x, state: { ...x.state, enabled: next } } : x) }))
    try {
      await setSkillState(sk.id, { ...sk.state, enabled: next }, sk.source)
    } catch {
      useExtensionsStore.setState(s => ({ skills: s.skills.map(x => x.id === sk.id ? { ...x, state: sk.state } : x) }))
      showNotice(t('Не удалось переключить скилл', 'Could not toggle the skill'))
    } finally {
      setPendingSkill(null)
    }
  }

  const toggleMcp = async (srv: McpRow) => {
    const next = !srv.enabled
    setPendingMcp(srv.id)
    useExtensionsStore.setState(s => ({ mcpServers: s.mcpServers.map(x => x.id === srv.id ? { ...x, enabled: next } : x) }))
    try {
      await window.syntee.mcp.setServerState({ serverId: srv.id, projectId: projectId ?? undefined, enabled: next })
      await loadMcpServers(projectId ?? undefined)
    } catch {
      useExtensionsStore.setState(s => ({ mcpServers: s.mcpServers.map(x => x.id === srv.id ? { ...x, enabled: srv.enabled } : x) }))
      showNotice(t('Не удалось переключить MCP-сервер', 'Could not toggle the MCP server'))
    } finally {
      setPendingMcp(null)
    }
  }

  const mcpStatus = (srv: McpRow): { text: string; tone: string } => {
    if (!srv.enabled) return { text: t('Выключен', 'Disabled'), tone: 'off' }
    if (srv.status === 'connected') return { text: t(`Подключён · ${srv.tools.length} тулов`, `Connected · ${srv.tools.length} tools`), tone: 'ok' }
    if (srv.status === 'connecting') return { text: t('Подключение…', 'Connecting…'), tone: 'warn' }
    if (srv.status === 'error') return { text: srv.error || t('Ошибка подключения', 'Connection error'), tone: 'err' }
    return { text: t('Не подключён', 'Disconnected'), tone: 'off' }
  }

  // Прикрепление MCP-сервера к сообщению: как файл — чип в тексте. Выключенный
  // сервер сначала включаем (иначе его тулов нет в ране).
  const attachMcpServer = async (srv: McpRow) => {
    if (attachments.some(a => a.kind === 'mcp' && a.mcpServerId === srv.id)) {
      showNotice(t('Сервер уже прикреплён', 'Server is already attached'))
      return
    }
    if (attachments.length >= maxAttachments) {
      showNotice(t(`Лимит вложений — ${maxAttachments}`, `Attachment limit is ${maxAttachments}`))
      return
    }
    if (!srv.enabled) {
      setPendingMcp(srv.id)
      useExtensionsStore.setState(s => ({ mcpServers: s.mcpServers.map(x => x.id === srv.id ? { ...x, enabled: true } : x) }))
      try {
        await window.syntee.mcp.setServerState({ serverId: srv.id, projectId: projectId ?? undefined, enabled: true })
        await loadMcpServers(projectId ?? undefined)
      } catch {
        useExtensionsStore.setState(s => ({ mcpServers: s.mcpServers.map(x => x.id === srv.id ? { ...x, enabled: false } : x) }))
        showNotice(t('Не удалось включить MCP-сервер', 'Could not enable the MCP server'))
        setPendingMcp(null)
        return
      }
      setPendingMcp(null)
    }
    if (onAttachMcp?.({ id: srv.id, name: srv.name }) === false) {
      showNotice(t('Не удалось прикрепить сервер', 'Could not attach the server'))
    }
  }

  const togglePlugin = async (pl: PluginRow) => {
    const next = !pl.state.enabled
    setPendingPlugin(pl.id)
    useExtensionsStore.setState(s => ({ plugins: s.plugins.map(x => x.id === pl.id ? { ...x, state: { ...x.state, enabled: next } } : x) }))
    try {
      await window.syntee.plugins.setState({ pluginId: pl.id, enabled: next })
      await loadPlugins(projectId ?? undefined)
    } catch {
      useExtensionsStore.setState(s => ({ plugins: s.plugins.map(x => x.id === pl.id ? { ...x, state: pl.state } : x) }))
      showNotice(t('Не удалось переключить плагин', 'Could not toggle the plugin'))
    } finally {
      setPendingPlugin(null)
    }
  }

  const pluginStatus = (pl: PluginRow): { text: string; tone: string } => {
    if (!pl.state.enabled) return { text: t('Выключен', 'Disabled'), tone: 'off' }
    if (pl.status === 'running') return { text: t(`Работает · ${pl.tools.length} тулов`, `Running · ${pl.tools.length} tools`), tone: 'ok' }
    if (pl.status === 'starting') return { text: t('Запуск…', 'Starting…'), tone: 'warn' }
    if (pl.status === 'error') return { text: pl.error || t('Ошибка плагина', 'Plugin error'), tone: 'err' }
    return { text: t('Остановлен', 'Stopped'), tone: 'off' }
  }

  return (
    <div className="chat-input-plus-wrap" ref={plusWrapRef}>
      <motion.button
        ref={plusBtnRef}
        type="button"
        className={`chat-input-plus-btn${open ? ' chat-input-plus-btn--open' : ''}`}
        onClick={() => {
          if (open) { setOpen(false); return }
          const r = anchorRef.current?.getBoundingClientRect()
          if (r) {
            const above = r.top > 240
            setPos({
              top: above ? Math.max(8, r.top - 350) : r.bottom + 10,
              left: r.left,
              width: r.width,
              maxH: above ? Math.max(200, Math.min(560, r.top - 16)) : Math.max(200, Math.min(560, window.innerHeight - r.bottom - 16)),
              openUp: above,
            })
          }
          setOpen(true)
        }}
        whileHover={reducedMotion ? undefined : { scale: 1.06 }}
        whileTap={reducedMotion ? undefined : { scale: 0.94 }}
        transition={{ type: 'spring', stiffness: 400, damping: 18 }}
        title={t('Прикрепить / режимы / команды', 'Attach / modes / commands')}
        aria-expanded={open}
      >
        <motion.svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" animate={{ rotate: open ? 45 : 0 }} transition={{ duration: reducedMotion ? 0 : 0.16, ease: EASE_OUT }}>
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </motion.svg>
      </motion.button>

      {createPortal(
        <AnimatePresence custom={direction}>
          {open && pos && (
            <motion.div
              ref={menuRef}
              className="chat-input-plus-menu"
              custom={direction}
              variants={panelVariants}
              initial={reducedMotion ? false : 'hidden'}
              animate="visible"
              exit={reducedMotion ? undefined : 'exit'}
              style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH, zIndex: 9999 }}
              onMouseDown={e => e.stopPropagation()}
              role="dialog"
              aria-label={t('Меню действий', 'Actions menu')}
            >
              <div className="plus-head">
                <span className="plus-head-icon"><AppIcon name="sparkles" size="sm" /></span>
                <span className="plus-head-title">{t('Быстрые действия', 'Quick actions')}</span>
                <kbd className="plus-head-kbd">Esc</kbd>
                <button type="button" className="plus-head-close" onClick={() => setOpen(false)} aria-label={t('Закрыть', 'Close')}>
                  <AppIcon name="x" size="xs" />
                </button>
              </div>

              <div className="plus-scroll">
                {/* Тумблеры режимов — две колонки */}
                <motion.div className="plus-grid plus-grid--toggles" variants={reducedMotion ? undefined : groupVariants} custom={{ index: 0, direction }}>
                  {toggles.map(tg => (
                    <motion.button
                      key={tg.key}
                      type="button"
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                      className={`plus-tile${tg.on ? ' plus-tile--on' : ''}`}
                      style={{ '--cat': tg.tint } as React.CSSProperties}
                      onClick={() => tg.change?.(!tg.on)}
                      whileHover={reducedMotion ? undefined : { y: -1.5 }}
                      whileTap={reducedMotion ? undefined : { scale: 0.98 }}
                      title={tg.title}
                      aria-pressed={tg.on}
                    >
                      <span className="plus-tile-icon"><AppIcon name={tg.icon} size="sm" /></span>
                      <span className="plus-tile-label">{tg.label}</span>
                      <Switch on={tg.on} reducedMotion={reducedMotion} />
                    </motion.button>
                  ))}
                </motion.div>

                <motion.div className="plus-menu-group" variants={reducedMotion ? undefined : groupVariants} custom={{ index: 1, direction }}>
                  {/* Текстовые действия — строки на всю ширину */}
                  {onOrchestrate && (
                    <button
                      type="button"
                      className={`plus-row plus-row--action plus-row--orchestration${orchestrationActive ? ' plus-row--on' : ''}`}
                      style={{ '--cat': '#8b5cf6' } as React.CSSProperties}
                      onClick={() => { onOrchestrate(); setOpen(false) }}
                      title={t(
                        'Один ход с отдельным исполнителем и ревьюером. Модель чата остаётся координатором',
                        'One turn with a separate executor and reviewer. The chat model stays the coordinator'
                      )}
                      aria-pressed={orchestrationActive}
                    >
                      <span className="plus-row-icon" style={{ '--cat': '#8b5cf6' } as React.CSSProperties}><AppIcon name="layers" size="sm" /></span>
                      <span className="plus-row-text">
                        <span className="plus-row-label">{t('Оркестрация', 'Orchestration')}</span>
                        <span className="plus-row-sub">{t('Исполнитель + ревьюер на один ход', 'Executor + reviewer for one turn')}</span>
                      </span>
                      {orchestrationActive
                        ? <span className="plus-cat-count plus-cat-count--accent">{t('вкл', 'on')}</span>
                        : <span className="plus-row-chev"><AppIcon name="chevronRight" size="xs" /></span>}
                    </button>
                  )}

                  <button
                    type="button"
                    className="plus-row plus-row--action"
                    onClick={() => { onProtectedVarsClick?.(); setOpen(false) }}
                    title={t('Секреты (IP, пароли, ключи), которые AI подставляет без вопросов', 'Secrets (IPs, passwords, keys) the AI uses without asking')}
                  >
                    <span className="plus-row-icon" style={{ '--cat': '#f59e0b' } as React.CSSProperties}><AppIcon name="lock" size="sm" /></span>
                    <span className="plus-row-text">
                      <span className="plus-row-label">{t('Защищённые переменные', 'Protected variables')}</span>
                      <span className="plus-row-sub">{t('Секреты для тулов и промпта', 'Secrets for tools and prompt')}</span>
                    </span>
                    {secretsCount > 0 && <span className="plus-cat-count">{secretsCount}</span>}
                    <span className="plus-row-chev"><AppIcon name="chevronRight" size="xs" /></span>
                  </button>
                </motion.div>

                <div className="plus-divider" />

                <motion.div className="plus-menu-group" variants={reducedMotion ? undefined : groupVariants} custom={{ index: 2, direction }}>
                  <Category
                    reducedMotion={reducedMotion}
                    icon="paperclip" tint="#f59e0b"
                    label={t('Прикрепить файл', 'Attach file')}
                    sub={t('Поиск по файлам проекта', 'Search project files')}
                    count={attachments.length}
                    open={sections.files}
                    onToggle={() => toggleSection('files')}
                    quick={{ icon: 'folder', title: t('Выбрать с диска…', 'Browse disk…'), onClick: () => { onAttachClick(); setOpen(false) } }}
                  >
                    <div className="plus-search">
                      <AppIcon name="search" size="xs" />
                      <input
                        autoFocus
                        value={fileQuery}
                        onChange={e => setFileQuery(e.target.value)}
                        placeholder={t('Имя файла или картинки…', 'File or image name…')}
                        aria-label={t('Поиск файлов проекта', 'Search project files')}
                      />
                      {fileQuery && (
                        <button type="button" className="plus-search-clear" onClick={() => setFileQuery('')} aria-label={t('Очистить', 'Clear')}>
                          <AppIcon name="x" size="xs" />
                        </button>
                      )}
                    </div>
                    {!fileQuery.trim() ? (
                      <>
                        <div className="plus-grid">
                          <button type="button" className="plus-row plus-row--action" onClick={() => { onAttachClick(); setOpen(false) }}>
                            <span className="plus-row-icon" style={{ '--cat': '#f59e0b' } as React.CSSProperties}><AppIcon name="upload" size="sm" /></span>
                            <span className="plus-row-text">
                              <span className="plus-row-label">{t('Выбрать с диска…', 'Browse disk…')}</span>
                              <span className="plus-row-sub">{t('Несколько файлов через диалог', 'Multiple files via dialog')}</span>
                            </span>
                          </button>
                        </div>
                        <div className="plus-hint">{t('Или перетащите файлы в инпут / вставьте из буфера (Ctrl+V).', 'Or drag files onto the input / paste from clipboard (Ctrl+V).')}</div>
                      </>
                    ) : fileLoading ? (
                      <div className="plus-hint plus-hint--busy"><AppIcon name="loader" size="xs" animation="spin" />{t('Ищем файлы…', 'Searching files…')}</div>
                    ) : fileResults.length === 0 ? (
                      <div className="plus-hint">{t(`Ничего не найдено по «${fileQuery.trim()}»`, `Nothing found for “${fileQuery.trim()}”`)}</div>
                    ) : (
                      <div className="plus-list">
                        {fileResults.map(item => {
                          const attached = attachments.some(a => a.path && a.path === item.path)
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={`plus-row${attached ? ' plus-row--attached' : ''}`}
                              onClick={() => attachFromSearch(item)}
                              title={item.path}
                            >
                              <span className="plus-row-icon" style={{ '--cat': item.type === 'image' ? '#f472b6' : '#f59e0b' } as React.CSSProperties}>
                                <AppIcon name={item.type === 'image' ? 'image' : 'fileText'} size="sm" />
                              </span>
                              <span className="plus-row-text">
                                <span className="plus-row-label">{item.label}</span>
                                <span className="plus-row-sub">{item.relPath || item.description || item.path}</span>
                              </span>
                              {attached
                                ? <span className="plus-row-check"><AppIcon name="check" size="xs" /></span>
                                : <span className="plus-row-add"><AppIcon name="plus" size="xs" /></span>}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </Category>

                  <Category
                    reducedMotion={reducedMotion}
                    icon="sparkles" tint="#a78bfa"
                    label={t('Прикрепить скилл', 'Attach skill')}
                    sub={t('Инструкции в system prompt агента', 'Instructions in the agent system prompt')}
                    count={enabledSkills}
                    open={sections.skills}
                    onToggle={() => toggleSection('skills')}
                  >
                    <div className="plus-search">
                      <AppIcon name="search" size="xs" />
                      <input
                        autoFocus
                        value={skillQuery}
                        onChange={e => setSkillQuery(e.target.value)}
                        placeholder={t('Фильтр скиллов…', 'Filter skills…')}
                        aria-label={t('Фильтр скиллов', 'Filter skills')}
                      />
                      {skillQuery && (
                        <button type="button" className="plus-search-clear" onClick={() => setSkillQuery('')} aria-label={t('Очистить', 'Clear')}>
                          <AppIcon name="x" size="xs" />
                        </button>
                      )}
                    </div>
                    {skillsLoading && skills.length === 0 ? (
                      <div className="plus-hint plus-hint--busy"><AppIcon name="loader" size="xs" animation="spin" />{t('Загружаем скиллы…', 'Loading skills…')}</div>
                    ) : skillsError && skills.length === 0 ? (
                      <div className="plus-hint plus-hint--err">{skillsError}</div>
                    ) : filteredSkills.length === 0 ? (
                      <div className="plus-hint">{skills.length === 0 ? t('Скиллов пока нет — добавьте .md в .syntee/skills/', 'No skills yet — add .md files to .syntee/skills/') : t('Ничего не найдено', 'Nothing found')}</div>
                    ) : (
                      <div className="plus-list">
                        {filteredSkills.map(sk => (
                          <button
                            key={sk.id}
                            type="button"
                            className={`plus-row${sk.state.enabled ? ' plus-row--on' : ''}`}
                            style={{ '--cat': '#a78bfa' } as React.CSSProperties}
                            onClick={() => { if (pendingSkill !== sk.id) void toggleSkill(sk) }}
                            aria-pressed={sk.state.enabled}
                            title={sk.description}
                          >
                            <span className="plus-row-icon"><AppIcon name="sparkles" size="sm" /></span>
                            <span className="plus-row-text">
                              <span className="plus-row-label">{sk.name}</span>
                              <span className="plus-row-sub">{sk.description || sk.relativePath}</span>
                            </span>
                            <span className="plus-chip">{sk.source === 'builtin' ? t('встроенный', 'builtin') : sk.source === 'project' ? t('проект', 'project') : t('мой', 'user')}</span>
                            {pendingSkill === sk.id
                              ? <span className="plus-row-spin"><AppIcon name="loader" size="xs" animation="spin" /></span>
                              : <Switch on={sk.state.enabled} reducedMotion={reducedMotion} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </Category>

                  <Category
                    reducedMotion={reducedMotion}
                    icon="server" tint="#22d3ee"
                    label={t('Прикрепить MCP', 'Attach MCP')}
                    sub={t('Внешние серверы с инструментами', 'External tool servers')}
                    count={enabledMcp}
                    open={sections.mcp}
                    onToggle={() => toggleSection('mcp')}
                  >
                    {mcpLoading && mcpServers.length === 0 ? (
                      <div className="plus-hint plus-hint--busy"><AppIcon name="loader" size="xs" animation="spin" />{t('Загружаем серверы…', 'Loading servers…')}</div>
                    ) : mcpServers.length === 0 ? (
                      <div className="plus-hint">{t('MCP-серверов нет. Добавьте их в Настройки → Расширения или в .mcp.json проекта.', 'No MCP servers. Add them in Settings → Extensions or in the project .mcp.json.')}</div>
                    ) : (
                      <div className="plus-list">
                        {mcpServers.map(srv => {
                          const st = mcpStatus(srv)
                          const attached = attachments.some(a => a.kind === 'mcp' && a.mcpServerId === srv.id)
                          return (
                            <div
                              key={srv.id}
                              className={`plus-row plus-row--mcp${srv.enabled ? ' plus-row--on' : ''}`}
                              style={{ '--cat': '#22d3ee' } as React.CSSProperties}
                            >
                              <button
                                type="button"
                                className="plus-row-main"
                                onClick={() => { if (pendingMcp !== srv.id) void toggleMcp(srv) }}
                                aria-pressed={srv.enabled}
                                title={srv.command || srv.url || srv.name}
                              >
                                <span className="plus-row-icon"><AppIcon name="server" size="sm" /></span>
                                <span className="plus-row-text">
                                  <span className="plus-row-label">{srv.name}</span>
                                  <span className={`plus-row-sub plus-row-sub--${st.tone}`}>{st.text}</span>
                                </span>
                                <span className={`plus-dot plus-dot--${st.tone}`} />
                                {pendingMcp === srv.id
                                  ? <span className="plus-row-spin"><AppIcon name="loader" size="xs" animation="spin" /></span>
                                  : <Switch on={srv.enabled} reducedMotion={reducedMotion} />}
                              </button>
                              <button
                                type="button"
                                className={`plus-row-attach${attached ? ' plus-row-attach--done' : ''}`}
                                onClick={() => { void attachMcpServer(srv) }}
                                title={attached
                                  ? t('Сервер прикреплён к сообщению', 'Server attached to the message')
                                  : t('Прикрепить сервер к сообщению', 'Attach the server to the message')}
                                aria-label={t('Прикрепить MCP-сервер к сообщению', 'Attach MCP server to the message')}
                                aria-pressed={attached}
                              >
                                <AppIcon name={attached ? 'check' : 'paperclip'} size="xs" />
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </Category>

                  <Category
                    reducedMotion={reducedMotion}
                    icon="puzzle" tint="#f472b6"
                    label={t('Подключить плагин', 'Connect plugin')}
                    sub={t('Локальные расширения с тулами', 'Local extensions with tools')}
                    count={enabledPlugins}
                    open={sections.plugins}
                    onToggle={() => toggleSection('plugins')}
                  >
                    {pluginsLoading && plugins.length === 0 ? (
                      <div className="plus-hint plus-hint--busy"><AppIcon name="loader" size="xs" animation="spin" />{t('Загружаем плагины…', 'Loading plugins…')}</div>
                    ) : plugins.length === 0 ? (
                      <div className="plus-hint">{t('Плагинов нет. Установите их в Настройки → Расширения.', 'No plugins. Install them in Settings → Extensions.')}</div>
                    ) : (
                      <div className="plus-list">
                        {plugins.map(pl => {
                          const st = pluginStatus(pl)
                          return (
                            <button
                              key={pl.id}
                              type="button"
                              className={`plus-row${pl.state.enabled ? ' plus-row--on' : ''}`}
                              style={{ '--cat': '#f472b6' } as React.CSSProperties}
                              onClick={() => { if (pendingPlugin !== pl.id) void togglePlugin(pl) }}
                              aria-pressed={pl.state.enabled}
                              title={pl.manifest.name}
                            >
                              <span className="plus-row-icon"><AppIcon name="puzzle" size="sm" /></span>
                              <span className="plus-row-text">
                                <span className="plus-row-label">{pl.manifest.name}</span>
                                <span className={`plus-row-sub plus-row-sub--${st.tone}`}>{st.text}</span>
                              </span>
                              <span className={`plus-dot plus-dot--${st.tone}`} />
                              {pendingPlugin === pl.id
                                ? <span className="plus-row-spin"><AppIcon name="loader" size="xs" animation="spin" /></span>
                                : <Switch on={pl.state.enabled} reducedMotion={reducedMotion} />}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </Category>

                  <Category
                    reducedMotion={reducedMotion}
                    icon="terminal" tint="#34d399"
                    label={t('Команды', 'Commands')}
                    sub={t('Вставить slash-команду в инпут', 'Insert a slash command into the input')}
                    count={commands.length}
                    open={sections.commands}
                    onToggle={() => toggleSection('commands')}
                  >
                    <div className="plus-grid plus-grid--commands">
                      {commands.map(cmd => (
                        <motion.button
                          key={cmd.name}
                          type="button"
                          transition={{ duration: 0.16, ease: 'easeOut' }}
                          className="plus-cmd"
                          style={{ '--cat': '#34d399' } as React.CSSProperties}
                          onClick={() => { onInsertCommand?.(cmd); setOpen(false) }}
                          whileHover={reducedMotion ? undefined : { y: -1.5 }}
                          whileTap={reducedMotion ? undefined : { scale: 0.98 }}
                          title={cmd.description}
                        >
                          <span className="plus-cmd-icon"><AppIcon name={cmd.icon as IconName} size="sm" /></span>
                          <span className="plus-cmd-text">
                            <span className="plus-cmd-label">{cmd.label}</span>
                            <span className="plus-cmd-desc">{cmd.description}</span>
                          </span>
                        </motion.button>
                      ))}
                    </div>
                  </Category>
                </motion.div>
              </div>

              <AnimatePresence>
                {notice && (
                  <motion.div
                    className="plus-notice"
                    initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reducedMotion ? undefined : { opacity: 0, y: 8 }}
                    transition={{ duration: 0.16 }}
                    role="status"
                  >
                    <AppIcon name="alertCircle" size="xs" />
                    {notice}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}