import { useState, useRef, useEffect, useCallback, memo, KeyboardEvent, DragEvent, ClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import ApprovalModeSelector from '../ApprovalModeSelector/ApprovalModeSelector'
import ContextRing from '../ContextRing/ContextRing'
import ReasoningSelector from '../ReasoningSelector/ReasoningSelector'
import ModelSelector from '../ModelSelector/ModelSelector'
import SlashMenu from '../SlashMenu/SlashMenu'
import MentionMenu from '../MentionMenu/MentionMenu'
import CommandArgMenu from '../CommandArgMenu/CommandArgMenu'
import AttachmentChips from '../AttachmentChips/AttachmentChips'
import QueuePanel from '../QueuePanel/QueuePanel'
import ExtensionsBadge from '../ExtensionsBadge/ExtensionsBadge'
import ChangesBadge from '../ChangesBadge/ChangesBadge'
import { filterCommands } from '../../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import { findMentionTokenAtCaret, mentionToAttachment, mimeFromExt, isImageMime } from '../../../../../shared/mentions'
import type { Attachment, MentionItem, ApprovalMode, LastTurnChanges } from '../../../../../shared/types'
import { PERSONAS, getPersona, DEFAULT_PERSONA, type PersonaId } from '../../../../../shared/modes'
import type { ContextInfo } from '../../../hooks/useContextCounter'
import { useUIStore } from '../../../store/ui.store'
import { useSettingsStore } from '../../../store/settings.store'
import { useVoiceInput } from '../../../hooks/useVoiceInput'
import { playSendSound } from '../../../utils/sounds'
import './ChatInput.css'

interface ChatInputProps {
  /** ID текущего чата — для панели очереди запросов. */
  chatId?: string
  onSend: (text: string) => void
  disabled?: boolean
  isIncognito?: boolean
  replyTo?: { id: string; role: string; content: string }[]
  onCancelReply?: (id: string) => void
  isGenerating?: boolean
  onStop?: () => void
  contextInfo?: ContextInfo | null
  showContextRing?: boolean
  /** Контролируемое значение поля ввода (черновик). Родитель хранит
   *  draft-стейт и персистит его в БД. Раньше value был внутренним
   *  useState и терялся при смене чата / перезапуске. */
  value: string
  onChangeValue: (text: string) => void
  /** История предыдущих запросов чата (DESC — самый свежий первым),
   *  уже дедуплицирована от подряд-дубликатов. Используется для навигации
   *  по стрелкам вверх/вниз когда слеш-меню закрыто. */
  inputHistory?: string[]
  mainModelId?: string
  onMainModelChange?: (modelId: string, providerId: string) => void
  reasoningValue?: string
  onReasoningChange?: (value: string) => void
  planningMode?: boolean
  onPlanningModeChange?: (v: boolean) => void
  imageMode?: boolean
  onImageModeChange?: (v: boolean) => void
  /** Read-only режим: агент отвечает без правок кода/запуска команд.
    *  Комбинируется с imageMode (ask + image — read-only + генерация картинки).
    *  planningMode имеет приоритет (он строже — требует <plan>). */
  askMode?: boolean
  onAskModeChange?: (v: boolean) => void
  /** Single-select persona run mode (classic/architect/debugger/...).
   *  Orthogonal to the three toggles above — a radio choice, not a boolean. */
  persona?: PersonaId
  onPersonaChange?: (v: PersonaId) => void
  rateLimitSec?: number
  /** Рабочая директория текущего чата (режим "Код"). Показывается как
    *  бейдж над инпутом — как cwd-indicator в Codex CLI. */
  workdir?: string
  /** Статистика сжатий сессии для ContextRing (кол-во + сэкономлено токенов). */
  compactSessionStats?: { count: number; totalTokensSaved: number }
  /** Кастомные slash-команды (из .md-файлов). Загружаются в ChatPage и
   *  прокидываются сюда для автокомплита. */
  customCommands?: SlashCommand[]
  /** Прикреплённые вложения черновика (персистятся в БД через ChatPage).
   *  ChatInput — controlled: только отображает и сообщает об изменениях. */
  attachments?: Attachment[]
  /** Колбэк изменения набора вложений (добавление/удаление чипа). ChatPage
   *  персистит в БД (debounce) и очищает после отправки. */
  onAttachmentsChange?: (attachments: Attachment[]) => void
  /** Лимит вложений (default 10). При достижении показываем warning-чип. */
  maxAttachments?: number
  /** Изменения последнего turn'а — для ChangesBadge над инпутом.
   *  null = нет правок / инкогнито / новый запрос сбросил. */
  lastTurnChanges?: LastTurnChanges | null
  /** Бейдж в live-режиме — shimmer/glow анимация, нет undo. */
  badgeLive?: boolean
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Читает File как base64 data URL (для paste/drag&drop картинок). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * Рендерит содержимое mirror-слоя для подсветки @упоминаний и slash-команд.
 *
 * 1. @упоминания — токены вида @имяФайла (соответствующие прикреплённым
 *    Attachment) обрамляются в <span class="mention-highlight">.
 * 2. slash-команды — если строка начинается с /command, имя команды
 *    подсвечивается <span class="slash-command-highlight">, а текст аргументов
 *    после первого пробела — <span class="slash-command-arg">. Внутри аргументов
 *    @упоминания тоже подсвечиваются.
 *
 * Остальной текст рендерится как есть (color: transparent — виден только фон
 * подсветки).
 */
function renderMentions(text: string): JSX.Element {
  const parts: Array<{ text: string; isMention: boolean }> = []
  const re = /(?:^|\s)@[^\s@]+/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const matchStart = m.index + (m[0].startsWith('@') ? 0 : 1)
    if (matchStart > lastIdx) {
      parts.push({ text: text.slice(lastIdx, matchStart), isMention: false })
    }
    parts.push({ text: text.slice(matchStart, matchStart + m[0].length - (m[0].startsWith('@') ? 0 : 1)), isMention: true })
    lastIdx = matchStart + m[0].length - (m[0].startsWith('@') ? 0 : 1)
  }
  if (lastIdx < text.length) {
    parts.push({ text: text.slice(lastIdx), isMention: false })
  }
  if (parts.length === 0) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => (
        p.isMention
          ? <span key={i} className="mention-highlight">{p.text}</span>
          : <span key={i}>{p.text}</span>
      ))}
    </>
  )
}

