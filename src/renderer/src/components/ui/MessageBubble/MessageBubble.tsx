import * as React from 'react'
import { useState, useMemo, memo, useCallback, useEffect, useRef } from 'react'
import { copyToClipboard } from '@renderer/utils/clipboard'
import { motion, AnimatePresence } from 'framer-motion'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { formatTokens, formatTokensFull, formatDuration } from '@shared/format'
import { containsMathMarkers } from '@shared/mathNormalize'
import { SLASH_COMMANDS } from '@shared/slashCommands'
import { useToast } from '../Toast/Toast'
// ── Быстрый рендер код-блоков: языки подсветки ───────────────────────────
// Регистрация ~23 языков в общем инстансе refractor — побочный эффект импорта.
import '../../../utils/codeLanguages'
import Logo from '../Logo/Logo'
import AttachmentPreviewModal from '../AttachmentPreviewModal/AttachmentPreviewModal'
import type { Message, ToolOutputMode, Attachment, ToolStep } from '../../../../../shared/types'
import { splitFinalFromIters, stripFinalMarkersStreaming } from '../../../../../shared/finalAnswer'
import AppIcon from '../AppIcon/AppIcon'
import IconButton from '../IconButton/IconButton'
import ToolChain, { hasUnfinishedCalls } from '../ToolChain/ToolChain'
import MessageFileChanges from '../MessageFileChanges/MessageFileChanges'
import { collectFileChanges } from '../../../../../shared/fileChanges'
import TodoChecklist from '../TodoChecklist/TodoChecklist'
import AgentCard, { type AgentCardData } from '../AgentCard/AgentCard'
import ThinkingBlock from '../ThinkingBlock/ThinkingBlock'
import { useUIStore, type AvatarStyle } from '../../../store/ui.store'
import { useChatStore } from '../../../store/chat.store'
import { tabActions } from '../../../store/tabs.store'
import { remarkFilePaths, PATH_RE, isValidPathMatch } from '../../../utils/remarkFilePaths'
import { openFilePath } from '../../../utils/openFilePath'
import FilePathLink from '../FilePathLink/FilePathLink'
import {
  attachmentsToMarkdown,
  splitByAttachTokens,
  hasAttachTokens,
  replaceAttachTokensWithLinks,
  stripAttachTokens,
} from '../../../../../shared/attachmentMarkdown'
import '../InlineAttachmentRenderer/InlineAttachmentRenderer.css'
import 'katex/dist/katex.min.css'
import './MessageBubble.css'
import { SystemDivider } from './SystemDivider'
import {
  EditorTextarea,
  evictOldest,
  PluginMessageCtxMenu,
  PluginMessageButtons,
  showMessageContextMenu,
  createMdComponents,
  ParsedContent,
} from './markdownRenderer'


