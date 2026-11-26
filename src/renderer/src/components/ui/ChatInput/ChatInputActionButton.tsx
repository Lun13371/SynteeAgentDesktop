import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import type { UseVoiceInputResult } from '../../../hooks/useVoiceInput'

/**
 * §steer — порог удержания кнопки отправки. Уложился — обычная отправка
 * (во время генерации запрос встанет в очередь), дождался — реплика летит
 * прямо в контекст работающего агента, не дожидаясь очереди.
 */
export const STEER_HOLD_MS = 500

interface ChatInputActionButtonProps {
  value: string
  isGenerating?: boolean
  voice: UseVoiceInputResult
  micBusy: boolean
  sendBurst: boolean
  onStop?: () => void
  onSend: () => void
  onMicClick: () => void
  /**
   * §steer — вызывать по завершении удержания: текст внедряется в контекст
   * активного рана. Если не задан — long-press выключен, кнопка работает
   * как раньше.
   */
  onSteer?: () => void
  /**
   * §steer — удержание идёт извне (зажали Enter): кнопка показывает то же
   * кольцо-прогресс, что и при удержании мышью. Логику таймера держит ChatInput.
   */
  holdActive?: boolean
  /**
   * Отправка недоступна (например, one-turn оркестрация без выбранного
   * исполнителя): клик и удержание ничего не делают, кнопка выглядит
   * заблокированной, tooltip объясняет причину.
   */
  blocked?: boolean
  /** Текст tooltip в заблокированном состоянии. */
  blockedTitle?: string
}

/**
 * Главная кнопка действия инпута: Send / Stop / Mic (голосовой ввод).
 * Логика выбора режима: текст в поле → Send (даже при генерации — уйдёт в
 * очередь). Пустое поле + генерация → Stop. Пустое поле + idle → Mic.
 * Во время записи/распознавания голоса — показываем recording-состояние
 * кнопки (независимо от наличия текста) — юзер жмёт снова чтобы остановить.
 *
 * §steer — когда текст + идёт генерация (то есть клик ушёл бы в очередь),
 * удержание кнопки в течение STEER_HOLD_MS переключает действие: сообщение
 * внедряется в контекст агента прямо посреди рана. Во время удержания —
 * наливающееся кольцо вокруг иконки и смена send → zap; отпустил раньше —
 * обычная отправка (клик отрабатывает как раньше).
 */