function renderMirrorContent(text: string): JSX.Element {
  // Slash-команда в начале строки: /command args...
  if (text.startsWith('/')) {
    const m = text.match(/^(\S+)(\s*)([\s\S]*)$/)
    if (m) {
      const cmdPart = m[1]
      const sep = m[2]
      const rest = m[3]
      return (
        <>
          <span className="slash-command-highlight">{cmdPart}</span>
          <span>{sep}</span>
          <span className="slash-command-arg">{renderMentions(rest)}</span>
          {/* Трейлинг-пробел чтобы mirror не схлопывался */}
          {' '}
        </>
      )
    }
  }
  return (
    <>
      {renderMentions(text)}
      {/* Трейлинг-пробел чтобы mirror не схлопывался */}
      {' '}
    </>
  )
}

// memo: ChatPage ре-рендерится ~20×/сек при стриминге и на scroll-range
// изменениях виртуализатора — без memo инпут-бар (1000+ строк JSX,
// mirror-рендер draft'а, ModelSelector) перерисовывался бы каждый раз.
// Пропсы стабилизированы в ChatPage (useCallback-хендлеры).
function ChatInput({
  chatId,
  onSend, disabled, isIncognito,
  replyTo, onCancelReply,
  isGenerating, onStop,
  contextInfo, showContextRing = true,
  value, onChangeValue,
  inputHistory = [],
  mainModelId = '',
  onMainModelChange,
  reasoningValue = '',
  onReasoningChange,
  planningMode = false,
  onPlanningModeChange,
  imageMode = false,
  onImageModeChange,
  askMode = false,
  onAskModeChange,
  persona = DEFAULT_PERSONA,
  onPersonaChange,
  rateLimitSec = 0,
  workdir,
  compactSessionStats,
  customCommands = [],
  attachments = [],
  onAttachmentsChange,
  maxAttachments = 10,
  lastTurnChanges = null,
  badgeLive = false,
}: ChatInputProps) {
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask')
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  // ── Пикер аргументов команды (многоуровневый enum-пикер) ──
  // argPickerCmd — команда, для которой показываем пикер (null = скрыт).
  // argPickerLevel — индекс текущего аргумента в cmd.arguments.
  // argPickerChoices — отфильтрованные по префиксу опции текущего аргумента.
  // argPickerIdx — выбранный индекс (как slashIdx).
  const [argPickerCmd, setArgPickerCmd] = useState<SlashCommand | null>(null)
  const [argPickerLevel, setArgPickerLevel] = useState(0)
  const [argPickerChoices, setArgPickerChoices] = useState<string[]>([])
  const [argPickerIdx, setArgPickerIdx] = useState(0)
  // ── @mention-меню ──
  // mentionItems — текущий список для дропдауна (fuzzy-отфильтрованный).
  // mentionIdx — выбранный индекс (как slashIdx).
  // mentionToken — {start,end,query} текущего @токена у каретки. null = меню скрыто.
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([])
  const [mentionIdx, setMentionIdx] = useState(0)
  const mentionTokenRef = useRef<{ start: number; end: number; query: string } | null>(null)
  const mentionFetchIdRef = useRef(0) // race-condition guard для асинхронных fetchей
  // ── Drag&Drop overlay ──
  const [isDragOver, setIsDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const [sendBurst, setSendBurst] = useState(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const uiSounds = useUIStore(s => s.uiSounds)
  const sendEffect = useUIStore(s => s.sendEffect)

  // ── Голосовой ввод (STT) в инпут-баре ────────────────────────────────
  // Провайдер и размер модели читаются из персистентных настроек (electron-store).
  // 'local' — локальный Whisper (оффлайн), 'groq' — Groq API fallback.
  // 'webspeech' обрабатывается отдельно (live, прямо в textarea) — пока не MVP.
  const sttProvider = useSettingsStore(s => (s.settings['sttProvider'] as 'local' | 'groq') ?? 'local')
  const sttModelSize = useSettingsStore(s => (s.settings['sttModelSize'] as 'tiny' | 'base') ?? 'tiny')
  // language — 'ru' (default) | 'en'. Selects persona name/description variant.
  const lang = useSettingsStore(s => (s.settings['language'] as 'ru' | 'en') ?? 'ru')

  // Value до начала записи — для восстановления при cancel/error.
  const preVoiceValueRef = useRef('')

  const voice = useVoiceInput({
    provider: sttProvider,
    modelSize: sttModelSize,
  })

  // При начале записи — сохраняем текущий value как базу.
  useEffect(() => {
    if (voice.state === 'requesting') {
      preVoiceValueRef.current = value
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.state])

  // При cancel/error — восстанавливаем исходный value.
  useEffect(() => {
    if (voice.state === 'error') {
      onChangeValue(preVoiceValueRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.state])

  // Анимированная «печать» распознанного текста по словам. Таймер хранится в
  // ref чтобы survive re-render'ы; ref на callback для доступа к свежему value.
  const voiceTypingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const voiceWordsQueueRef = useRef<string[]>([])
  const valueRef = useRef(value)
  valueRef.current = value
  const [isVoiceTyping, setIsVoiceTyping] = useState(false)

  // Стоп анимации печати (и финальный flush текста).
  const stopVoiceTyping = useCallback(() => {
    if (voiceTypingRef.current) {
      clearInterval(voiceTypingRef.current)
      voiceTypingRef.current = null
    }
    voiceWordsQueueRef.current = []
    setIsVoiceTyping(false)
  }, [])

  // Запуск анимированной печати: дробим text на слова, печатаем по ~55ms/слово.
  const startVoiceTyping = useCallback((text: string) => {
    stopVoiceTyping()
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) return
    voiceWordsQueueRef.current = words
    setIsVoiceTyping(true)
    // Если в поле уже есть текст — добавляем пробел перед голосовым фрагментом.
    const sep = valueRef.current && !valueRef.current.endsWith(' ') && !valueRef.current.endsWith('\n') ? ' ' : ''
    let acc = valueRef.current + sep
    voiceTypingRef.current = setInterval(() => {
      const w = voiceWordsQueueRef.current.shift()
      if (!w) { stopVoiceTyping(); return }
      acc = (acc && !acc.endsWith(' ') ? acc + ' ' : acc) + w
      onChangeValue(acc)
      // Прокрутка в конец после каждого слова.
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) { el.scrollTop = el.scrollHeight }
      })
    }, 55)
  }, [stopVoiceTyping, onChangeValue])

  // При ошибке/прерывании — останавливаем анимацию.
  useEffect(() => {
    if (voice.state === 'error' || voice.state === 'idle') {
      // если таймер ещё активен и очередь не пуста — продолжаем печатать (idle
      // после успешного stop() — анимация должна докрутиться). Прерываем только
      // при явной ошибке.
      if (voice.state === 'error') stopVoiceTyping()
    }
  }, [voice.state, stopVoiceTyping])

  // Cleanup при unmount.
  useEffect(() => {
    return () => stopVoiceTyping()
  }, [stopVoiceTyping])

  // ── Клик по кнопке mic: toggle запись ──
  // idle/error → start(); recording → stop() → восстановить базу + анимация
  //   печати финального текста по словам.
  const handleMicClick = useCallback(() => {
    if (voice.state === 'idle' || voice.state === 'error') {
      void voice.start()
    } else if (voice.state === 'recording') {
      void voice.stop().then(text => {
        if (!text) return
        // Восстанавливаем базу (pre-voice value) и анимированно печатаем финал.
        const base = preVoiceValueRef.current
        onChangeValue(base)
        valueRef.current = base
        startVoiceTyping(text)
      })
    }
    // transcribing — игнорируем (идёт распознавание, дождитесь)
  }, [voice, startVoiceTyping, onChangeValue])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  // ── История навигации по стрелкам вверх/вниз ──
  // historyIdx === null — пользователь не в режиме навигации (вводит текст
  // вручную). При ArrowUp на пустом поле или в активной навигации idx
  // указывает на текущую показанную запись из inputHistory (DESC — 0 самый
  // свежий). При ручной правке сбрасывается в null.
  const historyIdxRef = useRef<number | null>(null)

  // Закрытие + меню по клику снаружи
  const plusWrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!plusMenuOpen) return
    const close = (e: MouseEvent) => {
      if (plusWrapRef.current?.contains(e.target as Node)) return
      if (menuRef.current?.contains(e.target as Node)) return
      setPlusMenuOpen(false)
    }
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [plusMenuOpen])

  // Корректировка позиции меню после mount: начальная оценка menuH может
  // отличаться от реальной высоты (меню содержит скролл-секцию персонов).
  // После первого paint измеряем menuRef и сдвигаем top, чтобы меню
  // поместилось на экране и не обрезалось.
  useEffect(() => {
    if (!plusMenuOpen || !menuPos || !menuRef.current || !plusBtnRef.current) return
    const menuRect = menuRef.current.getBoundingClientRect()
    const btnRect = plusBtnRef.current.getBoundingClientRect()
    const realH = menuRect.height + 8
    let top = btnRect.top - realH
    if (top < 8) top = btnRect.bottom + 8
    const maxTop = window.innerHeight - menuRect.height - 8
    if (top > maxTop) top = Math.max(8, maxTop)
    setMenuPos({ top, left: menuPos.left, openUp: top < btnRect.top })
  }, [plusMenuOpen, menuPos?.left])

  useEffect(() => {
    window.syntee.agent.getSettings().then((s: { approvalMode: ApprovalMode }) => {
      setApprovalMode(s.approvalMode)
    }).catch(() => {})
  }, [])

  const handleApprovalChange = (mode: ApprovalMode) => {
    setApprovalMode(mode)
    window.syntee.agent.setSettings({ approvalMode: mode }).catch(() => {})
  }

  // Авто-ресайз textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [value])

  // Сброс навигации по истории при смене чата — индекс относится к
  // inputHistory предыдущего чата и не валиден для нового.
  useEffect(() => {
    historyIdxRef.current = null
  }, [chatId])

  // Обновляем слеш-меню и @mention-меню при вводе
  const handleChange = (text: string) => {
    // Любой ручной ввод сбрасывает режим навигации по истории — иначе
    // следующий ArrowUp продолжил бы с устаревшего индекса.
    historyIdxRef.current = null
    onChangeValue(text)
    // Показываем меню только если строка начинается с / и нет пробелов после команды
    const firstWord = text.split(' ')[0]
    if (text.startsWith('/') && !text.includes(' ')) {
      const cmds = filterCommands(firstWord, customCommands)
      setSlashCmds(cmds)
      setSlashIdx(0)
    } else {
      setSlashCmds([])
    }

    // ── Пикер аргументов команды: синхронизация с ручным вводом ──
    // Если argPicker активен — фильтруем choices текущего уровня по
    // последнему вводимому токену-префиксу. Если юзер ушёл из формата
    // /cmd или превысил уровень — закрываем пикер.
    if (argPickerCmd) {
      const cmd = argPickerCmd
      // Slice-подход (а не regex m[2]) — \s* жадно съедает trailing-пробел,
      // из-за чего для `/cmd choice ` rest терял финальный пробел и уровень
      // считался на 1 меньше (picker показывал прошлый уровень, не следующий).
      const head = text.match(/^\/(\S+)/)
      if (!head || head[1].toLowerCase() !== cmd.name.toLowerCase()) {
        closeArgPicker()
      } else {
        const after = text.slice(head[0].length)
        const trimmed = after.trim()
        const endsWithSpace = after.length > 0 && /\s$/.test(after)
        const tokens = trimmed === '' ? [] : trimmed.split(/\s+/)
        const level = endsWithSpace ? tokens.length : tokens.length - 1
        const arg = cmd.arguments?.[level]
        if (!arg?.choices || arg.choices.length === 0 || level >= (cmd.arguments?.length ?? 0)) {
          closeArgPicker()
        } else {
          const prefix = endsWithSpace ? '' : (tokens.length > 0 ? tokens[tokens.length - 1] : '')
          const filtered = prefix
            ? arg.choices.filter(c => c.toLowerCase().startsWith(prefix.toLowerCase()))
            : arg.choices
          if (filtered.length === 0) {
            closeArgPicker()
          } else {
            setArgPickerLevel(level)
            setArgPickerChoices(filtered)
            setArgPickerIdx(0)
          }
        }
      }
    }

    // ── @mention-детект: парсим токен у каретки ──
    const caretPos = textareaRef.current?.selectionStart ?? text.length
    const token = findMentionTokenAtCaret(text, caretPos)
    mentionTokenRef.current = token
    if (token) {
      // Асинхронный fetch с race-guard — если юзер быстро печатает, оставляем только последний
      const fetchId = ++mentionFetchIdRef.current
      window.syntee.mentions.search({ workdir, query: token.query, limit: 30 })
        .then((items: MentionItem[]) => {
          if (fetchId !== mentionFetchIdRef.current) return // устарел
          setMentionItems(items)
          setMentionIdx(0)
        })
        .catch(() => {
          if (fetchId !== mentionFetchIdRef.current) return
          setMentionItems([])
        })
    } else {
      setMentionItems([])
    }
  }

  const selectCommand = (cmd: SlashCommand) => {
    // Заменяем ввод на "/command " и фокусируем
    const next = `/${cmd.name} `
    historyIdxRef.current = null
    onChangeValue(next)
    setSlashCmds([])
    // Если у команды есть первый аргумент с choices — открываем пикер.
    const firstArg = cmd.arguments?.[0]
    if (firstArg?.choices && firstArg.choices.length > 0) {
      setArgPickerCmd(cmd)
      setArgPickerLevel(0)
      setArgPickerChoices(firstArg.choices)
      setArgPickerIdx(0)
    } else {
      setArgPickerCmd(null)
      setArgPickerChoices([])
    }
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  // ── Пикер аргументов: выбор опции ──
  // Заменяем последний вводимый токен-префикс на выбранный choice и
  // добавляем пробел. Если есть следующий аргумент с choices — переоткрываем
  // пикер для него; иначе закрываем.
  const selectArgChoice = (choice: string) => {
    const cmd = argPickerCmd
    if (!cmd) return
    // Парсим структуру /cmdname [args...] через slice (а не regex m[2],
    // который жадно съедает trailing-пробел и ломает определение endsWithSpace
    // для начального состояния `/cmd ` → rest="" → push-ветка не срабатывала).
    const head = value.match(/^\/(\S+)/)
    if (!head || head[1].toLowerCase() !== cmd.name.toLowerCase()) {
      setArgPickerCmd(null); setArgPickerChoices([]); return
    }
    const after = value.slice(head[0].length) // всё после /cmdname
    const trimmed = after.trim()
    const endsWithSpace = after.length > 0 && /\s$/.test(after)
    const tokens = trimmed === '' ? [] : trimmed.split(/\s+/)
    // Если каретка в конце завершённого токена (endsWithSpace) или токенов
    // ещё нет — добавляем новый choice. Иначе заменяем последний (вводимый префикс).
    const newTokens = [...tokens]
    if (endsWithSpace || newTokens.length === 0) {
      newTokens.push(choice)
    } else {
      newTokens[newTokens.length - 1] = choice
    }
    const newText = `/${cmd.name} ` + newTokens.join(' ') + ' '
    historyIdxRef.current = null
    onChangeValue(newText)
    // Переоткрываем для следующего уровня (если есть choices).
    const nextLevel = argPickerLevel + 1
    const nextArg = cmd.arguments?.[nextLevel]
    if (nextArg?.choices && nextArg.choices.length > 0) {
      setArgPickerLevel(nextLevel)
      setArgPickerChoices(nextArg.choices)
      setArgPickerIdx(0)
    } else {
      setArgPickerCmd(null)
      setArgPickerChoices([])
    }
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  // Закрытие пикера аргументов.
  const closeArgPicker = () => {
    setArgPickerCmd(null)
    setArgPickerChoices([])
    setArgPickerLevel(0)
    setArgPickerIdx(0)
  }

  const handleSend = () => {
    const text = value.trim()
    // Разрешаем отправку даже при disabled=true если идёт генерация —
    // запрос уйдёт в очередь (main-процесс сериализует через chatQueues).
    if (!text && attachments.length === 0) return
    if (disabled && !isGenerating) return
    onSend(text)
    historyIdxRef.current = null
    onChangeValue('')
    setSlashCmds([])
    setMentionItems([])
    mentionTokenRef.current = null
    closeArgPicker()
    // Вложения очищаются в ChatPage после отправки (после chat:send)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    if (uiSounds) playSendSound()
    if (sendEffect) { setSendBurst(true); setTimeout(() => setSendBurst(false), 400) }
  }

  // ── @mention: выбор элемента из дропдауна ──
  // Заменяем @токен в тексте на @label (без пробела — юзер может продолжить
  // печатать). Добавляем Attachment в чипы. Каретку ставим после вставки.
  const selectMention = (item: MentionItem) => {
    const token = mentionTokenRef.current
    if (!token) return
    const label = item.label
    const before = value.slice(0, token.start)
    const after = value.slice(token.end)
    const newText = before + '@' + label + ' ' + after
    mentionTokenRef.current = null
    setMentionItems([])
    onChangeValue(newText)
    // Добавляем Attachment (если не превышен лимит и ещё нет дубликата)
    const newAtt = mentionToAttachment(item)
    if (attachments.length < maxAttachments && !attachments.some(a => a.path === newAtt.path && a.kind === newAtt.kind)) {
      onAttachmentsChange?.([...attachments, newAtt])
    }
    // Фокус + каретка после вставки
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const pos = before.length + label.length + 2 // +@ +пробел
      el.setSelectionRange(pos, pos)
    })
  }

  // ── Удаление вложения ──
  // Если это картинка из paste/dragdrop (source !== 'mention') — удаляем файл из userData.
  const handleRemoveAttachment = (id: string) => {
    const removed = attachments.find(a => a.id === id)
    if (removed && removed.path && removed.source !== 'mention' && removed.kind === 'image') {
      window.syntee.attachments.deleteFile({ path: removed.path }).catch(() => {})
    }
    onAttachmentsChange?.(attachments.filter(a => a.id !== id))
  }

  // ── Drag&Drop файлов ──
  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!e.dataTransfer.types.includes('Files')) return
    dragCounterRef.current++
    setIsDragOver(true)
  }
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragOver(false)
    }
  }
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const handleDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    await addFilesAsAttachments(files)
  }

  // ── Универсальный обработчик добавления File[] → Attachment[] ──
  // Используется в drag&drop и в paste. Картинки сохраняем в userData
  // (saveImageFromBase64), остальные файлы — копируем (saveFileFromPath).
  // Файлы из workdir НЕ копируем — храним только path (но drag&drop не даёт
  // надёжного способа узнать, из workdir файл или нет, поэтому всегда копируем
  // через saveFileFromPath для надёжности).
  const addFilesAsAttachments = async (files: File[]) => {
    if (!chatId) return
    const remaining = maxAttachments - attachments.length
    if (remaining <= 0) return
    const toAdd: Attachment[] = []
    for (const file of files.slice(0, remaining)) {
      try {
        if (file.type.startsWith('image/')) {
          // Картинка — читаем как base64, сохраняем в userData
          const base64 = await fileToBase64(file)
          const res = await window.syntee.attachments.saveImageFromBase64({
            chatId,
            base64,
            mime: file.type,
            suggestedName: file.name.replace(/\.[^.]+$/, '') || `image-${Date.now()}`,
          })
          if (res.success) {
            toAdd.push({
              id: crypto.randomUUID(),
              kind: 'image',
              name: res.name,
              path: res.path,
              mime: res.mime,
              size: res.size,
              source: 'dragdrop',
              dataUrl: base64,
              attachedAt: Date.now(),
            })
          }
        } else {
          // Не-картинка — нужен путь. File.path удалён в Electron 32+
          // (contextIsolation), используем webUtils.getPathForFile через preload.
          const filePath = window.syntee.attachments.getPathForFile(file)
          if (!filePath) continue
          const res = await window.syntee.attachments.saveFileFromPath({ chatId, sourcePath: filePath })
          if (res.success) {
            toAdd.push({
              id: crypto.randomUUID(),
              kind: 'file',
              name: res.name,
              path: res.path,
              mime: res.mime,
              size: res.size,
              source: 'dragdrop',
              attachedAt: Date.now(),
            })
          }
        }
      } catch { /* skip individual file errors */ }
    }
    if (toAdd.length > 0) {
      onAttachmentsChange?.([...attachments, ...toAdd])
    }
  }

  // ── Paste изображения из буфера обмена (Ctrl+V) ──
  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems: DataTransferItem[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) imageItems.push(items[i])
    }
    if (imageItems.length === 0) return // обычный текст — пусть textarea обрабатывает
    e.preventDefault()
    const files: File[] = []
    for (const item of imageItems) {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
    if (files.length > 0) void addFilesAsAttachments(files)
  }

  // ── Кнопка «Прикрепить файл» (native dialog) ──
  const handleAttachClick = async () => {
    const filePaths = await window.syntee.attachments.pickFile()
    if (!filePaths || filePaths.length === 0) return
    const remaining = maxAttachments - attachments.length
    if (remaining <= 0) return
    const toAdd: Attachment[] = []
    for (const fp of filePaths.slice(0, remaining)) {
      const name = fp.split(/[\\/]/).pop() || fp
      const mime = mimeFromExt(name)
      const isImg = isImageMime(mime)
      // Для диалога — копируем файл в userData (как в drag&drop), чтобы
      // пережил рестарт даже если исходный файл удалят.
      const res = await window.syntee.attachments.saveFileFromPath({ chatId: chatId!, sourcePath: fp })
      if (res.success) {
        toAdd.push({
          id: crypto.randomUUID(),
          kind: isImg ? 'image' : 'file',
          name: res.name,
          path: res.path,
          mime: res.mime,
          size: res.size,
          source: 'dialog',
          attachedAt: Date.now(),
        })
      }
    }
    if (toAdd.length > 0) onAttachmentsChange?.([...attachments, ...toAdd])
  }

  // Подставить запись из истории в поле и поставить каретку в конец.
  const applyHistoryEntry = (entry: string) => {
    onChangeValue(entry)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const len = entry.length
      el.setSelectionRange(len, len)
    })
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Навигация по пикеру аргументов команды — высший приоритет
    // (открыт после выбора команды, пока юзер выбирает enum-опцию).
    if (argPickerCmd && argPickerChoices.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setArgPickerIdx(i => (i - 1 + argPickerChoices.length) % argPickerChoices.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setArgPickerIdx(i => (i + 1) % argPickerChoices.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectArgChoice(argPickerChoices[argPickerIdx])
        return
      }
      if (e.key === 'Escape') {
        closeArgPicker()
        return
      }
    }
    // Навигация по @mention-меню — высший приоритет (как slash)
    if (mentionItems.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx(i => (i - 1 + mentionItems.length) % mentionItems.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx(i => (i + 1) % mentionItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectMention(mentionItems[mentionIdx])
        return
      }
      if (e.key === 'Escape') {
        setMentionItems([])
        mentionTokenRef.current = null
        return
      }
    }
    // Навигация по слеш-меню — приоритет
    if (slashCmds.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx(i => (i - 1 + slashCmds.length) % slashCmds.length)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx(i => (i + 1) % slashCmds.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        selectCommand(slashCmds[slashIdx])
        return
      }
      if (e.key === 'Escape') {
        setSlashCmds([])
        return
      }
    }
    // ── История навигации по стрелкам вверх/вниз ──
    // Активна только когда слеш-меню закрыто и в чате есть user-сообщения.
    // Старт навигации — ArrowUp на пустом поле. Дальше Up/Down перемещаются
    // по inputHistory (DESC — 0 самый свежий). Down ниже 0 → очищает поле
    // и выходит из навигации. Многострочный ввод не ломается: пока поле не
    // пусто, ArrowUp двигает каретку (навигация не стартует).
    if (slashCmds.length === 0 && inputHistory.length > 0) {
      const inNav = historyIdxRef.current !== null
      if (e.key === 'ArrowUp') {
        if (inNav) {
          e.preventDefault()
          const cur = historyIdxRef.current as number
          const nextIdx = Math.min(cur + 1, inputHistory.length - 1)
          historyIdxRef.current = nextIdx
          applyHistoryEntry(inputHistory[nextIdx])
          return
        }
        // Старт навигации только с пустого поля — иначе ArrowUp двигает
        // каретку вверх в многострочном вводе.
        if (value === '') {
          e.preventDefault()
          historyIdxRef.current = 0
          applyHistoryEntry(inputHistory[0])
          return
        }
      }
      if (e.key === 'ArrowDown' && inNav) {
        e.preventDefault()
        const cur = historyIdxRef.current as number
        const nextIdx = cur - 1
        if (nextIdx < 0) {
          historyIdxRef.current = null
          onChangeValue('')
        } else {
          historyIdxRef.current = nextIdx
          applyHistoryEntry(inputHistory[nextIdx])
        }
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Логика кнопки: текст в поле → Send (даже при генерации — уйдёт в очередь).
  // Пустое поле + генерация → Stop. Пустое поле + idle → Mic.
  // Во время записи/распознавания голоса — показываем recording-состояние
  // кнопки (независимо от наличия текста) — юзер жмёт снова чтобы остановить.
  const voiceActive = voice.state === 'recording' || voice.state === 'transcribing' || voice.state === 'requesting'
  // Пока модель качается в фоне (преварм при старте) — на кнопке mic крутится
  // спиннер, но запись можно начать (инференс подождёт готовности модели).
  const micBusy = voice.modelLoading && !voiceActive && !value.trim() && !isGenerating
  const btnMode = voiceActive
    ? 'voice'
    : value.trim() ? 'send' : isGenerating ? 'stop' : 'mic'
  // Send во время генерации — подсветим кольцом, поменяем tooltip.
  const sendToQueue = btnMode === 'send' && !!isGenerating

  // Breadcrumb пути рабочей директории: показываем последние 2 сегмента
  // с разделителем, если путь длиннее — добавляем многоточие спереди.
  // Например "C:\Projects\MyApp" → "Projects / MyApp",
  // "/home/user/projects/myapp" → "projects / myapp".
  const workdirBreadcrumb = workdir
    ? (() => {
        const segs = workdir.split(/[\\/]/).filter(Boolean)
        if (segs.length <= 2) return segs.join(' / ')
        return '… / ' + segs.slice(-2).join(' / ')
      })()
    : ''

  return (
    // Контейнер .chat-input-wrap абсолютно позиционирован (bottom:0).
    // .chat-input-main — бейджи + инпут. Todo-план вынесен наверх чата
    // в отдельный компонент LiveTodoBar (в ChatPage).
    <div
      className={`chat-input-wrap ${isIncognito ? 'chat-input-wrap--incognito' : ''}`}>

      {/* ОСНОВНОЙ БЛОК — бейджи + инпут. */}
      <div className="chat-input-main">
        {/* Слеш-меню */}
        <SlashMenu
          commands={slashCmds}
          selectedIndex={slashIdx}
          anchorRef={boxRef as React.RefObject<HTMLElement>}
          onSelect={selectCommand}
          onClose={() => setSlashCmds([])}
        />

        {/* @mention-меню */}
        <MentionMenu
          items={mentionItems}
          selectedIndex={mentionIdx}
          anchorRef={boxRef as React.RefObject<HTMLElement>}
          onSelect={selectMention}
          onClose={() => { setMentionItems([]); mentionTokenRef.current = null }}
        />

        {/* Пикер аргументов команды (многоуровневый enum-пикер) */}
        <CommandArgMenu
          cmd={argPickerCmd}
          level={argPickerLevel}
          choices={argPickerChoices}
          selectedIndex={argPickerIdx}
          anchorRef={boxRef as React.RefObject<HTMLElement>}
          onSelect={selectArgChoice}
          onClose={closeArgPicker}
        />

      {/* Строка статуса над инпутом: workdir-бейдж + planning/image-бейджи.
          Workdir показываем как cwd-indicator (как в Codex CLI) — иконка
          папки + basename, полный путь в title при наведении. */}
      <div className="chat-input-status-row">
        <AnimatePresence>
          {workdir && (
            <motion.div
              className="chat-input-workdir-badge"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              title={workdir}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
              <span>{workdirBreadcrumb}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Бейдж голосового ввода — показывается во время записи/распознавания
            и во время анимированной печати распознанного текста. Пульсирует.
            Также показывается при фоновой загрузке модели (micBusy). */}
        <AnimatePresence>
          {(voice.state === 'recording' || voice.state === 'transcribing' || voice.state === 'requesting' || voice.state === 'error' || isVoiceTyping || micBusy) && (
            <motion.div
              className={`chat-input-voice-badge${voice.state === 'error' ? ' chat-input-voice-badge--error' : ''}`}
              initial={{ opacity: 0, y: 6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              title={voice.error ? voice.error : undefined}
            >
              {voice.state === 'error' ? (
                <>
                  <AppIcon name="alertCircle" size="xs" />
                  <span>{voice.error || 'Ошибка голосового ввода'}</span>
                </>
              ) : voice.state === 'recording' ? (
                <>
                  <span className="chat-input-voice-badge-dot" />
                  <span>Запись {voice.recordingSec}с</span>
                </>
              ) : isVoiceTyping ? (
                <>
                  <AppIcon name="mic" size="xs" />
                  <span>Голосовой ввод...</span>
                </>
              ) : micBusy ? (
                <>
                  <AppIcon name="loader" size="xs" animation="spin" />
                  <span>{voice.progress?.message || 'Загрузка модели...'}{typeof voice.progress?.progress === 'number' && voice.progress.progress > 0 && voice.progress.progress < 100 ? ` ${voice.progress.progress}%` : ''}</span>
                </>
              ) : voice.progress?.message ? (
                <>
                  <AppIcon name="loader" size="xs" animation="spin" />
                  <span>{voice.progress.message}</span>
                </>
              ) : voice.state === 'transcribing' || voice.state === 'requesting' ? (
                <>
                  <AppIcon name="loader" size="xs" animation="spin" />
                  <span>{voice.state === 'requesting' ? 'Микрофон...' : 'Распознавание...'}</span>
                </>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Бейдж очереди запросов — раскрывается в панель управления при
            hover/клике. Показывается только когда есть active/queued запросы. */}
        {chatId && <QueuePanel chatId={chatId} />}

        {/* Бейдж активных расширений (MCP + Skills) — drill-down popup.
            Скрыт когда ничего не включено или инкогнито. */}
        {chatId && <ExtensionsBadge chatId={chatId} isIncognito={isIncognito} />}

        {/* Бейдж изменений последнего запроса — +N -M строк, popup с undo. */}
        <AnimatePresence>
          {chatId && lastTurnChanges && (
            <ChangesBadge chatId={chatId} changes={lastTurnChanges} live={badgeLive} />
          )}
        </AnimatePresence>

        {/* Бейдж режима планирования — над инпут полем */}
        <AnimatePresence>
          {planningMode && (
            <motion.div
              className="chat-input-planning-badge"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              onClick={() => onPlanningModeChange?.(false)}
              title="Выключить режим планирования"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/>
                <line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              <span>Режим плана</span>
              <span className="chat-input-planning-badge-close">✕</span>
            </motion.div>
          )}
          {imageMode && (
            <motion.div
              className="chat-input-planning-badge"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              onClick={() => onImageModeChange?.(false)}
              title="Выключить режим генерации изображений"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span>Генерация изображений</span>
              <span className="chat-input-planning-badge-close">✕</span>
            </motion.div>
          )}
          {askMode && !planningMode && (
            <motion.div
              className="chat-input-planning-badge chat-input-planning-badge--ask"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              onClick={() => onAskModeChange?.(false)}
              title="Выключить ask-режим (только чтение)"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span>Ask — только чтение</span>
              <span className="chat-input-planning-badge-close">✕</span>
            </motion.div>
          )}
          {persona !== 'classic' && (() => {
            const p = getPersona(persona)
            return (
              <motion.div
                key={`persona-${persona}`}
                className="chat-input-persona-badge"
                style={{ '--persona-color': p.color } as React.CSSProperties}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 6 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                onClick={() => onPersonaChange?.(DEFAULT_PERSONA)}
                title={lang === 'en' ? `Reset to Classic` : `Сбросить до Classic`}
              >
                {p.iconSvg && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: p.iconSvg }} />
                )}
                <span>{lang === 'en' ? p.nameEn : p.nameRu}</span>
                <span className="chat-input-planning-badge-close">✕</span>
              </motion.div>
            )
          })()}
        </AnimatePresence>

        {/* Селектор модели — справа в status-row. Минималистичный бейдж
            с цветной точкой провайдера + именем модели; клик открывает
            dropdown с поиском. Меняет main-назначение глобально. */}
        {!isIncognito && mainModelId && onMainModelChange && (
          <ModelSelector modelId={mainModelId} onChange={onMainModelChange} />
        )}
      </div>

      {replyTo && replyTo.length > 0 && (
        <div className="chat-input-replies">
          {replyTo.map(r => (
            <div key={r.id} className="chat-input-reply">
              <div className="chat-input-reply-content">
                <span className="chat-input-reply-role">{r.role === 'user' ? 'Вы' : 'Syntee'}</span>
                <span className="chat-input-reply-text">{r.content.slice(0, 100)}{r.content.length > 100 ? '…' : ''}</span>
              </div>
              <button className="chat-input-reply-cancel" onClick={() => onCancelReply?.(r.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
      {rateLimitSec > 0 && (
        <div className="chat-input-rate-limit">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
            <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
          </svg>
          <span>Rate limit — жду {rateLimitSec}с</span>
        </div>
      )}

      {/* Чипы прикреплённых вложений — над инпут-боксом. Показываем только
          когда есть вложения, иначе место не занимаем. */}
      {attachments.length > 0 && (
        <AttachmentChips
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          max={maxAttachments}
          maxReached={attachments.length >= maxAttachments}
        />
      )}

      <div
        className="chat-input-box"
        ref={boxRef}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Drag&Drop overlay — подсветка всего инпута + текст «Отпустите для прикрепления» */}
        <AnimatePresence>
          {isDragOver && (
            <motion.div
              className="chat-input-drop-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>Отпустите для прикрепления</span>
            </motion.div>
          )}
        </AnimatePresence>
        {/* + кнопка с меню */}
        <div className="chat-input-plus-wrap" ref={plusWrapRef}>
          <button
            ref={plusBtnRef}
            className={`chat-input-plus-btn${plusMenuOpen ? ' chat-input-plus-btn--open' : ''}`}
            onClick={() => {
              if (!plusBtnRef.current) return
              const r = plusBtnRef.current.getBoundingClientRect()
              // Начальная оценка высоты: attach + divider + 3 toggle + divider
              // + persona-section (7 компактных пунктов + заголовок). Реальная
              // высота измеряется после mount через useEffect-корректировку выше.
              const menuH = 380
              setMenuPos({
                top: r.top - menuH - 8,
                left: r.left,
                openUp: true,
              })
              setPlusMenuOpen(v => !v)
            }}
            title="Прикрепить / Режим"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>

          {createPortal(
            <AnimatePresence>
              {plusMenuOpen && menuPos && (
                <motion.div
                  ref={menuRef}
                  className="chat-input-plus-menu"
                  style={{ position: 'fixed', left: menuPos.left, top: menuPos.top, zIndex: 9999 }}
                  initial={{ opacity: 0, scale: 0.88, y: 10, transformOrigin: 'bottom left' }}
                  animate={{ opacity: 1, scale: 1, y: 0, transformOrigin: 'bottom left' }}
                  exit={{ opacity: 0, scale: 0.88, y: 10, transformOrigin: 'bottom left' }}
                  transition={{ type: 'spring', stiffness: 480, damping: 28 }}
                  onMouseDown={e => e.stopPropagation()}
                >
                  <button className="chat-input-plus-item" onClick={() => { handleAttachClick(); setPlusMenuOpen(false) }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                    </svg>
                    Прикрепить файл
                  </button>
                  <div className="chat-input-plus-divider" />
                  <div className="chat-input-plus-item chat-input-plus-item--toggle" onClick={() => { onPlanningModeChange?.(!planningMode) }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                    </svg>
                    Планирование
                    <motion.button
                      className={`plus-menu-toggle${planningMode ? ' plus-menu-toggle--on' : ''}`}
                      onClick={e => { e.stopPropagation(); onPlanningModeChange?.(!planningMode) }}
                      whileTap={{ scale: 0.93 }}
                    >
                      <motion.span
                        className="plus-menu-toggle-thumb"
                        animate={{ x: planningMode ? 16 : 2 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      />
                    </motion.button>
                  </div>
                  <div className="chat-input-plus-item chat-input-plus-item--toggle" onClick={() => { onImageModeChange?.(!imageMode) }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2"/>
                      <circle cx="8.5" cy="8.5" r="1.5"/>
                      <polyline points="21 15 16 10 5 21"/>
                    </svg>
                    Генерация изображений
                    <motion.button
                      className={`plus-menu-toggle${imageMode ? ' plus-menu-toggle--on' : ''}`}
                      onClick={e => { e.stopPropagation(); onImageModeChange?.(!imageMode) }}
                      whileTap={{ scale: 0.93 }}
                    >
                      <motion.span
                        className="plus-menu-toggle-thumb"
                        animate={{ x: imageMode ? 16 : 2 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      />
                    </motion.button>
                  </div>
                  <div className="chat-input-plus-item chat-input-plus-item--toggle" onClick={() => { onAskModeChange?.(!askMode) }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    Ask — только чтение
                    <motion.button
                      className={`plus-menu-toggle${askMode ? ' plus-menu-toggle--on' : ''}`}
                      onClick={e => { e.stopPropagation(); onAskModeChange?.(!askMode) }}
                      whileTap={{ scale: 0.93 }}
                    >
                      <motion.span
                        className="plus-menu-toggle-thumb"
                        animate={{ x: askMode ? 16 : 2 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      />
                    </motion.button>
                  </div>

                  <div className="chat-input-plus-divider" />
                  <div className="chat-input-plus-section-label">
                    {lang === 'en' ? 'Mode' : 'Режим'}
                  </div>
                  <div className="chat-input-plus-personas">
                    {PERSONAS.map(p => {
                      const selected = p.id === persona
                      return (
                        <div
                          key={p.id}
                          className={`chat-input-persona-item${selected ? ' chat-input-persona-item--selected' : ''}${p.id === 'classic' ? ' chat-input-persona-item--classic' : ''}`}
                          style={p.color ? ({ '--persona-color': p.color } as React.CSSProperties) : undefined}
                          onClick={() => { onPersonaChange?.(p.id); setPlusMenuOpen(false) }}
                        >
                          <span className="chat-input-persona-icon">
                            {p.iconSvg
                              ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: p.iconSvg }} />
                              : <span className="chat-input-persona-dot" />}
                          </span>
                          <span className="chat-input-persona-text">
                            <span className="chat-input-persona-name">{lang === 'en' ? p.nameEn : p.nameRu}</span>
                            <span className="chat-input-persona-desc">{lang === 'en' ? p.descEn : p.descRu}</span>
                          </span>
                          {selected && (
                            <motion.span
                              className="chat-input-persona-check"
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                            </motion.span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>,
            document.body
          )}
        </div>

        <div className="chat-input-textarea-wrap">
          {/* Mirror-слой для подсветки @упоминаний. Точно совпадает по
              шрифту/отступам с textarea, рендерит value с подсветкой @токенов.
              pointer-events:none — клики идут в textarea. */}
          <div className="chat-input-mirror" aria-hidden="true">
            {renderMirrorContent(value)}
          </div>
          <textarea
            ref={textareaRef}
            className={`chat-input-textarea selectable${planningMode ? ' chat-input-textarea--planning' : ''}${askMode && !planningMode ? ' chat-input-textarea--ask' : ''}`}
            value={value}
            onChange={e => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={(e) => {
              const wrap = e.currentTarget.parentElement
              const mirror = wrap?.querySelector('.chat-input-mirror') as HTMLDivElement
              if (mirror) mirror.scrollTop = e.currentTarget.scrollTop
            }}
            placeholder={
              planningMode ? 'Режим планирования — опишите задачу...'
              : askMode ? 'Ask-режим — только чтение, задайте вопрос...'
              : imageMode ? 'Режим генерации изображений — опишите картинку...'
              : isIncognito ? 'Режим инкогнито — чат не сохраняется...'
              : 'Сообщение Syntee... (/ для команд, @ для файлов)'
            }
            rows={1}
            disabled={disabled && !isGenerating}
          />
        </div>

        {!isIncognito && (
          <ApprovalModeSelector value={approvalMode} onChange={handleApprovalChange} compact />
        )}

        {!isIncognito && mainModelId && onReasoningChange && (
          <ReasoningSelector modelId={mainModelId} value={reasoningValue} onChange={onReasoningChange} />
        )}

        {showContextRing && !isIncognito && (
          <ContextRing info={contextInfo ?? null} compactSessionStats={compactSessionStats} />
        )}

        <motion.button
          className={`chat-input-action-btn chat-input-action-btn--${btnMode}${sendBurst ? ' chat-input-action-btn--burst' : ''}${sendToQueue ? ' chat-input-action-btn--queue' : ''}${voice.state === 'recording' ? ' chat-input-action-btn--recording' : ''}${voice.state === 'transcribing' || voice.state === 'requesting' ? ' chat-input-action-btn--busy' : ''}${micBusy ? ' chat-input-action-btn--busy' : ''}`}
          onClick={btnMode === 'stop' ? onStop : btnMode === 'send' ? handleSend : btnMode === 'voice' ? handleMicClick : handleMicClick}
          whileTap={{ scale: 0.88 }}
          whileHover={{ scale: 1.08 }}
          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          title={btnMode === 'stop' ? 'Остановить генерацию' : btnMode === 'send' ? (sendToQueue ? 'Отправить в очередь (Enter)' : 'Отправить (Enter)') : voice.state === 'recording' ? `Запись... ${voice.recordingSec}с — нажмите чтобы остановить` : voice.state === 'transcribing' ? 'Распознавание речи...' : micBusy ? (voice.progress?.message || 'Загрузка модели Whisper...') : 'Голосовой ввод'}
        >
          <AnimatePresence mode="wait" initial={false}>
            {btnMode === 'stop' ? (
              <motion.span key="stop" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} className="chat-input-stop-icon" />
            ) : btnMode === 'send' ? (
              <motion.span key="send" initial={{ rotate: -90, opacity: 0, scale: 0.5 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 90, opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                <AppIcon name="send" size="md" />
              </motion.span>
            ) : btnMode === 'voice' ? (
              voice.state === 'transcribing' || voice.state === 'requesting' ? (
                <motion.span key="voice-busy" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                  <AppIcon name="loader" size="md" animation="spin" />
                </motion.span>
              ) : (
                <motion.span key="voice-rec" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                  <AppIcon name="mic" size="md" />
                </motion.span>
              )
            ) : micBusy ? (
              <motion.span key="mic-loading" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                <AppIcon name="loader" size="md" animation="spin" />
              </motion.span>
            ) : (
              <motion.span key="mic" initial={{ rotate: 90, opacity: 0, scale: 0.5 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: -90, opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                <AppIcon name="mic" size="md" />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>

      <p className="chat-input-hint">Enter — отправить · Shift+Enter — новая строка · / — команды · @ — файлы и сущности</p>
      </div>
    </div>
  )
}

export default memo(ChatInput)