// Варианты анимации сообщений
export const MSG_ANIM_VARIANTS: Record<string, {
  initial: object; animate: object; transition: object; label: string; desc: string
}> = {
  slide: {
    label: 'Слайд', desc: 'Снизу вверх',
    initial: { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.2, ease: 'easeOut' },
  },
  fade: {
    label: 'Плавно', desc: 'Плавное появление',
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { duration: 0.3, ease: 'easeOut' },
  },
  pop: {
    label: 'Поп', desc: 'Пружинный эффект',
    initial: { opacity: 0, scale: 0.88 },
    animate: { opacity: 1, scale: 1 },
    transition: { type: 'spring', stiffness: 420, damping: 26 },
  },
  swing: {
    label: 'Качели', desc: 'С боку',
    initial: { opacity: 0, x: -24, rotate: -3 },
    animate: { opacity: 1, x: 0, rotate: 0 },
    transition: { type: 'spring', stiffness: 380, damping: 28 },
  },
  rise: {
    label: 'Подъём', desc: 'Снизу с блюром',
    initial: { opacity: 0, y: 32 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
  },
  none: {
    label: 'Нет', desc: 'Без анимации',
    initial: {},
    animate: {},
    transition: { duration: 0 },
  },
}

interface MessageBubbleProps {
  message: Message
  onPin?: (id: string) => void
  onCopy?: (content: string) => void
  onReadAloud?: (content: string) => void
  onReply?: (message: Message) => void
  onRewind?: (userMessageId: string) => void
  toolOutputMode?: ToolOutputMode
  searchQuery?: string
  liveThinking?: { text?: string; isLive: boolean; ms?: number; storeChatId?: string }
  isStreaming?: boolean
  isWaiting?: boolean
  rateLimitSec?: number
  /** Проигрывать ли entrance-анимацию. true только при первом монтировании
   * сообщения; false при scroll-remount того же сообщения виртуализатором,
   * иначе анимация повторяется при каждом скролле → «интерфейс плывёт». */
  shouldAnimate?: boolean
  /** Рабочая директория чата — для кликабельных путей в сообщениях.
   *  Относительные пути резолвятся от workdir. undefined = пути не кликабельны. */
  workdir?: string
  /** Доступен ли редактор чата (false — инкогнито-чаты, live-пузыри). */
  editorAvailable?: boolean
}

// Memoized code highlighter — рендерит HTML-строку через dangerouslySetInnerHTML.
// refractor.highlight() вызывается один раз, результат кэшируется в codeHighlightHTML.
// При scroll-remount виртуализатора берём готовый HTML из кэша — нулевая стоимость.
// Стиль на <pre> (внешний контейнер) — как раньше был на <div> внутри SyntaxHighlighter.

// ── AgentCardLive — живая карточка суб-агента в чате ─────────────────────
// Module-level кэш: виртуализатор монтирует/демонтирует сообщения при
// скролле — без кэша каждый remount карточки дёргал IPC agent.get.
// Обновления приходят через agent:update (кэш актуализируется событием).
const agentCardCache = new Map<string, AgentCardData>()

// Module-level agent:update listener — ОБНОВЛЯЕТ кэш даже когда ни один
// AgentCardLive не смонтирован (виртуализация скролла размонтирует компоненты,
// снимая их слушатели). Без этого финальный agent:update (done/cancelled)
// прилетает без слушателя → кэш залипает в 'running' → карточка вечно "выполняется".
let _agentCacheListenerInstalled = false
if (!_agentCacheListenerInstalled) {
  _agentCacheListenerInstalled = true
  window.syntee.on('agent:update', (updated: { id: string } & Record<string, unknown>) => {
    const normalized = normalizeAgent(updated)
    agentCardCache.set(updated.id, normalized)
    // Cap: agentCardCache — module-level Map, растёт бесконечно (все суб-агенты
    // за сессию). Ограничиваем 100 записями — UI достаёт старые из БД по IPC.
    if (agentCardCache.size > 100) {
      const firstKey = agentCardCache.keys().next().value
      if (firstKey) agentCardCache.delete(firstKey)
    }
  })
}

/**
 * Нормализует сырой AgentRecord из IPC (у него нет stepsCount/currentStep —
 * это computed-поля для UI) в AgentCardData, ожидаемую карточкой. Без этого
 * кэш хранил бы «частичные» объекты, и TS-касты в обработчиках были бы лживы.
 */
function normalizeAgent(raw: Record<string, unknown> & { id: string }): AgentCardData {
  const steps = (raw.steps as AgentCardData['steps']) ?? []
  const lastToolCall = steps?.filter(s => s.type === 'tool_call').slice(-1)[0]
  const status = (raw.status as AgentCardData['status']) ?? 'pending'
  return {
    id: raw.id,
    task: (raw.task as string) ?? '',
    status,
    model: (raw.model as string) ?? '…',
    stepsCount: steps?.length ?? 0,
    currentStep: status === 'running' ? lastToolCall?.toolName : undefined,
    summary: raw.summary as string | undefined,
    error: raw.error as string | undefined,
    createdAt: (raw.createdAt as number) ?? Date.now(),
    finishedAt: raw.finishedAt as number | undefined,
    role: raw.role as string | undefined,
    steps,
  }
}

function AgentCardLive({ agentId, task }: {
  agentId: string
  task: string
}) {
  const [agent, setAgent] = useState<AgentCardData | null>(() => agentCardCache.get(agentId) ?? null)

  useEffect(() => {
    // IPC при cache-miss ИЛИ если кэш stale (статус non-terminal — агент
    // мог завершиться пока компонент был размонтирован виртуализатором).
    const cached = agentCardCache.get(agentId)
    const needsRefresh = !cached || cached.status === 'pending' || cached.status === 'running'
    if (needsRefresh) {
      window.syntee.agent.get(agentId).then((a: unknown) => {
        if (a) {
          if (agentCardCache.size > 200) evictOldest(agentCardCache, 150)
          const normalized = normalizeAgent(a as Record<string, unknown> & { id: string })
          agentCardCache.set(agentId, normalized)
          setAgent(normalized)
        }
      })
    }
    const off = window.syntee.on('agent:update', (updated: { id: string } & Record<string, unknown>) => {
      if (updated.id === agentId) {
        const normalized = normalizeAgent(updated)
        agentCardCache.set(agentId, normalized)
        setAgent(normalized)
      }
    })
    // agent:spawn — main эмитит сразу при регистрации записи (status='pending'),
    // ДО первого step. Без этого карточка рисует 'pending' + '…' пока не придёт
    // первый agent:update с реальной моделью.
    const offSpawn = window.syntee.on('agent:spawn', (e: { agentId: string; model?: string; role?: string; task: string; ts: number }) => {
      if (e.agentId !== agentId) return
      if (!agentCardCache.has(agentId) || !agentCardCache.get(agentId)?.model) {
        const initial: AgentCardData = {
          id: agentId, task: e.task, status: 'pending',
          model: e.model ?? '…', stepsCount: 0,
          createdAt: e.ts, role: e.role, steps: [],
        }
        agentCardCache.set(agentId, initial)
        setAgent(initial)
      }
    })
    return () => { off(); offSpawn() }
  }, [agentId])

  const status = (agent?.status ?? 'pending') as 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  const currentTool = (agent?.steps as Array<{ type: string; toolName?: string }> | undefined)
    ?.filter(s => s.type === 'tool_call').slice(-1)[0]?.toolName

  return (
    <AgentCard
      agent={{
        id: agentId,
        task,
        status,
        model: agent?.model ?? '…',
        stepsCount: agent?.steps?.length ?? 0,
        currentStep: status === 'running' && currentTool ? currentTool : undefined,
        summary: agent?.summary,
        error: agent?.error,
        createdAt: agent?.createdAt ?? Date.now(),
        finishedAt: agent?.finishedAt,
        role: agent?.role,
        steps: agent?.steps as Array<{ type: string; toolName?: string; toolArgs?: Record<string, unknown>; content: string; success?: boolean; timestamp: number }> | undefined,
      }}
      live={status === 'pending' || status === 'running'}
      onClick={() => {
        // Открываем правую панель и фокусируем конкретного агента.
        // RightPanelHost слушает CustomEvent 'open-agent-panel' и прокидывает
        // agentId в AgentPanel.focusAgentId → setSelected(agent.id).
        window.dispatchEvent(new CustomEvent('open-agent-panel', { detail: { agentId } }))
      }}
    />
  )
}

// Shimmer-индикатор ожидания AI (думает / rate limit)
const WAITING_PHRASES = [
  'Думаю...',
  'Анализирую...',
  'Составляю ответ...',
  'Обрабатываю...',
  'Формулирую...',
]

function WaitingIndicator({ rateLimitSec, agentStatus, retry, lastError, filesChanged, commandsRun, toolProgress }: {
  rateLimitSec?: number
  agentStatus?: string | null
  retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError?: string | null
  filesChanged?: number
  commandsRun?: number
  toolProgress?: Record<string, { stage: string; detail?: string; ts: number }>
}) {
  const [phraseIdx, setPhraseIdx] = useState(0)

  useEffect(() => {
    // При ретрае/ошибке/rate-limit морозим ротацию фраз — пользователь видит
    // причину вместо generic «Думаю…». Раньше статус ретрая затирался
    // следующим onStatus, и индикатор молчал о происходящем.
    if (agentStatus || rateLimitSec || retry || lastError) return
    // Смена фразы БЕЗ полного гашения: раньше visible=false на 300мс каждые
    // 2.5с — индикатор «мигал» (пропадал/появлялся). Теперь текст меняется
    // сразу, а появление анимирует мягкий fade-in через key.
    const interval = setInterval(() => {
      setPhraseIdx(i => (i + 1) % WAITING_PHRASES.length)
    }, 2500)
    return () => clearInterval(interval)
  }, [agentStatus, rateLimitSec, retry, lastError])

  const isRateLimit = rateLimitSec && rateLimitSec > 0
  // Приоритет: vision_recognition (распознание изображений) > rate-limit >
  // retry > lastError > agentStatus > generic фраза.
  const visionProg = toolProgress?.['vision_recognition']
  let text: string
  let cls: string
  if (visionProg && visionProg.stage === 'analyzing') {
    text = visionProg.detail ?? 'Распознаю изображения...'
    cls = ' msg-waiting-shimmer--status'
  } else if (isRateLimit) {
    text = `Rate limit — жду ${rateLimitSec}с...`
    cls = ' msg-waiting-shimmer--rl'
  } else if (retry) {
    const max = retry.maxAttempts ? `/${retry.maxAttempts}` : ''
    text = retry.reason === 'rate_limit'
      ? `Лимит запросов · повтор ${retry.attempt}${max}${retry.waitSec ? ` через ${retry.waitSec}с` : ''}`
      : `Ошибка сети · повтор ${retry.attempt}${max}`
    cls = ' msg-waiting-shimmer--status'
  } else if (lastError) {
    text = lastError
    cls = ' msg-waiting-shimmer--status'
  } else if (agentStatus) {
    text = agentStatus
    cls = ' msg-waiting-shimmer--status'
  } else {
    text = WAITING_PHRASES[phraseIdx]
    cls = ''
  }

  // Живой счётчик (§4.2): N файлов изменено · M команд выполнено
  const counterParts: string[] = []
  if (filesChanged && filesChanged > 0) counterParts.push(`${filesChanged} ${plural(filesChanged, 'файл', 'файла', 'файлов')}`)
  if (commandsRun && commandsRun > 0) counterParts.push(`${commandsRun} ${plural(commandsRun, 'команда', 'команды', 'команд')}`)
  const counter = counterParts.length > 0 ? counterParts.join(' · ') : null

  return (
    <span className="msg-waiting-wrap">
      <span
        key={phraseIdx}
        className={`msg-waiting-shimmer${cls}`}
      >
        {text}
      </span>
      {counter && <span className="msg-waiting-counter">{counter}</span>}
    </span>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}

// ── renderClickablePlainText: кликабельные пути в plain-text user-сообщениях ─
// Для user-сообщений без markdown (userMarkdown=false) — парсим пути в тексте
// и делаем их кликабельными. Также обрабатывает inline-вложения через токены.
// ── renderAttachChip: React-чип вложения (для токенов в user-сообщениях) ──
// Для chat/project клик — НЕ превью, а навигация: чат → tabActions.selectChat
// (глобальный мост ChatPage), проект → самый свежий чат проекта.
function handleEntityChipClick(att: Attachment): void {
  if (att.kind === 'chat' && att.chatId) {
    tabActions.selectChat?.(att.chatId)
    return
  }
  if (att.kind === 'project' && att.projectId) {
    const chat = useChatStore.getState().chats
      .filter(c => c.projectId === att.projectId && !c.isArchived)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (chat) tabActions.selectChat?.(chat.id)
  }
}

function renderAttachChip(
  att: Attachment | undefined,
  onPreviewAttachment?: (a: Attachment) => void,
): React.ReactNode {
  if (!att) return null
  const isEntity = att.kind === 'chat' || att.kind === 'project'
  const clickable = (isEntity || !!onPreviewAttachment) && att.kind !== 'mcp'
  const title = att.kind === 'chat'
    ? `Чат: ${att.name}${att.snippet ? `\n${att.snippet}` : ''}`
    : att.kind === 'project'
    ? `Проект: ${att.name}${att.snippet ? `\n${att.snippet}` : ''}`
    : att.kind === 'mcp'
    ? `MCP-сервер: ${att.name} — его инструменты доступны в этом запросе`
    : att.relPath || att.path || att.name
  return (
    <span
      className={`inline-attach inline-attach--${att.kind}${clickable ? ' inline-attach--clickable' : ''}`}
      onClick={clickable ? (e) => {
        e.stopPropagation()
        if (isEntity) handleEntityChipClick(att)
        else onPreviewAttachment?.(att)
      } : undefined}
      title={title}
    >
      {att.kind === 'image' && att.dataUrl && <img src={att.dataUrl} alt={att.name} className="inline-attach-thumb" />}
      {att.kind === 'image' && !att.dataUrl && att.path && <img src={`file://${att.path}`} alt={att.name} className="inline-attach-thumb" />}
      {att.kind !== 'image' && (
        <span className="inline-attach-icon">
          {att.kind === 'audio' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          ) : att.kind === 'video' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="m10 9 5 3-5 3z" />
            </svg>
          ) : att.kind === 'chat' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
          ) : att.kind === 'project' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          ) : att.kind === 'mcp' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="2" width="20" height="8" rx="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          )}
        </span>
      )}
      <span className="inline-attach-name">{att.name}</span>
    </span>
  )
}

function renderClickablePlainText(
  text: string,
  workdir?: string,
  _onOpenFile?: (path: string) => void,
): React.ReactNode {
  if (!text.includes('/') && !text.includes('\\')) {
    return text
  }
  // Regex для путей — тот же PATH_RE что в remarkFilePaths (lookbehind +
  // кириллица + папки + суффиксы :42-58), чтобы подсветка в plain-text
  // и markdown не разъезжалась. FilePathLink сам обрабатывает клик.
  const re = new RegExp(PATH_RE.source, 'g')
  const parts: React.ReactNode[] = []
  let lastIdx = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    const full = m[1]
    // Папка-«проза» (and/or) — пропускаем
    if (!isValidPathMatch(full)) continue
    const pathStart = m.index + (m[0].length - m[1].length)
    if (pathStart > lastIdx) {
      parts.push(text.slice(lastIdx, pathStart))
    }
    parts.push(<FilePathLink key={`fp-${key++}`} raw={full} workdir={workdir} />)
    lastIdx = pathStart + full.length
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx))
  }
  return <>{parts}</>
}

// Одна итерация агентского прогона в UI (live и persisted).
// steps непустые — ход работы (уходит в общую ленту ToolChain);
// steps пустые — финальный текст ответа, он остаётся в сообщении.
type MsgIter = {
  label?: string
  textBefore: string
  thinking?: string
  thinkingMs?: number
  steps: import('../ToolChain/ToolChain').ToolStep[]
}

// ── Инлайн-чипы слеш-команды в чате (Discord-стиль) ─────────────────────────
//
// User-сообщение с командой рендерится как: чип `/name` + чипы совпавших
// enum-аргументов (позиционно, как в инпуте) + остальной текст как был.
// Отдельная пилюля над сообщением остаётся только фолбэком — когда текст
// контента почему-то не начинается с команды (старые данные).

/** Разбор контента user-сообщения на команду и аргументы-чипы. */
function splitInlineCommand(
  content: string,
  sc: { name: string; args: string },
): { consumed: number; argChips: Array<{ text: string; index: number }> } | null {
  const esc = sc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = new RegExp('^\\/' + esc + '(?=$|[\\s])').exec(content)
  if (!m) return null
  const argChips: Array<{ text: string; index: number }> = []
  let pos = m[0].length
  // Enum-аргументы по позициям (builtin-команды; custom без lookup — чипы
  // аргументов у них не рисуем, сам чип команды работает).
  const args = SLASH_COMMANDS.find(c => c.name === sc.name)?.arguments
  if (args?.length) {
    let idx = 0
    for (;;) {
      const ws = /^\s+/.exec(content.slice(pos))
      if (!ws) break
      const tok = /^(\S+)/.exec(content.slice(pos + ws[0].length))
      if (!tok) break
      if (!args[idx]?.choices?.some(c => c.toLowerCase() === tok[1].toLowerCase())) break
      pos += ws[0].length + tok[1].length
      argChips.push({ text: tok[1], index: idx })
      idx++
    }
  }
  return { consumed: pos, argChips }
}

