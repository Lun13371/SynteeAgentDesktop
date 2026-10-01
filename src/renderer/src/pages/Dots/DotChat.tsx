// ── DotChat: чат Dot'а — наследует рендер (MessageBubble) и инпут-бар ────
// (ChatInput). Живой стриминг работает бесплатно: глобальная подписка
// useChatRunSubscription (App.tsx) пишет liveByChat[chatId] для ВСЕХ чатов,
// MessageBubble читает live-текст по message.chatId.
//
// ВАЖНО (баг-фикс): ChatInput рендерит корень .chat-input-wrap с
// position:absolute; bottom:0 — враппер .dot-chat-input-wrap ОБЯЗАН иметь
// position:relative, иначе инпут вырывается из слота и перекрывает ленту
// сообщений (клики по зоне инпута уходили в скролл-контейнер).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuid } from 'uuid'
import MessageBubble from '../../components/ui/MessageBubble/MessageBubble'
import ChatInput from '../../components/ui/ChatInput/ChatInput'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import { useChatStore } from '../../store/chat.store'
import { useDotsStore } from '../../store/dots.store'
import { initChatSend } from '../../hooks/useChatRunSubscription'
import { useContextCounter } from '../../hooks/useContextCounter'
import { IPC_EVENTS } from '../../../../shared/constants'
import type { Dot, DotRun, Message } from '../../../../shared/types'
import { DotBlob } from './DotBlob'

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameDay ? hm : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hm}`
}

export function DotChat({
  dot,
  runs,
  onWake,
}: {
  dot: Dot
  runs: DotRun[]
  onWake: () => void
}) {
  const chatId = dot.chatId
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [showRuns, setShowRuns] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  // Корень .dot-chat (для --dot-input-h) и слот инпута (для ResizeObserver).
  const rootRef = useRef<HTMLDivElement>(null)
  const inputHostRef = useRef<HTMLDivElement>(null)

  // Эффективная модель Dot'а: персональная → глобальная Dots → основная.
  const dotsSettings = useDotsStore(s => s.settings)
  const modelId = dot.modelId ?? dotsSettings?.modelId ?? ''
  const modelTitle = dot.modelId
    ? `Персональная модель Dot’а: ${dot.modelId}`
    : dotsSettings?.modelId
      ? `Модель из настроек Dots: ${dotsSettings.modelId}`
      : 'Основная модель чата (main)'

  // Live-статус чата Dot'а (глобальная подписка пишет для всех чатов).
  const live = useChatStore(s => s.liveByChat[chatId])
  const isTyping = !!live?.isTyping
  const runStatus = useChatStore(s => s.runStatusByChat[chatId])

  // Загрузка ленты (вызывается и из IPC-колбэков ниже)
  const load = useCallback(async () => {
    try {
      const msgs = await window.syntee.chat.getMessages(chatId) as Message[]
      setMessages(msgs ?? [])
    } catch { /* ignore */ }
  }, [chatId])

  // Первичная загрузка: .then-паттерн (setState в колбэке промиса, не в теле эффекта)
  useEffect(() => {
    let cancelled = false
    window.syntee.chat.getMessages(chatId)
      .then((msgs: Message[]) => { if (!cancelled) setMessages(msgs ?? []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [chatId])

  // Webhook URL (для чипа в шапке)
  useEffect(() => {
    window.syntee.dots.getWebhookUrl(dot.id).then(setWebhookUrl).catch(() => setWebhookUrl(null))
  }, [dot.id, dot.webhookEnabled])

  // Динамический отступ под инпут — тот же паттерн, что в ChatPage:
  // .chat-input-wrap абсолютный (bottom:0) и плавает ПОВЕРХ ленты, поэтому
  // ленте нужен padding-bottom = высоте инпута (иначе контент уходит под
  // инпут и его не докрутить скроллом). Высота живая — ResizeObserver.
  useEffect(() => {
    const root = rootRef.current
    const holder = inputHostRef.current
    const wrap = holder?.firstElementChild as HTMLElement | undefined
    if (!root || !wrap) return
    const apply = () => { root.style.setProperty('--dot-input-h', `${wrap.offsetHeight}px`) }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // События: финал стрима → append; wake-старт/ран Dot'а → reload
  useEffect(() => {
    const offDone = window.syntee.on(IPC_EVENTS.CHAT_STREAM_DONE, (...args: unknown[]) => {
      const data = args[0] as { chatId: string; message: Message }
      if (data.chatId !== chatId) return
      setMessages(prev =>
        prev.some(m => m.id === data.message.id) ? prev : [...prev, data.message])
    })
    const offStatus = window.syntee.on(IPC_EVENTS.CHAT_RUN_STATUS, (...args: unknown[]) => {
      const data = args[0] as { chatId: string; status: string }
      if (data.chatId !== chatId) return
      // 'running' — проснулось что-то новое (wake или наш send): перечитываем
      // ленту (wake-сообщение сохраняется в main до статуса running).
      if (data.status === 'running') void load()
    })
    const offRun = window.syntee.on(IPC_EVENTS.DOTS_RUN_FINISHED, (...args: unknown[]) => {
      const p = (args[0] ?? {}) as { chatId?: string }
      if (p.chatId !== chatId) return
      // silent-ран удалил пару сообщений — перечитываем ленту из БД.
      void load()
    })
    return () => { offDone(); offStatus(); offRun() }
  }, [chatId, load])

  // Автоскролл при новых сообщениях/токенах (если закреплено)
  useEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [messages.length, live?.text, live?.steps?.length])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

  // Отправка: тот же chat:send, что в ChatPage (упрощённо: без slash/вложений).
  const handleSend = useCallback(async (text: string) => {
    const raw = text.trim()
    if (!raw) return
    const userMsg: Message = {
      id: uuid(),
      chatId,
      role: 'user',
      content: raw,
      createdAt: Date.now(),
      isPinned: 0,
    }
    pinnedRef.current = true
    try {
      const result = await window.syntee.chat.send({
        chatId,
        content: raw,
        userMsgId: userMsg.id,
        mode: 'work',
      }) as { queued?: boolean }
      if (!result?.queued) {
        setMessages(prev => [...prev, userMsg])
        initChatSend(chatId)
      }
      // queued: main поставит в очередь; сообщение появится по 'running'.
    } catch (e) {
      console.error('[DotChat] send failed', e)
    }
  }, [chatId])

  const handleStop = useCallback(() => {
    window.syntee.chat.stop(chatId).catch(() => {})
  }, [chatId])

  // Лента + live-пузырь
  const displayMessages = useMemo(() => {
    if (!isTyping) return messages
    return [...messages, {
      id: 'live-streaming-bubble',
      chatId,
      role: 'assistant' as const,
      content: '',
      // eslint-disable-next-line react-hooks/purity -- синтетический live-пузырь: метка косметическая (тот же паттерн, что в ChatPage displayMessages)
      createdAt: Date.now(),
      isPinned: 0,
    } as Message]
  }, [messages, isTyping, chatId])

  const isGenerating = isTyping || runStatus?.status === 'queued' || runStatus?.status === 'running'

  // Контекст-счётчик для ContextRing — тот же хук, что в ChatPage:
  // кольцо в инпут-баре показывает реальный контекст чата Dot'а и кликается.
  const contextInfo = useContextCounter({
    chatId,
    currentInput: draft,
    modelId: modelId || '',
    enabled: true,
    messageCount: messages.length,
    isRunning: isGenerating,
  })

  return (
    <div className="dot-chat" ref={rootRef}>
      {/* Шапка чата Dot'а */}
      <div className="dot-chat-header">
        <DotBlob color={dot.color} icon={dot.icon} status={dot.state.status} size={32} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="dot-chat-header-name">{dot.name}</div>
          <div className="dot-chat-header-purpose" title={dot.purpose}>{dot.purpose}</div>
        </div>
        <span className="dot-chat-model" title={modelTitle}>{modelId || 'осн. модель'}</span>
        {webhookUrl && (
          <button
            type="button"
            className="dots-header-btn"
            title={`Скопировать webhook: ${webhookUrl}`}
            onClick={() => {
              navigator.clipboard?.writeText(webhookUrl).catch(() => {})
            }}
          >
            <AppIcon name="link" size="xs" /> Webhook
          </button>
        )}
        <button
          type="button"
          className={`dots-header-btn${showRuns ? ' dots-header-btn--active' : ''}`}
          onClick={() => setShowRuns(v => !v)}
          title="История пробуждений"
        >
          <AppIcon name="history" size="xs" /> История
        </button>
        <button
          type="button"
          className="dots-header-btn dots-header-btn--primary"
          onClick={onWake}
          disabled={dot.state.status === 'running' || !dot.enabled}
          title="Разбудить Dot’а сейчас"
        >
          <AppIcon name="zap" size="xs" /> Разбудить
        </button>
      </div>

      {/* История ранов */}
      {showRuns && (
        <div className="dot-runs">
          <div className="dot-runs-title">История пробуждений</div>
          {runs.length === 0 && (
            <div className="dot-run-row">
              <span className="dot-run-summary">Ещё ни одного пробуждения</span>
            </div>
          )}
          {runs.map(r => (
            <div key={r.id} className="dot-run-row">
              <span className={`dot-run-badge dot-run-badge--${r.status}`}>
                {r.status === 'report' ? 'отчёт' : r.status === 'silent' ? 'тихо' : r.status === 'running' ? 'работа' : r.status === 'error' ? 'ошибка' : 'стоп'}
              </span>
              <div className="dot-run-info">
                <div className="dot-run-summary" title={r.summary}>
                  {r.summary || (r.status === 'silent' ? 'изменений не найдено' : '—')}
                </div>
                <div className="dot-run-time">
                  {fmtTime(r.startedAt)} · {r.trigger}
                  {r.completionTokens ? ` · ${r.completionTokens} ток.` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Лента сообщений (наследованный рендер) */}
      <div className="dot-chat-messages" ref={scrollRef} onScroll={handleScroll}>
        <div className="dot-chat-messages-inner">
          {displayMessages.length === 0 && !isTyping && (
            <div className="dot-chat-empty">
              <DotBlob color={dot.color} icon={dot.icon} status="sleeping" size={64} />
              <div className="dot-chat-empty-title">{dot.name} ещё спит</div>
              <div className="dot-chat-empty-text">
                Нажми «Разбудить» — или напиши ему: он ответит и запомнит контекст задачи.
              </div>
            </div>
          )}
          {displayMessages.map((msg, i) => {
            const isLive = msg.id === 'live-streaming-bubble'
            return (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={isLive && isTyping}
                isWaiting={isLive && isTyping}
                shouldAnimate={i >= displayMessages.length - 3}
                editorAvailable={!isLive}
              />
            )
          })}
        </div>
      </div>

      {/* Инпут-бар (наследованный ChatInput) — паттерн ChatPage: слот с
          display:contents, корень .chat-input-wrap абсолютный и пинится к
          .dot-chat (position:relative). Лента получает padding-bottom
          = --dot-input-h (ResizeObserver выше) — контент не уходит под инпут. */}
      <div ref={inputHostRef} style={{ display: 'contents' }}>
        <ChatInput
          chatId={chatId}
          onSend={handleSend}
          value={draft}
          onChangeValue={setDraft}
          disabled={false}
          isGenerating={isGenerating}
          onStop={handleStop}
          contextInfo={contextInfo}
          showContextRing
        />
      </div>
    </div>
  )
}
