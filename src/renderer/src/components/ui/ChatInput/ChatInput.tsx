import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import ApprovalModeSelector from '../ApprovalModeSelector/ApprovalModeSelector'
import ContextRing from '../ContextRing/ContextRing'
import ReasoningSelector from '../ReasoningSelector/ReasoningSelector'
import ModelSelector from '../ModelSelector/ModelSelector'
import SlashMenu from '../SlashMenu/SlashMenu'
import QueuePanel from '../QueuePanel/QueuePanel'
import { filterCommands } from '../../../../../shared/slashCommands'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import type { ApprovalMode } from '../../../../../shared/types'
import type { ContextInfo } from '../../../hooks/useContextCounter'
import { useUIStore } from '../../../store/ui.store'
import { playSendSound } from '../../../utils/sounds'
import './ChatInput.css'

interface ChatInputProps {
  /** ID текущего чата — для панели очереди запросов. */
  chatId?: string
  onSend: (text: string) => void
  onAttach?: () => void
  disabled?: boolean
  isIncognito?: boolean
  replyTo?: { id: string; role: string; content: string }[]
  onCancelReply?: (id: string) => void
  isGenerating?: boolean
  onStop?: () => void
  contextInfo?: ContextInfo | null
  showContextRing?: boolean
  onInputChange?: (text: string) => void
  mainModelId?: string
  onMainModelChange?: (modelId: string, providerId: string) => void
  reasoningValue?: string
  onReasoningChange?: (value: string) => void
  planningMode?: boolean
  onPlanningModeChange?: (v: boolean) => void
  imageMode?: boolean
  onImageModeChange?: (v: boolean) => void
  rateLimitSec?: number
  /** Рабочая директория текущего чата (режим "Код"). Показывается как
    *  бейдж над инпутом — как cwd-indicator в Codex CLI. */
  workdir?: string
}

export default function ChatInput({
  chatId,
  onSend, onAttach, disabled, isIncognito,
  replyTo, onCancelReply,
  isGenerating, onStop,
  contextInfo, showContextRing = true,
  onInputChange,
  mainModelId = '',
  onMainModelChange,
  reasoningValue = '',
  onReasoningChange,
  planningMode = false,
  onPlanningModeChange,
  imageMode = false,
  onImageModeChange,
  rateLimitSec = 0,
  workdir,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask')
  const [slashCmds, setSlashCmds] = useState<SlashCommand[]>([])
  const [slashIdx, setSlashIdx] = useState(0)
  const [sendBurst, setSendBurst] = useState(false)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false)
  const plusBtnRef = useRef<HTMLButtonElement>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const { uiSounds, sendEffect } = useUIStore()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

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

  // Обновляем слеш-меню при вводе
  const handleChange = (text: string) => {
    setValue(text)
    onInputChange?.(text)
    // Показываем меню только если строка начинается с / и нет пробелов после команды
    const firstWord = text.split(' ')[0]
    if (text.startsWith('/') && !text.includes(' ')) {
      const cmds = filterCommands(firstWord)
      setSlashCmds(cmds)
      setSlashIdx(0)
    } else {
      setSlashCmds([])
    }
  }

  const selectCommand = (cmd: SlashCommand) => {
    // Заменяем ввод на "/command " и фокусируем
    const next = `/${cmd.name} `
    setValue(next)
    onInputChange?.(next)
    setSlashCmds([])
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  const handleSend = () => {
    const text = value.trim()
    // Разрешаем отправку даже при disabled=true если идёт генерация —
    // запрос уйдёт в очередь (main-процесс сериализует через chatQueues).
    if (!text || (disabled && !isGenerating)) return
    onSend(text)
    setValue('')
    onInputChange?.('')
    setSlashCmds([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    if (uiSounds) playSendSound()
    if (sendEffect) { setSendBurst(true); setTimeout(() => setSendBurst(false), 400) }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Навигация по слеш-меню
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Логика кнопки: текст в поле → Send (даже при генерации — уйдёт в очередь).
  // Пустое поле + генерация → Stop. Пустое поле + idle → Mic.
  // Раньше Stop замещал Send при isGenerating, что блокировало постановку
  // запросов в очередь во время выполнения.
  const btnMode = value.trim() ? 'send' : isGenerating ? 'stop' : 'mic'
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

        {/* Бейдж очереди запросов — раскрывается в панель управления при
            hover/клике. Показывается только когда есть active/queued запросы. */}
        {chatId && <QueuePanel chatId={chatId} />}

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

      <div className="chat-input-box" ref={boxRef}>
        {/* + кнопка с меню */}
        <div className="chat-input-plus-wrap" ref={plusWrapRef}>
          <button
            ref={plusBtnRef}
            className={`chat-input-plus-btn${plusMenuOpen ? ' chat-input-plus-btn--open' : ''}`}
            onClick={() => {
              if (!plusBtnRef.current) return
              const r = plusBtnRef.current.getBoundingClientRect()
              const menuH = 90 // примерная высота меню
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
                  <button className="chat-input-plus-item" onClick={() => { onAttach?.(); setPlusMenuOpen(false) }}>
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
                </motion.div>
              )}
            </AnimatePresence>,
            document.body
          )}
        </div>

        <textarea
          ref={textareaRef}
          className={`chat-input-textarea selectable${planningMode ? ' chat-input-textarea--planning' : ''}`}
          value={value}
          onChange={e => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={planningMode ? 'Режим планирования — опишите задачу...' : imageMode ? 'Режим генерации изображений — опишите картинку...' : isIncognito ? 'Режим инкогнито — чат не сохраняется...' : 'Сообщение Syntee... (/ для команд)'}
          rows={1}
          disabled={disabled && !isGenerating}
        />

        {!isIncognito && (
          <ApprovalModeSelector value={approvalMode} onChange={handleApprovalChange} compact />
        )}

        {!isIncognito && mainModelId && onReasoningChange && (
          <ReasoningSelector modelId={mainModelId} value={reasoningValue} onChange={onReasoningChange} />
        )}

        {showContextRing && !isIncognito && (
          <ContextRing info={contextInfo ?? null} />
        )}

        <motion.button
          className={`chat-input-action-btn chat-input-action-btn--${btnMode}${sendBurst ? ' chat-input-action-btn--burst' : ''}${sendToQueue ? ' chat-input-action-btn--queue' : ''}`}
          onClick={btnMode === 'stop' ? onStop : btnMode === 'send' ? handleSend : undefined}
          whileTap={{ scale: 0.88 }}
          whileHover={{ scale: 1.08 }}
          transition={{ type: 'spring', stiffness: 400, damping: 25 }}
          title={btnMode === 'stop' ? 'Остановить генерацию' : btnMode === 'send' ? (sendToQueue ? 'Отправить в очередь (Enter)' : 'Отправить (Enter)') : 'Голосовой ввод'}
        >
          <AnimatePresence mode="wait" initial={false}>
            {btnMode === 'stop' ? (
              <motion.span key="stop" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} className="chat-input-stop-icon" />
            ) : btnMode === 'send' ? (
              <motion.span key="send" initial={{ rotate: -90, opacity: 0, scale: 0.5 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 90, opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                <AppIcon name="send" size="md" />
              </motion.span>
            ) : (
              <motion.span key="mic" initial={{ rotate: 90, opacity: 0, scale: 0.5 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: -90, opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
                <AppIcon name="mic" size="md" />
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>

      <p className="chat-input-hint">Enter — отправить · Shift+Enter — новая строка · / — команды</p>
      </div>
    </div>
  )
}