// Мемоизированный тяжёлый контент сообщения
const MessageContent = memo(function MessageContent({
  content, isUser, searchQuery, toolOutputMode, toolSteps,
  onPin, onCopy, onReadAloud, onReply, onRewind, message, isPinned, createdAt,
  liveThinking, isStreaming, isWaiting, liveIters, liveTodo, liveTextAfter, rateLimitSec,
  userMarkdown = true, timeEl, agentStatus, toolProgress, retry, lastError,
  spawnedAgents,
  onPreviewAttachment,
  workdir,
  editorAvailable = true,
}: {
  content: string; isUser: boolean; searchQuery?: string
  toolOutputMode: ToolOutputMode; toolSteps?: Message['toolSteps']
  onPin?: (id: string) => void; onCopy?: () => void
  onReadAloud?: () => void; onReply?: (message: Message) => void
  onRewind?: () => void
  message: Message; isPinned: number; createdAt: number
  liveThinking?: { text?: string; isLive: boolean; ms?: number; storeChatId?: string }
  isStreaming?: boolean
  isWaiting?: boolean
  liveIters?: Array<{ textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }>
  liveTodo?: Array<{ text: string; status: 'pending' | 'in_progress' | 'done' | 'skipped' }>
  liveTextAfter?: string
  rateLimitSec?: number
  userMarkdown?: boolean
  timeEl?: React.ReactNode
  agentStatus?: string | null
  retry?: { attempt: number; maxAttempts?: number; reason: string; waitSec?: number } | null
  lastError?: string | null
  toolProgress?: Record<string, { stage: string; detail?: string; sessionId?: string; filesProcessed?: number; filesTotal?: number; filesFound?: Array<{ path: string; score: number; why: string }>; ts: number }>
  spawnedAgents?: Array<{ agentId: string; callId?: string; task: string; msgId: string; model?: string; ts: number }>
  onPreviewAttachment?: (a: Attachment | null) => void
  workdir?: string
  /** Доступен ли редактор чата для этого сообщения (false в инкогнито). */
  editorAvailable?: boolean
}) {
  const [statsOpen, setStatsOpen] = useState(false)
  // Если панель статистики не влезает сверху (сообщение в самом верху чата) —
  // показываем снизу от footer.
  const [statsBelow, setStatsBelow] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const statsPanelRef = useRef<HTMLDivElement>(null)

  // Закрытие панели статистики по клику вне неё.
  useEffect(() => {
    if (!statsOpen) return
    const onDown = (e: MouseEvent) => {
      const panel = statsPanelRef.current
      if (panel && !panel.contains(e.target as Node)) setStatsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [statsOpen])

  // Кламп панели статистики: если при открытии её верх уходит выше viewport
  // (сообщение в самом верху чата), переключаем на показ снизу от footer.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!statsOpen) { setStatsBelow(false); return }
    const panel = statsPanelRef.current
    if (!panel) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatsBelow(panel.getBoundingClientRect().top < 8)
  }, [statsOpen])

  // PlanCard разрешён только если: (1) план уже сохранён для этого сообщения
  // (message.planData), ИЛИ (2) это live-bubble в режиме планирования.
  // Вне режима планирования <plan>-теги рендерятся как обычный текст.
  const allowPlanCard = !!message.planData || !!(message as Message & { livePlanningMode?: boolean }).livePlanningMode

  // ── Редактор чата: режим + черновик этого сообщения ────────────────────
  // Режим привязан к chatId (editorChatId) — не «утекает» в сплит-чат.
  // Селекторы узкие: вне режима editorDraft всегда undefined → memo
  // MessageContent не пробивается (0 ре-рендеров). Live-пузырь не редактируется.
  const isLiveBubble = message.id === 'live-streaming-bubble' || message.id === 'split-live-streaming-bubble'
  const editorMode = useChatStore(s => !!s.editorChatId && s.editorChatId === message.chatId)
  const editorDraft = useChatStore(s => (s.editorChatId === message.chatId && !isLiveBubble ? s.editorDrafts[message.id] : undefined))
  const enterEditorMode = useChatStore(s => s.enterEditorMode)
  const updateEditorDraft = useChatStore(s => s.updateEditorDraft)
  const clearEditorDraft = useChatStore(s => s.clearEditorDraft)
  const patchMessage = useChatStore(s => s.patchMessage)
  const editorActive = editorMode && !isLiveBubble && editorAvailable
  // Эффективное «скрыто из контекста»: черновик перекрывает БД-значение.
  const hiddenNow = editorDraft?.hidden !== undefined ? editorDraft.hidden : !!message.hiddenFromContext
  const hasDraft = editorDraft !== undefined

  // ── Мемоизированные карточки spawn_agent (fallback для старых сообщений без iterations) ──
  // Раньше .filter().map() с вложенным .find() выполнялись на КАЖДОМ рендере.
  // Для цепочек 50+ шагов это 2500+ сравнений за рендер. Теперь useMemo.
  // Persisted-итерации рендерят карточки inline (они не ре-рендерятся часто —
  // только при scroll-mount виртуализатором).
  // Изображения из tool steps
  const toolImages = useMemo(() => {
    if (isUser || !toolSteps || liveIters?.length) return []
    if ((message as Message & { iterations?: unknown[] }).iterations?.length) return []
    return toolSteps.filter(s => s.type === 'tool_result' && s.imageUrl)
  }, [isUser, toolSteps, liveIters, message])

  // ── Единая лента хода работы сообщения ────────────────────────────────
  // Раньше ToolChain рендерился на КАЖДУЮ итерацию → в чате появлялась
  // стопка «Выполнено за 356мс · 1 действие», «… 21мс · 1 действие».
  // Теперь все итерации сообщения идут в ОДИН блок: одна шапка и одна лента
  // (Think → текст → тулы → Think → …), как в референсе.
  const msgIters = useMemo<MsgIter[] | undefined>(() => {
    if (liveIters?.length) return liveIters
    return (message as Message & { iterations?: MsgIter[] }).iterations
  }, [liveIters, message])

  // ── Файлы, созданные/изменённые в этом сообщении ───────────────────────
  // Плоский список шагов всех итераций — для чипов в конце ответа.
  // Для live-пузыря не считаем вовсе: чипы показываются только на готовом
  // (сохранённом) сообщении, а во время стрима шаги меняются на каждом
  // tool-событии — незачем гонять flatMap и пересборку списка файлов.
  const messageSteps = useMemo<ToolStep[]>(() => {
    if (isLiveBubble) return []
    return msgIters?.length ? msgIters.flatMap(it => it.steps) : (toolSteps ?? [])
  }, [isLiveBubble, msgIters, toolSteps])

  // ── Итоговый ответ по тегу <final_answer> ─────────────────────────────
  // Модель иногда пишет ответ, а потом всё равно вызывает тул (save_memory,
  // update_todo). Без тега такой текст попадал в textBefore СЛЕДУЮЩЕЙ
  // итерации и рендерился заметкой в свёрнутой ленте «хода работы» — ответ
  // как будто исчезал. Здесь блок вынимается из итераций и показывается
  // ответом под лентой, даже если после него были тулы. Теги в чате не видны.
  // В режиме редактора тексты не трогаем — там правится сырой текст.
  const finalSplit = useMemo(
    () => (editorActive ? { iters: msgIters, answer: '' } : splitFinalFromIters(msgIters)),
    [msgIters, editorActive],
  )
  const renderIters = editorActive ? msgIters : finalSplit.iters
  const taggedAnswer = editorActive ? '' : finalSplit.answer
  // Текст, стримящийся ПОСЛЕ последнего тула: маркеры (и недописанные тоже)
  // надо скрыть сразу, чтобы тег не мигал в чате во время печати.
  const liveTextAfterClean = useMemo(
    () => (liveTextAfter ? stripFinalMarkersStreaming(liveTextAfter) : liveTextAfter),
    [liveTextAfter],
  )

  const chainSections = useMemo(() => renderIters?.map(it => ({
    thinking: it.thinking,
    thinkingMs: it.thinkingMs,
    // Текст модели ПЕРЕД тулами этой итерации живёт в ленте. Итерация без
    // steps — это финальный ответ (buildFinalIters добавляет хвостовую
    // text-only итерацию), её текст остаётся в сообщении, иначе схлопнется
    // сам ответ. В режиме редактора текст правится отдельными textarea.
    text: !editorActive && it.steps.length > 0 ? it.textBefore : undefined,
    steps: it.steps,
  })), [renderIters, editorActive])

  const chainStepCount = useMemo(
    () => (chainSections ?? []).reduce((n, s) => n + s.steps.length, 0),
    [chainSections],
  )

  // Мини-агенты (Briefing/конституция/Economist) кидают карточки ДО первого
  // токена модели — они создают live-итерацию, но это не «ход работы».
  // Индикатор ожидания не должен из-за них исчезать: пока в ленте только
  // такие карточки и нет текста/рассуждения — «Думаю…» остаётся видимым.
  const assistantCardsOnly = !!liveIters?.length && liveIters.every(it =>
    (!it.textBefore || !it.textBefore.trim()) &&
    it.steps.length > 0 &&
    it.steps.every(s => s.type === 'hint' || s.type === 'janitor'),
  )

  // Бежит ли ещё ход работы (для живого окна): незавершённые тулы, идущий
  // визуальный анализ или стримящееся рассуждение. Когда пошёл финальный
  // текст ответа — false, и лента сама сворачивается, освобождая место.
  const liveChainRunning = !!isStreaming && !!liveIters?.length && (
    liveIters.some(it => it.steps.some(s => s.visualAnalysis?.status === 'pending')) ||
    hasUnfinishedCalls(liveIters.flatMap(it => it.steps)) ||
    liveThinking?.isLive === true
  )

  // Текущее рассуждение уходит внутрь ленты, только если у последней итерации
  // есть тулы (иначе оно рендерится отдельным блоком ниже — без дубля).
  const liveThinkingInChain = isStreaming && (liveIters?.[liveIters.length - 1]?.steps.length ?? 0) > 0
    ? liveThinking
    : undefined

  // ── Контент под шагом ВНУТРИ ленты ────────────────────────────────────
  // Карточки саб-агентов рендерятся одним слотом под своей итерацией: блок
  // стоит прямо под шагом spawn_agent, скроллится вместе с лентой и
  // сворачивается вместе с ходом работы.
  // ВАЖНО: решение принимается по шагу ИМЕННО этой итерации — иначе карточка
  // дублировалась бы под каждым шагом секции (у секции общий список steps).
  const renderIterExtra = useCallback((iter: { call: MsgIter['steps'][number]; result?: MsgIter['steps'][number] }, isLastSection: boolean) => {
    const toolName = iter.call.toolName

    // Карточка саб-агента — под своим spawn_agent.
    if (toolName === 'spawn_agent') {
      const taskArg = iter.call.toolArgs?.task as string | undefined
      // Live: карточка есть сразу (agent:spawn). Матчинг по callId (точный),
      // fallback — по тексту задачи.
      const spawned = spawnedAgents?.find(a => a.callId && a.callId === iter.call.callId)
        ?? spawnedAgents?.find(a => taskArg && a.task === taskArg)
      // История: agentId лежит в парном tool_result.
      const agentId = spawned?.agentId ?? iter.result?.content?.match(/\[AGENT:([^\]]+)\]/)?.[1]
      if (!agentId) return null
      return (
        <AgentCardLive
          key={agentId}
          agentId={agentId}
          task={taskArg ?? spawned?.task ?? ''}
        />
      )
    }

    return null
  }, [isStreaming, toolProgress, spawnedAgents])

  // Живой счётчик (§4.2): N файлов изменено · M команд выполнено.
  // Файлы считаем через collectFileChanges — он же учитывает правки внутри
  // execute_code (у скрипта нет собственных tool_result-шагов).
  const agentCounts = useMemo(() => {
    if (!toolSteps) return { filesChanged: 0, commandsRun: 0 }
    const filesChanged = collectFileChanges(toolSteps).length
    const commandsRun = toolSteps.filter(s =>
      s.type === 'tool_call' && s.toolName === 'run_command'
    ).length
    return { filesChanged, commandsRun }
  }, [toolSteps])

  // Две стабильные пары плагинов. Во время стриминга используем лёгкий набор
  // БЕЗ remark-math/rehype-katex: KaTeX ре-парсит все math-узлы на каждом
  // токене (O(n²) по длине ответа) — это главный источник «фризит пока
  // печатает». remarkGfm (таблицы/списки/код) дёшево ре-парсится каждый токен.
  // Когда стрим закончен (isStreaming=false) — полный набор, финальный вид
  // идентичен (math появится в момент окончания стрима, незаметно).
  // Доп. оптимия для скролла: даже в не-стриминге (история) большинство
  // сообщений не содержат математики → пропускаем remark-math/rehype-katex
  // целиком. Каждый scroll-mount виртуализатора ре-парсит markdown; без
  // KaTeX-прохода это заметно дешевле → меньше фризов при быстром скролле.
  // Детект математики — по СЫРОМУ тексту (нормализация внутри parseContent
  // превращает \( / \[ / \begin{env} в $, но здесь мы видим исходник):
  // иначе \(...\)-формулы не подключили бы remark-math и рендерились бы текстом.
  const hasMath = useMemo(() => containsMathMarkers(content), [content])
  // remarkFilePaths — и в стриминге: regex-проход по text-нодам дёшев,
  // FilePathLink мемоизирован (props raw/workdir стабильны между флешами),
  // stat-проверки дедуплицированы кэшем pathStatus (один IPC на уникальный
  // путь за сессию). Частичный путь во время печати → missing → простой
  // текст; допечатался → чип. Прогрессивное улучшение без шторма ре-рендеров.
  const streamingRemark = useMemo(() => [remarkGfm, remarkFilePaths], [])
  const fullRemark = useMemo(() => hasMath ? [remarkGfm, remarkMath, remarkFilePaths] : [remarkGfm, remarkFilePaths], [hasMath])
  const emptyRehype = useMemo<readonly unknown[]>(() => [], [])
  const fullRehype = useMemo(() => hasMath
    ? [[rehypeKatex, { errorColor: 'var(--danger, #e5484d)' }]]
    : emptyRehype, [hasMath, emptyRehype])
  const remarkPlugins = isStreaming ? streamingRemark : fullRemark
  const rehypePlugins = isStreaming ? emptyRehype : fullRehype

  // ── Per-instance mdComponents с кликабельными путями ──
  // workdir нужен для резолва относительных путей → правая панель.
  // remarkFilePaths работает и в стриминге (см. streamingRemark выше).
  // Сам open-флоу (stat → файл/папка/Проводник + reveal на строку) — в
  // openFilePath, колбэк здесь только как маркер «клики разрешены»
  // (условие в code-блоках) и для внешних потребителей.
  const onOpenFile = useCallback((fp: string) => {
    void openFilePath(fp, workdir)
  }, [workdir])

  const mdComponents = useMemo(
    () => createMdComponents({ workdir, onOpenFile, onPreviewAttachment }),
    [workdir, onOpenFile, onPreviewAttachment],
  )

  // ── Инлайн-чипы слеш-команды (Discord-стиль) ──
  // Контент user-сообщения с командой начинается с `/name` — первые токены
  // рисуем чипами (команда + совпавшие enum-аргументы), остаток — обычным
  // контентом. inlineCmd=null → чипов нет, рендер как раньше (и пилюля-фолбэк).
  const inlineCmd = isUser && message.slashCommand
    ? splitInlineCommand(content, message.slashCommand)
    : null
  const cmdRest = inlineCmd ? content.slice(inlineCmd.consumed) : content
  const inlineCmdFrag = inlineCmd && message.slashCommand && (
    <>
      <span className="inline-cmd" title={`Slash-команда /${message.slashCommand.name}`}>
        <span className="inline-cmd-slash">/</span>{message.slashCommand.name}
      </span>
      {inlineCmd.argChips.map(c => (
        <span key={c.index} className="inline-cmd-arg">{c.text}</span>
      ))}
    </>
  )

  return (
    <div
      ref={wrapRef}
      className="message-bubble-wrap"
      onContextMenu={(e) => {
        const selected = window.getSelection()?.toString().trim() ?? ''
        if (!selected || (e.target as HTMLElement).closest('a, button, input, textarea')) return
        e.preventDefault()
        showMessageContextMenu(e.clientX, e.clientY, [
          { label: 'Копировать выделенное', run: () => { void copyToClipboard(selected) } },
          { label: 'Искать выделенное в интернете', run: () => window.open(`https://www.google.com/search?q=${encodeURIComponent(selected)}`, '_blank', 'noopener,noreferrer') },
        ])
      }}
    >
      <div className={`message-bubble ${isUser ? 'message-bubble--user glass' : 'message-bubble--assistant'}`}>
        {isPinned === 1 && (
          <div className="message-pinned-badge">
            <AppIcon name="pin" size="sm" tone="accent" /><span>Закреплено</span>
          </div>
        )}

        {/* Пилюлька слеш-команды — фолбэк: инлайн-чипы в тексте невозможны,
            когда контент не начинается с команды (старые/служебные данные).
            Обычный случай рисуется чипами прямо в тексте (Discord-стиль). */}
        {isUser && message.slashCommand && !inlineCmd && (
          <div className="message-slash-pill">
            <span className="message-slash-pill-icon">/</span>
            <span className="message-slash-pill-name">{message.slashCommand.name}</span>
            {message.slashCommand.args && (
              <span className="message-slash-pill-args">{message.slashCommand.args}</span>
            )}
          </div>
        )}

        {!isUser && toolSteps && toolSteps.length > 0 && !liveIters?.length && !(message as Message & { iterations?: unknown[] }).iterations?.length && (
          <ToolChain
            steps={toolSteps}
            workdir={workdir}
            mode={toolOutputMode}
            isRunning={false}
            renderIterExtra={renderIterExtra}
          />
        )}

        {/* Финальный рендер итераций из БД — точно как live, каждая итерация отдельно.
            В режиме редактора текстовые сегменты (textBefore) превращаются
            в textarea — тулы остаются на месте между ними, правится только текст. */}
        {!isUser && !liveIters?.length && (() => {
          // renderIters = итерации БД без блоков <final_answer> (они вынесены
          // в taggedAnswer ниже); в режиме редактора — сырой текст как есть.
          const iters = renderIters
          if (!iters?.length) return null
          // Текущие значения сегментов в редакторе: черновик перекрывает БД.
          const draftTexts = editorActive ? (editorDraft?.iterTexts ?? []) : []
          const setIterText = (i: number, v: string) => {
            const next = iters.map((it, idx) => draftTexts[idx] ?? it.textBefore ?? '')
            next[i] = v
            updateEditorDraft(message.id, { iterTexts: next })
          }
          return (
            <div className="message-iters">
              {/* ОДИН блок хода работы на всё сообщение (вне редактора):
                  все итерации — секциями, тулы и рассуждения одной лентой. */}
              {!editorActive && chainStepCount > 0 && (
                <ToolChain
                  sections={chainSections}
                  workdir={workdir}
                  mode={toolOutputMode}
                  isRunning={false}
                  chatId={message.chatId}
                  renderIterExtra={renderIterExtra}
                />
              )}
              {iters.map((iter, i) => {
                const hasSteps = iter.steps.length > 0
                return (
                <div key={i} className={`message-iteration${editorActive ? ' message-iteration--editing' : ''}`}>
                  {/* Рассуждение: в ленте (выше) для итераций с тулами; здесь —
                      только когда тулов нет, и целиком в режиме редактора. */}
                  {iter.thinking && (editorActive || !hasSteps) && (
                    <ThinkingBlock text={iter.thinking} thinkingMs={iter.thinkingMs} />
                  )}
                  {editorActive ? (
                    (iter.textBefore || draftTexts[i] !== undefined) && (
                      <div className="message-content message-content--editing">
                        <EditorTextarea
                          value={draftTexts[i] ?? iter.textBefore}
                          onChange={v => setIterText(i, v)}
                        />
                      </div>
                    )
                  ) : !hasSteps && iter.textBefore ? (
                    // Итерация без тулов — это финальный ответ: остаётся в
                    // сообщении (в ленту не уходит, иначе схлопнется ответ).
                    <div className="message-content selectable">
                      <ParsedContent text={iter.textBefore} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} mdComponents={mdComponents} workdir={workdir} />
                    </div>
                  ) : null}
                  {/* В редакторе цепочки остаются по-итерационным: правка
                      текста должна идти рядом со своими тулами. */}
                  {editorActive && hasSteps && (
                    <ToolChain
                      steps={iter.steps}
                      workdir={workdir}
                      mode={toolOutputMode}
                      isRunning={false}
                      renderIterExtra={renderIterExtra}
                    />
                  )}
                  {/* Карточки саб-агентов рендерит сам ToolChain
                      внутри ленты (renderIterExtra) — здесь их больше нет,
                      иначе в чате было бы два одинаковых блока. */}
                  {/* Сгенерированные изображения внутри persisted-итерации */}
                  {iter.steps
                    .filter(s => s.type === 'tool_result' && s.imageUrl)
                    .map(s => (
                      <div key={s.id} className="message-image-wrap">
                        <img
                          src={`file://${s.imageUrl}`}
                          alt="Сгенерированное изображение"
                          className="message-image"
                          loading="lazy"
                          decoding="async"
                          onClick={() => window.open(`file://${s.imageUrl}`, '_blank')}
                        />
                      </div>
                    ))}
                </div>
                )
              })}
              {/* Итоговый ответ из тега <final_answer>: рендерится под лентой
                  хода работы, даже если модель после ответа успела вызвать тул
                  (иначе текст уезжал заметкой в свёрнутую ленту). */}
              {!editorActive && taggedAnswer && (
                <div className="message-iteration">
                  <div className="message-content selectable">
                    <ParsedContent text={taggedAnswer} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} mdComponents={mdComponents} workdir={workdir} />
                  </div>
                </div>
              )}
            </div>
          )
        })()}

        {/* Карточки саб-агентов теперь рендерит ToolChain внутри ленты
            (renderIterExtra) — отдельного блока здесь больше нет. */}

        {/* Сгенерированные изображения из tool steps — мемоизированные */}
        {!isUser && !liveIters?.length && toolImages.map(s => (
          <div key={s.id} className="message-image-wrap">
            <img
              src={`file://${s.imageUrl}`}
              alt="Сгенерированное изображение"
              className="message-image"
              loading="lazy"
              decoding="async"
              onClick={() => window.open(`file://${s.imageUrl}`, '_blank')}
            />
          </div>
        ))}

        {/* Сгенерированное изображение */}
        {message.imageUrl && (
          <div className="message-image-wrap">
            <img
              src={message.imageUrl}
              alt="Generated"
              className="message-image"
              loading="lazy"
              decoding="async"
              onClick={() => window.open(message.imageUrl, '_blank')}
            />
          </div>
        )}

        {/* Thinking block — только для обычного чата (без итераций).
            В agent mode thinking рендерится внутри итераций и как liveThinking.
            Проверяем !iterations?.length чтобы не дублировать последний reasoning-блок,
            который уже отрендерен внутри итераций выше. */}
        {!isUser && !liveIters?.length && !(message as Message & { iterations?: unknown[] }).iterations?.length && (message.thinking || liveThinking) && (
          <ThinkingBlock
            text={message.thinking}
            liveText={liveThinking?.text}
            thinkingMs={message.thinkingMs ?? liveThinking?.ms}
            isLive={liveThinking?.isLive}
            storeChatId={liveThinking?.storeChatId}
          />
        )}

        {/* Индикатор ожидания — сразу при отправке и пока AI не начал писать.
            Исключение: в ленте только карточки мини-агентов (assistantCardsOnly)
            — это старт рана, «Думаю…» должен остаться видимым. */}
        {!isUser && (isStreaming || isWaiting) && !content && !liveThinking && !message.thinking && (!liveIters?.length || assistantCardsOnly) && (
                    <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} retry={retry} lastError={lastError} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} toolProgress={toolProgress} />
        )}

        {/* §4.3 — видимый чек-лист плана (todo list).
            Для сохранённого сообщения — message.todo (из БД).
            Для live-пузыря — liveTodo (пока стримится, до save). */}
        {!isUser && (() => {
          const todo = message.todo ?? liveTodo
          return todo && todo.length > 0 ? <TodoChecklist items={todo} /> : null
        })()}

        {/* ── ИТЕРАЦИОННЫЙ РЕНДЕР (live агент: textBefore → toolchain → textAfter) ── */}
        {!isUser && liveIters && liveIters.length > 0 ? (
          <div className="message-segments">
            {/* ОДИН блок хода работы на всё сообщение */}
            {chainStepCount > 0 && (
              <ToolChain
                sections={chainSections}
                workdir={workdir}
                mode={toolOutputMode}
                isRunning={liveChainRunning}
                busy={isStreaming}
                toolProgress={toolProgress}
                liveThinking={liveThinkingInChain}
                chatId={message.chatId}
                renderIterExtra={renderIterExtra}
              />
            )}
            {liveIters.map((iter, ii) => {
              const isLastIter = ii === liveIters.length - 1
              const lastStepIsResult = iter.steps[iter.steps.length - 1]?.type === 'tool_result'
              // Параллельные тулы (Promise.all в Agent.ts): первый tool_result
              // встаёт последним шагом, пока остальные вызовы ещё выполняются.
              // Раньше isRunning падал в false по «последний шаг = результат» →
              // тулчейн выглядел завершённым (таймер замерзал, спиннеры и бейджи
              // «выполняется» исчезали, пачки одинаковых тулов схлопывались),
              // хотя 2 из 3 тулов ещё работали.
              const unfinished = hasUnfinishedCalls(iter.steps)
              const hasSteps = iter.steps.length > 0
              // В ленте живёт ВЫЧИЩЕННЫЙ текст итерации: блок <final_answer>
              // вынут в taggedAnswer ниже и рендерится ответом, а не заметкой.
              const iterText = renderIters?.[ii]?.textBefore ?? iter.textBefore
              return (
                <div key={ii} className="message-segment">
                  {/* Итерация без тулов (финальный ответ / чистый reasoning) —
                      её текст и рассуждение остаются в сообщении. */}
                  {iter.thinking && !hasSteps && (
                    <ThinkingBlock text={iter.thinking} thinkingMs={iter.thinkingMs} />
                  )}
                  {!hasSteps && iterText && (
                    <div className="message-content selectable">
                      <ParsedContent text={iterText} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} mdComponents={mdComponents} workdir={workdir} />
                    </div>
                  )}
                  {/* Карточки саб-агентов больше не рендерятся
                      здесь: они живут ВНУТРИ ленты, под своим шагом
                      (см. renderIterExtra → ToolChain). */}
                  {/* Сгенерированные изображения внутри live-итерации */}
                  {iter.steps
                    .filter(s => s.type === 'tool_result' && s.imageUrl)
                    .map(s => (
                      <div key={s.id} className="message-image-wrap">
                        <img
                          src={`file://${s.imageUrl}`}
                          alt="Сгенерированное изображение"
                          className="message-image"
                          loading="lazy"
                          decoding="async"
                          onClick={() => window.open(`file://${s.imageUrl}`, '_blank')}
                        />
                      </div>
                    ))}
                  {/* Пульс после тулчейна пока AI думает (ждёт следующего токена).
                      !unfinished: при параллельных тулах не показываем «ожидание»,
                      пока остальные вызовы ещё выполняются — тулчейн сам крутит
                      спиннеры. */}
                  {isStreaming && isLastIter && lastStepIsResult && !unfinished && !liveTextAfterClean && !liveThinking && (
          <WaitingIndicator rateLimitSec={rateLimitSec} agentStatus={agentStatus} retry={retry} lastError={lastError} filesChanged={agentCounts.filesChanged} commandsRun={agentCounts.commandsRun} />
                  )}
                </div>
              )
            })}
            {/* Live thinking — текущий стримящийся блок рассуждения,
                на позиции после последней итерации, перед текстом ответа.
                Условие: isLive (стрим идёт) или ms задан (thinking завершён,
                текст ещё в store до save). text убран из liveThinking —
                ThinkingBlock читает его из store через storeChatId. */}
            {liveThinking && (liveThinking.isLive || liveThinking.ms !== undefined) &&
              // Если у последней итерации есть тулы — live-thinking уже
              // отрендерен последней строкой её цепочки (единая лента).
              !(isStreaming && liveIters[liveIters.length - 1]?.steps?.length > 0) && (
              <ThinkingBlock
                liveText={liveThinking?.text}
                thinkingMs={liveThinking.ms}
                isLive={liveThinking.isLive}
                storeChatId={liveThinking.storeChatId}
              />
            )}
            {/* Итоговый ответ из <final_answer>, вынутый из итераций: остаётся
                ответом под лентой, даже если модель после него вызвала тул. */}
            {taggedAnswer && (
              <div className="message-content selectable">
                <ParsedContent text={taggedAnswer} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} mdComponents={mdComponents} workdir={workdir} />
              </div>
            )}
            {/* Текст ПОСЛЕ всех тулов (финальный ответ текущей итерации) */}
            {liveTextAfterClean && (
              <div className="message-content selectable">
                <ParsedContent text={liveTextAfterClean} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} isStreaming={isStreaming} mdComponents={mdComponents} workdir={workdir} />
              </div>
            )}
          </div>
        ) : (
          /* ── ОБЫЧНЫЙ РЕНДЕР (нет live итераций — обычный чат или финальное сообщение) ── */
          /* Если есть сохранённые iterations — content уже покрыт ими, не дублируем */
          (() => {
            type Iter = { label?: string; textBefore: string; thinking?: string; thinkingMs?: number; steps: import('../ToolChain/ToolChain').ToolStep[] }
            const savedIters = (message as Message & { iterations?: Iter[] }).iterations
            // ── Реплай-цитаты: inline-чипы В ПОТОКЕ ТЕКСТА (как вложения) ──
            // Не отдельный блок над контентом — первые элементы текста,
            // теми же классами .inline-attach. title — полный текст исходника.
            const replyChips = isUser && message.replyTo?.length ? message.replyTo.map(r => {
              const quoteText = stripAttachTokens(r.content || '')
              const full = quoteText || (r.attachmentsCount ? `Сообщение с вложением (${r.attachmentsCount} файл.)` : 'Сообщение без текста')
              return (
                <span key={r.id} className="inline-attach inline-attach--reply" title={`Ответ на ${r.role === 'user' ? 'ваше сообщение' : 'сообщение Syntee'}:\n${full.slice(0, 500)}${full.length > 500 ? '…' : ''}`}>
                  <span className="inline-attach-icon">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 14 4 9 9 4" />
                      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                    </svg>
                  </span>
                  <span className="inline-attach-name">
                    <span className="inline-attach-reply-role">{r.role === 'user' ? 'Вы' : 'Syntee'}</span>
                    <span className="inline-attach-reply-sep"> · </span>
                    {quoteText.slice(0, 80) || (r.attachmentsCount ? `вложение ×${r.attachmentsCount}` : '')}
                    {quoteText.length > 80 ? '…' : ''}
                  </span>
                </span>
              )
            }) : null
            // ── Редактор чата: текст сообщения → textarea с черновиком ──
            // Для сообщений с iterations текст правится ПОСЕГМЕНТНО в блоке
            // рендера итераций выше (textarea на каждом textBefore) — здесь
            // отдельный textarea для content не нужен (content в UI не
            // рендерится при наличии итераций, пересобирается при apply).
            if (editorActive) {
              if (!isUser && savedIters?.length) return null
              return (
                <div className="message-content message-content--editing">
                  <EditorTextarea
                    value={editorDraft?.content ?? content}
                    onChange={v => updateEditorDraft(message.id, { content: v })}
                  />
                </div>
              )
            }
            if (!isUser && savedIters?.length) return null
            // ── User-сообщения с inline-токенами вложений [[attach:id]] ──
            // Чипы восстанавливаются НА СВОИХ МЕСТАХ в потоке текста (как в
            // инпут-баре). Markdown при наличии токенов игнорируем — чипы
            // важнее. Старый формат (attachments без токенов) — ветки ниже.
            if (isUser && hasAttachTokens(content)) {
              const attMap = new Map((message.attachments ?? []).map(a => [a.id, a] as const))
              return (
                <div className="message-content selectable">
                  <p style={{ whiteSpace: 'pre-wrap' }}>
                    {replyChips}
                    {inlineCmdFrag}
                    {splitByAttachTokens(content).map((seg, i) => {
                      // Первый текстовый сегмент содержит команду — она уже
                      // отрисована чипами inlineCmdFrag, срезаем её из текста.
                      if (seg.type === 'text') {
                        const text = i === 0 && inlineCmd ? seg.text.slice(inlineCmd.consumed) : seg.text
                        return <React.Fragment key={i}>{renderClickablePlainText(text, workdir, onOpenFile)}</React.Fragment>
                      }
                      return <React.Fragment key={i}>{renderAttachChip(attMap.get(seg.id), onPreviewAttachment)}</React.Fragment>
                    })}
                  </p>
                </div>
              )
            }
            return (
              <div className="message-content selectable">
                {isUser && !userMarkdown ? (
                  <p style={{ whiteSpace: 'pre-wrap' }}>{replyChips}{inlineCmdFrag}{renderClickablePlainText(cmdRest, workdir, onOpenFile)}</p>
                ) : isUser ? (
                  // User-сообщения с markdown: чипы команды + остаток через
                  // ParsedContent (с кэшем) — консистентно с ассистентскими.
                  <>
                    {inlineCmdFrag}
                    {cmdRest.trim() ? (
                      <ParsedContent text={cmdRest} allowPlanCard={false} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} mdComponents={mdComponents} workdir={workdir} />
                    ) : null}
                  </>
                ) : (
                  // Ассистентские сообщения — через ParsedContent с module-level
                  // кэшем: scroll-remount виртуализатора и hover (showActions)
                  // больше не ре-парсят markdown (0.3–0.5с фриз на большом сообщении).
                  // isStreaming: для live-пузыря без итераций — лёгкий рендер
                  // во время стрима, полный парс при done.
                  <ParsedContent text={content} allowPlanCard={allowPlanCard} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} planFilePath={message.planData?.filePath} isStreaming={isStreaming} mdComponents={mdComponents} workdir={workdir} />
                )}
              </div>
            )
          })()
        )}

        {/* Inline-вложения user-сообщения — ПОСЛЕ текста. ТОЛЬКО для старого
            формата (attachments без токенов в content): новые сообщения
            рендерят чипы на своих местах внутри текста (ветка выше).
            renderAttachChip — общий рендер: файлы → превью, chat/project →
            навигация (tabActions.selectChat). */}
        {isUser && message.attachments && message.attachments.length > 0 && !hasAttachTokens(content) && (
          <div className="message-inline-attachments">
            {message.attachments.map(att => (
              <React.Fragment key={att.id}>{renderAttachChip(att, onPreviewAttachment)}</React.Fragment>
            ))}
          </div>
        )}

        {/* Файлы, которые агент создал/изменил в этом сообщении — чипами в
            конце ответа (визуально как inline-вложения [[attach:...]]).
            Данные целиком из шагов сообщения: отдельного состояния нет,
            поэтому карточка работает и на старых чатах.

            ТОЛЬКО на готовом ответе: live-пузырь (id 'live-streaming-bubble')
            во время рана не считается — иначе список файлов появлялся бы и
            прыгал прямо во время генерации. Персистентное сообщение приходит
            из main в CHAT_STREAM_DONE (saveMessageAndDeleteStreamingBuffer),
            т.е. в момент, когда ответ действительно завершён (в т.ч. ошибка
            или ручная остановка). isStreaming — вторая страховка на случай
            live-рендера с нестандартным id. */}
        {!isUser && !editorActive && !isLiveBubble && !isStreaming && messageSteps.length > 0 && (
          <MessageFileChanges steps={messageSteps} workdir={workdir} />
        )}

        {/* Footer: кнопки действий + время + панель статистики */}
        <div className="message-footer">
          <div className="message-actions">
            {editorActive ? (
              <>
                {/* ── Контролы редактора чата ── */}
                <IconButton
                  icon={hiddenNow ? 'eye' : 'eyeOff'}
                  label={hiddenNow ? 'Вернуть в контекст' : 'Скрыть из контекста'}
                  className="msg-action-btn"
                  active={hiddenNow}
                  onClick={() => updateEditorDraft(message.id, { hidden: !hiddenNow })}
                />
                <IconButton
                  icon="trash"
                  label="Удалить навсегда"
                  className="msg-action-btn"
                  danger
                  onClick={() => updateEditorDraft(message.id, { deleted: true })}
                />
                {hasDraft && (
                  <IconButton
                    icon="rewind"
                    label="Отменить правки этого сообщения"
                    className="msg-action-btn"
                    onClick={() => clearEditorDraft(message.id)}
                  />
                )}
              </>
            ) : (
              <>
                <IconButton icon="copy" label="Копировать" className="msg-action-btn" onClick={onCopy} />
                <IconButton icon="pin" label="Закрепить" className="msg-action-btn" onClick={() => onPin?.(message.id)} />
                {!isLiveBubble && message.chatId && message.content?.trim() && useChatStore.getState().chats.some(chat => chat.id === message.chatId && !chat.isIncognito) && (
                  <IconButton icon="pin" label="Добавить в сводку" className="msg-action-btn" onClick={() => {
                    // A task-summary note only: does not pin context or write memory.
                    const chat = useChatStore.getState().chats.find(chat => chat.id === message.chatId)
                    if (!chat || chat.isIncognito) return
                    const note = message.content.replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/gi, '').trim().slice(0, 500)
                    if (!note) return
                    void window.syntee.taskSummary.addPin(message.chatId, note, message.id)
                      .then(state => {
                        if (!state.manualPins.some(pin => pin.messageId === message.id)) throw new Error('Note was not saved')
                        useToast.getState().add('Добавлено в сводку задачи', 'success')
                      })
                      .catch(() => useToast.getState().add('Не удалось добавить сообщение в сводку', 'error'))
                  }} />
                )}
                {onReply && <IconButton icon="reply" label="Ответить" className="msg-action-btn" onClick={onReply} />}
                {isUser && onRewind && <IconButton icon="rewind" label="Откатить к этому сообщению" className="msg-action-btn" onClick={onRewind} />}
                {!isUser && <IconButton icon="volume" label="Озвучить" className="msg-action-btn" onClick={onReadAloud} />}
                {/* Редактор чата: карандаш открывает режим inline-правки */}
                {editorAvailable && !isLiveBubble && (
                  <IconButton icon="edit" label="Редактировать сообщения чата" className="msg-action-btn" onClick={() => enterEditorMode(message.chatId)} />
                )}
                {/* Пункты контекстного меню от плагинов (registerContextMenu) */}
                <PluginMessageCtxMenu message={message} />
                {/* Кнопки-декорации от плагинов (registerContextMenu button) */}
                <PluginMessageButtons message={message} />
              </>
            )}
          </div>
          {(() => {
            const hasStats = !isUser && (
              message.durationMs != null || message.promptTokens != null ||
              message.completionTokens != null || message.toolCallsCount != null ||
              message.finishReason != null
            )
            const dur = message.durationMs
            const durStr = dur == null ? '' : formatDuration(dur)
            const fmtMs = (ms?: number) => (ms == null ? '' : formatDuration(ms))
            const totalTokens = (message.promptTokens ?? 0) + (message.completionTokens ?? 0)
            // Скорость генерации — из ЧИСТОГО времени стриминга (streamingMs,
            // без пауз на тулы и обработку промпта). Fallback на durationMs —
            // старые сообщения без streamingMs. Гард 500мс: на коротких
            // ответах стриминг слишком мал для осмысленной скорости.
            const speedBaseMs = (message.streamingMs != null && message.streamingMs >= 500)
              ? message.streamingMs
              : ((dur != null && dur >= 1000) ? dur : null)
            const speed = speedBaseMs != null && message.completionTokens != null
              ? message.completionTokens / (speedBaseMs / 1000)
              : null
            const finishLabel = message.finishReason === 'stopped'
              ? 'Остановлено вручную'
              : message.finishReason === 'error' ? 'Оборвано (ошибка)' : null
            const itersCount = (message as { iterations?: unknown[] }).iterations?.length ?? 0
            return (
              <>
                {hasStats && (
                  <button
                    type="button"
                    className={`message-stats-btn${statsOpen ? ' message-stats-btn--active' : ''}`}
                    onClick={() => setStatsOpen(v => !v)}
                    title="Статистика ответа"
                    aria-label="Статистика ответа"
                    aria-expanded={statsOpen}
                  >
                    <AppIcon name="info" size="xs" tone={statsOpen ? 'accent' : 'muted'} />
                  </button>
                )}
                {/* Бейдж «как завершился turn» — видно сразу в футере, без
                    разворачивания панели: ⏹ остановлено / ⚠ оборвано ошибкой. */}
                {!isUser && finishLabel && (
                  <span
                    className={`message-finish-badge message-finish-badge--${message.finishReason}`}
                    title={finishLabel}
                  >
                    {message.finishReason === 'stopped' ? '⏹ остановлено' : '⚠ оборвано'}
                  </span>
                )}
                {/* Скрыто из AI-контекста: бейдж с кликом «вернуть» (вне режима
                    редактора — мгновенная запись в БД + патч локального стора). */}
                {!editorActive && hiddenNow && (
                  <button
                    type="button"
                    className="message-hidden-badge"
                    title="AI это сообщение не видит. Клик — вернуть в контекст"
                    onClick={() => {
                      void window.syntee.chat.setMessageHidden(message.id, false)
                      patchMessage(message.id, { hiddenFromContext: 0 })
                    }}
                  >
                    <AppIcon name="eyeOff" size="xs" tone="muted" />
                    скрыто из контекста
                  </button>
                )}
                {timeEl}
                <AnimatePresence>
                  {statsOpen && hasStats && (
                    <motion.div
                      ref={statsPanelRef}
                      className={`message-stats-panel${statsBelow ? ' message-stats-panel--below' : ''}`}
                      initial={{ opacity: 0, y: 6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.97 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    >
                    {finishLabel && (
                      <div className={`message-stats-row message-stats-row--finish message-stats-row--finish-${message.finishReason}`}>
                        <AppIcon name={message.finishReason === 'stopped' ? 'pause' : 'alertTriangle'} size="xs" tone={message.finishReason === 'stopped' ? 'muted' : 'warning'} />
                        <span className="message-stats-label">Статус</span>
                        <span className="message-stats-value">{finishLabel}</span>
                      </div>
                    )}
                    {message.model && message.model !== 'error' && (
                      <div className="message-stats-row">
                        <AppIcon name="cpu" size="xs" tone="muted" />
                        <span className="message-stats-label">Модель</span>
                        <span className="message-stats-value">{message.model}</span>
                      </div>
                    )}
                    {durStr && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(Math.round((dur ?? 0) / 100) / 10)} с`}>
                        <AppIcon name="clock" size="xs" tone="muted" />
                        <span className="message-stats-label">Длительность</span>
                        <span className="message-stats-value">{durStr}</span>
                      </div>
                    )}
                    {message.promptTokens != null && (
                      <div
                        className="message-stats-row"
                        title={`Сумма prompt_tokens по всем LLM-вызовам хода (tool-раунды), а не размер контекста. Точно: ${formatTokensFull(message.promptTokens)} токенов`}
                      >
                        <span className="message-stats-arrow message-stats-arrow--up">↑</span>
                        <span className="message-stats-label">Вход за ход</span>
                        <span className="message-stats-value">{formatTokens(message.promptTokens)}</span>
                      </div>
                    )}
                    {message.completionTokens != null && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(message.completionTokens)} токенов`}>
                        <span className="message-stats-arrow message-stats-arrow--down">↓</span>
                        <span className="message-stats-label">Выход</span>
                        <span className="message-stats-value">{formatTokens(message.completionTokens)}</span>
                      </div>
                    )}
                    {totalTokens > 0 && (
                      <div className="message-stats-row" title={`Вход за ход + выход. Размер текущего контекста смотри в кольце контекста. Точно: ${formatTokensFull(totalTokens)} токенов`}>
                        <AppIcon name="layers" size="xs" tone="muted" />
                        <span className="message-stats-label">Всего за ход</span>
                        <span className="message-stats-value">{formatTokens(totalTokens)}</span>
                      </div>
                    )}
                    {!!message.cacheReadTokens && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(message.cacheReadTokens)} токенов`}>
                        <span className="message-stats-arrow">≡</span>
                        <span className="message-stats-label">Кэш чтение</span>
                        <span className="message-stats-value">{formatTokens(message.cacheReadTokens)}</span>
                      </div>
                    )}
                    {!!message.cacheWriteTokens && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(message.cacheWriteTokens)} токенов`}>
                        <span className="message-stats-arrow">≡</span>
                        <span className="message-stats-label">Кэш запись</span>
                        <span className="message-stats-value">{formatTokens(message.cacheWriteTokens)}</span>
                      </div>
                    )}
                    {speed != null && speed > 0 && (
                      <div className="message-stats-row" title={`Точно: ${formatTokensFull(Math.round(speed))} токенов/с — по чистому времени генерации (${formatDuration(speedBaseMs ?? 0)})`}>
                        <AppIcon name="zap" size="xs" tone="muted" />
                        <span className="message-stats-label">Скорость</span>
                        <span className="message-stats-value">{speed >= 100 ? Math.round(speed) : speed.toFixed(1)} ток/с</span>
                      </div>
                    )}
                    {message.thinkingMs != null && message.thinkingMs > 0 && (
                      <div className="message-stats-row">
                        <AppIcon name="brain" size="xs" tone="muted" />
                        <span className="message-stats-label">Размышления</span>
                        <span className="message-stats-value">{fmtMs(message.thinkingMs)}</span>
                      </div>
                    )}
                    {itersCount > 1 && (
                      <div className="message-stats-row">
                        <AppIcon name="listChecks" size="xs" tone="muted" />
                        <span className="message-stats-label">Итерации</span>
                        <span className="message-stats-value">{itersCount}</span>
                      </div>
                    )}
                    {message.toolCallsCount != null && (
                      <div className="message-stats-row">
                        <AppIcon name="wrench" size="xs" tone="muted" />
                        <span className="message-stats-label">Вызовы тулов</span>
                        <span className="message-stats-value">{message.toolCallsCount}</span>
                      </div>
                    )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )
          })()}
        </div>
      </div>
    </div>
  )
})