export function ChatInputActionButton({
  value,
  isGenerating,
  voice,
  micBusy,
  sendBurst,
  onStop,
  onSend,
  onMicClick,
  onSteer,
  holdActive,
  blocked,
  blockedTitle,
}: ChatInputActionButtonProps) {
  const voiceActive = voice.state === 'recording' || voice.state === 'transcribing' || voice.state === 'requesting'
  const btnMode = voiceActive
    ? 'voice'
    : value.trim() ? 'send' : isGenerating ? 'stop' : 'mic'
  // Send во время генерации — подсветим кольцом, поменяем tooltip.
  const sendToQueue = btnMode === 'send' && !!isGenerating
  // Внедрять можно только тогда, когда обычный клик ушёл бы в очередь.
  const canSteer = sendToQueue && !!onSteer

  const [holding, setHolding] = useState(false)
  // §steer — удержание с клавиатуры (Enter): кольцо и иконка-молния те же,
  // таймер живёт в ChatInput, сюда приходит только флаг «идёт удержание».
  // ВАЖНО: только && canSteer. Вне режима «клик ушёл бы в очередь» (агент
  // закончил, текст очистили, onSteer не передан) ни кольцо, ни молния
  // показывать нельзя — иначе залипший флаг holdActive превращал иконку
  // Send в молнию на обычномidle-поле.
  const holdingView = canSteer && (holding || !!holdActive)
  const holdRingKey = holding ? 'ring-pointer' : holdActive ? 'ring-key' : null
  const holdTimer = useRef<number | null>(null)
  // Удержание уже сработало → ближайший click нельзя превращать в обычную
  // отправку (он придёт автоматически после pointerup).
  const firedRef = useRef(false)

  // Залипший holdActive/holding дополнительно гейтится через canSteer в
  // holdingView, поэтому после смены режима старая молния не может попасть
  // на обычную Send-иконку. Локальное состояние сбрасывается в timeout,
  // pointerup и cleanup; эффект с setState здесь намеренно не нужен.
  const clearHold = useCallback(() => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
    setHolding(false)
  }, [])

  // Кнопка размонтировалась посреди удержания (сменился режим/текст очистился).
  useEffect(() => () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current)
  }, [])

  const handlePointerDown = () => {
    if (blockedSend || !canSteer) return
    firedRef.current = false
    setHolding(true)
    if (holdTimer.current !== null) clearTimeout(holdTimer.current)
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null
      setHolding(false)
      firedRef.current = true
      onSteer?.()
    }, STEER_HOLD_MS)
  }

  // Блокируется только ОТПРАВКА: стоп генерации и микрофон должны работать
  // даже при невалидном выборе оркестрации.
  const blockedSend = !!blocked && btnMode === 'send'

  const handleClick = () => {
    // Заблокировано: ни отправки, ни стопа, ни микрофона — причина в tooltip
    // и в блоке оркестрации над инпутом.
    if (blockedSend) {
      firedRef.current = false
      return
    }
    if (firedRef.current) {
      firedRef.current = false
      return
    }
    if (btnMode === 'stop') onStop?.()
    else if (btnMode === 'send') onSend()
    else onMicClick()
  }

  return (
    <motion.button
      className={`chat-input-action-btn chat-input-action-btn--${btnMode}${sendBurst ? ' chat-input-action-btn--burst' : ''}${sendToQueue ? ' chat-input-action-btn--queue' : ''}${canSteer ? ' chat-input-action-btn--steerable' : ''}${holdingView ? ' chat-input-action-btn--holding' : ''}${voice.state === 'recording' ? ' chat-input-action-btn--recording' : ''}${voice.state === 'transcribing' || voice.state === 'requesting' ? ' chat-input-action-btn--busy' : ''}${micBusy ? ' chat-input-action-btn--busy' : ''}${blockedSend ? ' chat-input-action-btn--blocked' : ''}`}
      aria-disabled={blockedSend || undefined}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      whileTap={blockedSend ? undefined : { scale: 0.88 }}
      whileHover={blockedSend ? undefined : { scale: 1.08 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      title={blockedSend ? (blockedTitle || 'Отправка недоступна') : btnMode === 'stop' ? 'Остановить генерацию' : btnMode === 'send' ? (sendToQueue ? (holdingView ? 'Держите ещё немного — уйдёт в контекст агента' : 'Клик — в очередь · удержать 0,5с — внедрить в контекст агента') : 'Отправить (Enter)') : voice.state === 'recording' ? `Запись... ${voice.recordingSec}с — нажмите чтобы остановить` : voice.state === 'transcribing' ? 'Распознавание речи...' : micBusy ? (voice.progress?.message || 'Загрузка модели Whisper...') : 'Голосовой ввод'}
    >
      {/* §steer — индикатор удержания: дуга наливается по кругу кнопки.
          Работает и для мыши, и для удержания Enter (holdActive из ChatInput). */}
      <AnimatePresence>
        {holdingView && holdRingKey && (
          <motion.svg
            key={holdRingKey}
            className="chat-input-action-ring"
            viewBox="0 0 32 32"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <circle className="ring-track" cx="16" cy="16" r="14" />
            <motion.circle
              className="ring-fill"
              cx="16"
              cy="16"
              r="14"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: STEER_HOLD_MS / 1000, ease: 'linear' }}
            />
          </motion.svg>
        )}
      </AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>
        {btnMode === 'stop' ? (
          <motion.span key="stop" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }} className="chat-input-stop-icon" />
        ) : btnMode === 'send' ? (
          <motion.span key="send" initial={{ rotate: -90, opacity: 0, scale: 0.5 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 90, opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
            <AppIcon name={holdingView ? 'zap' : 'send'} size="md" />
          </motion.span>
        ) : btnMode === 'voice' ? (
          voice.state === 'transcribing' || voice.state === 'requesting' ? (
            <motion.span key="voice-busy" initial={{ opacity: 0, scale: 0.5 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
              <AppIcon name="loader" size="md" animation="spin" />
            </motion.span>
          ) : (
            <motion.span key="voice-rec" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
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
  )
}
