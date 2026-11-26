import { useEffect } from 'react'
import { buffers, getBuf, liveSet, isAuxWindow } from './chatRunRuntime'
import { useChatStore } from '../store/chat.store'
import { mergeOrchestrationProgress, type OrchestrationProgress } from '../utils/orchestrationProgress'

/** Полезная нагрузка события `agent:orchestration_progress`. */
export interface OrchestrationProgressEvent {
  chatId: string
  msgId: string
  progress: OrchestrationProgress
}

// Preload-контракт (реализуется в preload/index): window.syntee.chat.
// onOrchestrationProgress(cb) → unsubscribe. Доступ через опциональный каст —
// renderer собирается и без свежего preload-типа (dev-сборка, старый preload);
// тогда остаётся generic-канал window.syntee.on (см. ниже), а если нет и его —
// карточка живёт только на истории (message.orchestration).
type OrchestrationBridge = {
  onOrchestrationProgress?: (cb: (e: OrchestrationProgressEvent) => void) => (() => void) | void
}
type GenericBridge = {
  on?: (channel: string, cb: (e: OrchestrationProgressEvent) => void) => (() => void) | void
}

/**
 * Подписка на live-прогресс оркестрации.
 * Мерж: одна запись на вхождение фазы (phase + startedAt, см.
 * mergeOrchestrationProgress в shared/orchestrationProgress) — повторные
 * круги не затирают друг друга, список ограничен капом.
 * msgId-guard: события чужого рана игнорируются; первое событие промоутит
 * 'streaming-pending' → реальный msgId (оркестрация может начаться ДО
 * первого токена модели).
 */
export function useOrchestrationProgress() {
  useEffect(() => {
    if (isAuxWindow()) return

    const handler = (data: OrchestrationProgressEvent): void => {
      if (!data?.chatId || !data.progress) return
      const chatId = data.chatId
      // Позднее событие после завершения рана не должно реанимировать
      // live-пузырь: буфер удаляется на CHAT_STREAM_DONE. Принимаем событие,
      // только если буфер ещё жив ИЛИ ран реально активен (running/queued) —
      // оркестрация может прислать первую фазу раньше ответа chat:send.
      const existing = buffers.get(chatId)
      if (!existing) {
        const runStatus = useChatStore.getState().runStatusByChat[chatId]?.status
        if (runStatus !== 'running' && runStatus !== 'queued') return
      }
      const buf = existing ?? getBuf(chatId)
      // Усваиваем реальный msgId из первого события (как в agent:step).
      if ((!buf.streamMsgId || buf.streamMsgId === 'streaming-pending') && data.msgId) {
        buf.streamMsgId = data.msgId
        liveSet(chatId, { msgId: data.msgId, isTyping: true })
      }
      if (data.msgId && buf.streamMsgId && data.msgId !== buf.streamMsgId) return

      buf.orchestration = mergeOrchestrationProgress(buf.orchestration, data.progress)
      liveSet(chatId, {
        orchestration: buf.orchestration,
        isTyping: true,
      })
    }

    const bridge = (window.syntee?.chat ?? {}) as unknown as OrchestrationBridge
    const generic = (window.syntee ?? {}) as unknown as GenericBridge
    const offs: Array<(() => void) | void> = []
    if (typeof bridge.onOrchestrationProgress === 'function') {
      offs.push(bridge.onOrchestrationProgress(handler))
    }
    // Fallback: generic-канал события (если preload пробрасывает его как
    // window.syntee.on('agent:orchestration_progress')). Мерж идемпотентен,
    // поэтому двойная доставка не задваивает фазы.
    if (typeof generic.on === 'function') {
      offs.push(generic.on('agent:orchestration_progress', handler))
    }
    if (offs.length === 0) return

    return () => {
      for (const off of offs) if (typeof off === 'function') off()
    }
  }, [])
}

/** Сброс live-прогресса оркестрации чата (дебаг/тесты). */
export function resetOrchestrationProgress(chatId: string): void {
  const buf = buffers.get(chatId)
  if (!buf) return
  buf.orchestration = []
  liveSet(chatId, { orchestration: [] })
}