// Аватар ассистента — несколько стилей
function AssistantAvatar({ style }: { style: AvatarStyle }) {
  if (style === 'none') return null
  if (style === 'circle') return (
    <div className="message-avatar message-avatar--circle"
      style={{
        width: 10, height: 10, borderRadius: '50%',
        background: 'var(--accent-bg)', opacity: 0.7,
      }}
    />
  )
  if (style === 'letter') return (
    <div className="message-avatar message-avatar--letter">S</div>
  )
  if (style === 'emoji') return (
    <div className="message-avatar message-avatar--emoji">🤖</div>
  )
  // hex (default)
  return (
    <div className="message-avatar">
      <Logo size={18} />
    </div>
  )
}


const MessageBubble = memo(function MessageBubble({
  message, onPin, onCopy, onReadAloud, onReply, onRewind, toolOutputMode = 'normal', searchQuery, liveThinking, isStreaming, isWaiting, rateLimitSec, shouldAnimate = true, workdir, editorAvailable = true,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // ── Редактор чата: черновик этого сообщения (для корневых модификаторов) ──
  // deleted — сообщение схлопывается в полоску «будет удалено»; hidden —
  // затемнение + пунктир. Вне режима редактора — всегда undefined (stable).
  const editorDraft = useChatStore(s => (s.editorChatId === message.chatId ? s.editorDrafts[message.id] : undefined))
  const clearEditorDraft = useChatStore(s => s.clearEditorDraft)
  const editorDeleted = !!editorDraft?.deleted
  const contextHidden = editorDraft?.hidden !== undefined ? editorDraft.hidden : !!message.hiddenFromContext
  // Есть несохранённые правки (кроме удаления) → акцентная подсветка пузыря.
  const editorDraftDirty = !!editorDraft && !editorDraft.deleted

  // ── Live-текст из store: только для live-пузыря ──────────────────────
  // ChatPage больше не кладёт streamingText в displayMessages → memo
  // стабилен между 50мс-флашами → виртуализатор не инвалидирует кэш.
  // MessageBubble сам подписывается на live.text по message.chatId.
  // Для не-live: селектор возвращает undefined → '' → stable → 0 ре-рендеров.
  // Для live: селектор возвращает live.text → меняется 20×/сек →
  // MessageBubble ре-рендерится (только live-пузырь, остальные не затронуты).
  // Условие isLiveBubble (без isStreaming): после завершения стрима
  // live.text ещё не сброшен → текст виден до прихода реального сообщения.
  const isLiveBubble = message.id === 'live-streaming-bubble' || message.id === 'split-live-streaming-bubble'
  const liveText = useChatStore(s =>
    isLiveBubble && message.chatId
      ? s.liveByChat[message.chatId]?.text
      : undefined
  ) ?? ''
  // ── Live-state from store: only for live-bubble ─────────────────────
  // Раньше эти поля паковались в live-bubble объект через displayMessages
  // → displayMessages ре-вычислялся на каждый tool step / progress event →
  // виртуализатор инвалидировал кэш, другие ряды затрагивались. Теперь
  // MessageBubble сам подписывается на нужные поля store (как уже делал для
  // live.text). displayMessages стабилен между tool-событиями.
  const liveItersFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.iters : undefined
  )
  const liveTodoFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.todo : undefined
  )
  const agentStatusFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.agentStatus : undefined
  )
  const toolProgressFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.toolProgress : undefined
  )
  const spawnedAgentsFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.spawnedAgents : undefined
  )
  const retryFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.retry : undefined
  )
  const lastErrorFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.lastError : undefined
  )
  const liveStepsFromStore = useChatStore(s =>
    isLiveBubble && message.chatId ? s.liveByChat[message.chatId]?.steps : undefined
  )
  // Служебные теги <final_answer> невидимы: срезаем их и из живого текста
  // (в т.ч. недописанный хвост тега, чтобы он не мигал при печати), и из
  // сохранённого content (на случай ответов вне agent-цикла). User-сообщения
  // не трогаем: у них «<» в конце — обычный текст, а не наш тег.
  const effectiveContent = isLiveBubble
    ? stripFinalMarkersStreaming(liveText || message.content)
    : (isUser ? message.content : stripFinalMarkersStreaming(message.content))
  const effectiveLiveTextAfter = isLiveBubble
    ? liveText
    : (message as Message & { liveTextAfter?: string }).liveTextAfter

  // Превью вложения (модалка-лайтбокс)
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null)

  const handleCopy = useCallback(async () => {
    // Токены вложений → Markdown-ссылки НА СВОИХ МЕСТАХ в тексте
    let textToCopy = message.attachments?.length
      ? replaceAttachTokensWithLinks(effectiveContent, message.attachments)
      : effectiveContent
    if (message.attachments?.length) {
      // Старый формат: вложения без токенов в тексте — ссылками в конец
      const tokenIds = new Set(
        splitByAttachTokens(effectiveContent).filter(s => s.type === 'attach').map(s => s.id),
      )
      const legacy = message.attachments.filter(a => !tokenIds.has(a.id))
      if (legacy.length) {
        const md = attachmentsToMarkdown(legacy)
        if (md) textToCopy = textToCopy + '\n\n' + md
      }
    }
    const ok = await copyToClipboard(textToCopy)
    if (ok) onCopy?.(textToCopy)
  }, [effectiveContent, message.attachments, onCopy])

  const handleReply = useCallback(() => {
    onReply?.(message)
  }, [message, onReply])

  const handleRewind = useCallback(() => {
    onRewind?.(message.id)
  }, [message.id, onRewind])

  const handleReadAloud = useCallback(() => {
    onReadAloud?.(effectiveContent)
  }, [effectiveContent, onReadAloud])

  // Узкие селекторы вместо useUIStore() — иначе каждый пузырь ре-рендерится
  // при любом UI-изменении (agentPanelWidth, glassBlur, accentColor и т.д.).
  const msgAnim = useUIStore(s => s.msgAnim)
  const avatarStyle = useUIStore(s => s.avatarStyle)
  const showTime = useUIStore(s => s.showTime)
  const userMarkdown = useUIStore(s => s.userMarkdown)
  const anim = MSG_ANIM_VARIANTS[msgAnim] ?? MSG_ANIM_VARIANTS.slide

  // Очистка остаточного inline transform после entrance-анимации framer-motion.
  // framer-motion оставляет transform в inline-style (напр. translateX(0px))
  // даже после завершения entrance-анимации → .message-wrap промоутится в
  // постоянный GPU-композитный слой с текстурой размером с содержимое. Для
  // сообщения с развёрнутым PlanCard этот слой огромный (markdown 1500-3000px)
  // → compositor пересчитывает его каждый кадр скролла → просадки FPS. Очистка
  // transform:none схлопывает слой. Анимация появления не страдает: entrance
  // проигрывается до onAnimationComplete, после — transform не нужен.
  // Для scroll-remount (initial={false}, анимации нет) чистим сразу в rAF.
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shouldAnimate) return
    const el = wrapRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => { el.style.transform = 'none' })
    return () => cancelAnimationFrame(raf)
  }, [shouldAnimate])
  const handleAnimComplete = useCallback(() => {
    const el = wrapRef.current
    if (el) el.style.transform = 'none'
  }, [])

  // Время — always / hover / never.
  // useMemo: timeEl стабилен между ре-рендерами (deps — showTime и
  // createdAt, оба стабильны для не-live) → MessageContent memo
  // не пробивается новым timeEl-референсом при скролл-ре-рендерах.
  const timeEl = useMemo(() => showTime !== 'never' ? (
    <span className={`message-time ${showTime === 'hover' ? 'message-time--hover' : ''}`}>
      {new Date(message.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
    </span>
  ) : null, [showTime, message.createdAt])

  // System-сообщения (откаты, сжатие контекста, системные уведомления)
  // рендерим как стилизованную разделительную полосу поперёк чата — не
  // как пузырь.
  if (message.role === 'system') {
    const isRewind = message.slashCommand?.name === 'rewind'
    const isCompact = message.slashCommand?.name === 'compact' && message.slashCommand?.args !== 'pending'
    const isCompacting = message.slashCommand?.name === 'compact' && message.slashCommand?.args === 'pending'
    // liveSummary — стримящееся резюме при manual /compact (токены приходят
    // через chat:compact-stream). Только у синтетического compacting-индикатора.
    const liveSummary = (message as Message & { compactLiveSummary?: string }).compactLiveSummary
    return <SystemDivider message={message} isRewind={isRewind} isCompact={isCompact} isCompacting={isCompacting} timeEl={timeEl} liveSummary={liveSummary} />
  }

  // ── Редактор чата: помеченное к удалению сообщение схлопывается в полоску.
  // Реальное удаление — при «Применить и закрыть» (applyEditorDrafts).
  if (editorDeleted) {
    return (
      <div className="message-wrap message-wrap--editor-deleted">
        <div className="message-editor-deleted-strip">
          <AppIcon name="trash" size="xs" tone="muted" />
          <span>Сообщение будет удалено</span>
          <button type="button" className="message-editor-restore-btn" onClick={() => clearEditorDraft(message.id)}>
            Вернуть
          </button>
        </div>
      </div>
    )
  }

  return (
    <motion.div
      className={`message-wrap ${isUser ? 'message-wrap--user' : 'message-wrap--assistant'} ${searchQuery ? 'message-wrap--search-match' : ''} ${contextHidden ? 'message-wrap--context-hidden' : ''} ${editorDraftDirty ? 'message-wrap--editor-draft' : ''}`}
      ref={wrapRef}
      // shouldAnimate=false → initial={false}: framer-motion сразу рисует в
      // финальном состоянии без проигрывания entrance. При scroll-remount того
      // же сообщения анимация не повторяется (убирает «плывущий» скролл).
      initial={shouldAnimate ? anim.initial : false}
      animate={anim.animate}
      transition={anim.transition}
      onAnimationComplete={handleAnimComplete}
    >
      {!isUser && <AssistantAvatar style={avatarStyle} />}

      {message.planData ? (
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
          <MessageContent
            content={effectiveContent}
            isUser={isUser}
            searchQuery={searchQuery}
            toolOutputMode={toolOutputMode}
            toolSteps={isLiveBubble ? (liveStepsFromStore as Message['toolSteps']) : message.toolSteps}
            onPin={onPin}
            onCopy={handleCopy}
            onReadAloud={handleReadAloud}
            onReply={handleReply}
            onRewind={handleRewind}
            message={message}
            isPinned={message.isPinned as number}
            createdAt={message.createdAt}
            liveThinking={liveThinking}
            isStreaming={isStreaming}
            isWaiting={isWaiting}
            liveIters={liveItersFromStore}
            liveTodo={liveTodoFromStore}
            liveTextAfter={effectiveLiveTextAfter}
            rateLimitSec={rateLimitSec}
            userMarkdown={isUser ? userMarkdown : true}
            timeEl={timeEl}
            agentStatus={agentStatusFromStore}
            retry={retryFromStore}
            lastError={lastErrorFromStore}
            toolProgress={toolProgressFromStore}
            spawnedAgents={spawnedAgentsFromStore}
            onPreviewAttachment={setPreviewAttachment}
            workdir={workdir}
            editorAvailable={editorAvailable}
          />
        </div>
      ) : (
      <MessageContent
        content={effectiveContent}
        isUser={isUser}
        searchQuery={searchQuery}
        toolOutputMode={toolOutputMode}
        toolSteps={isLiveBubble ? (liveStepsFromStore as Message['toolSteps']) : message.toolSteps}
        onPin={onPin}
        onCopy={handleCopy}
        onReadAloud={handleReadAloud}
        onReply={handleReply}
        onRewind={handleRewind}
        message={message}
        isPinned={message.isPinned as number}
        createdAt={message.createdAt}
        liveThinking={liveThinking}
        isStreaming={isStreaming}
        isWaiting={isWaiting}
        liveIters={liveItersFromStore}
        liveTodo={liveTodoFromStore}
        liveTextAfter={effectiveLiveTextAfter}
        rateLimitSec={rateLimitSec}
        userMarkdown={isUser ? userMarkdown : true}
        timeEl={timeEl}
        agentStatus={agentStatusFromStore}
        retry={retryFromStore}
        lastError={lastErrorFromStore}
        toolProgress={toolProgressFromStore}
        spawnedAgents={spawnedAgentsFromStore}
        onPreviewAttachment={setPreviewAttachment}
        workdir={workdir}
        editorAvailable={editorAvailable}
      />
      )}

      {/* Модалка превью вложения — лайтбокс для картинок, CodePreview для файлов.
          key={id} — перемонтирует компонент при смене вложения, сбрасывая zoom/pan. */}
      <AttachmentPreviewModal
        key={previewAttachment?.id ?? 'none'}
        attachment={previewAttachment}
        onClose={() => setPreviewAttachment(null)}
      />
    </motion.div>
  )
})

export default MessageBubble

