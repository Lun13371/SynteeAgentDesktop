import { useEffect } from 'react'
import { useChatStore } from '../store/chat.store'
import type { Message } from '../../../shared/types'

// ── useBackgroundLoadFullChat — тихая фоновая догрузка всей истории ────────
// После первой загрузки окна (50 сообщений) тихо догружаем старые страницы
// в фоне, пока не выгрузим весь чат. Без индикатора, без прыжков скролла —
// компенсация позиции идёт через prependingRef (тот же ref, что у скролл-
// триггера loadOlderMessages: useLayoutEffect в ChatPage/SplitChatPane
// отрабатывает для обеих дорожек).
//
// Прерывается: смена чата, большой чат (> LARGE_CHAT_THRESHOLD — оставляем
// reverse-infinite scroll со спиннером), или уже всё загружено.
//
// Дедуп со скролл-триггером: общий busy-сигнал (isBusy/setBusy). Пока фон
// держит busy=true (на время IPC), скролл-триггер loadOlderMessages отрабаты-
// вает вхолостую (ранний return по busy). На idle-yield слот свободен, но
// single-threaded JS гарантирует: только один из них держит busy за раз.
//
// isBusy/setBusy абстрактны: ChatPage передаёт стор-флаг isLoadingOlder
// (через getState/setState — всегда свежий), SplitChatPane — локальный ref
// (независимость от ChatPage в split-режиме, без кросс-контаминации).

export interface BackgroundLoadOptions {
  /** id чата, для которого идёт догрузка (currentChatId чата или splitChatId). */
  chatId: string | null
  /** true для больших чатов (> LARGE_CHAT_THRESHOLD) — фон не запускается. */
  isLargeChat: boolean
  /** ref на prepending-снапшот скролла (общий со скролл-триггером). */
  prependingRef: React.MutableRefObject<{ oldScrollHeight: number; oldScrollTop: number } | null>
  /** ref на скролл-контейнер (.chat-messages) — для замера scrollHeight. */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Размер страницы догрузки. */
  pageSize?: number
  /** Свежий read-флаг «идёт загрузка» (без stale-closure: getState или ref). */
  isBusy: () => boolean
  /** Установить флаг «идёт загрузка». */
  setBusy: (v: boolean) => void
}

const DEFAULT_PAGE_SIZE = 50

export function useBackgroundLoadFullChat({
  chatId,
  isLargeChat,
  prependingRef,
  scrollContainerRef,
  pageSize = DEFAULT_PAGE_SIZE,
  isBusy,
  setBusy,
}: BackgroundLoadOptions) {
  useEffect(() => {
    if (!chatId) return
    if (isLargeChat) return // большой чат — reverse-infinite scroll со спиннером

    let cancelled = false
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
    // requestIdleCallback не блокирует rAF-цикл автоскролла/отрисовки.
    const idleYield = () =>
      new Promise<void>(r => {
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback
        if (ric) ric(() => r())
        else setTimeout(r, 50)
      })

    // Не стартуем в кадр переключения: первая же страница истории = IPC +
    // prependOlderMessages → новый массив messages → полный пересчёт измерений
    // виртуализатора, ровно поверх первого рендера нового чата. Два idle-слота
    // = лента успевает отрисоваться и вуаль переключения уйти.
    const run = async () => {
      await idleYield()
      await idleYield()
      if (cancelled) return
      while (!cancelled) {
        const st = useChatStore.getState()
        // Свитч чата — стоп.
        if (st.currentChatId !== chatId && st.splitChatId !== chatId) return
        // Скролл-триггер (или предыдущая итерация) ещё грузит — ждём.
        if (isBusy()) { await sleep(60); continue }
        // Окно целевого чата. Для current — messages + hasOlderMessages;
        // для split — messagesByChat[chatId] (entry). Кеш актуален для обоих.
        const entry = st.messagesByChat[chatId]
        const hasOlder = entry?.hasOlder ?? (st.currentChatId === chatId ? st.hasOlderMessages : false)
        if (!hasOlder) return // всё загружено
        const windowMessages: Message[] = entry?.messages ?? (st.currentChatId === chatId ? st.messages : [])
        const oldest = windowMessages[0]
        if (!oldest) return

        // Скролл-компенсация: снапаем геометрию ДО догрузки. useLayoutEffect
        // в компоненте отработает после prepend и восстановит scrollTop.
        const el = scrollContainerRef.current
        if (el) prependingRef.current = { oldScrollHeight: el.scrollHeight, oldScrollTop: el.scrollTop }

        setBusy(true) // заняли дедуп-слот
        try {
          const res = await window.syntee.chat.getMessagesPage(chatId, pageSize, oldest.createdAt, oldest.id) as { messages: Message[]; hasMore: boolean }
          // Пока грузили — свитч/удаление. Слот освободит finally.
          if (cancelled) return
          const after = useChatStore.getState()
          if (after.currentChatId !== chatId && after.splitChatId !== chatId) return
          // prependOlderMessages обновит кеш (и стор-флаг для current чата).
          st.prependOlderMessages(chatId, res.messages, res.hasMore)
        } catch {
          // Ошибка IPC — молча, слот освободит finally.
        } finally {
          // Сбрасываем busy безусловно: даже при cancel/switch — иначе флаг
          // останется true и заблокирует scroll-триггер / следующий запуск
          // (при смене chatId старый busy=true душит новый run на том же флаге).
          // Для ChatPage стор-флаг уже мог быть сброшен prependOlderMessages —
          // повторный setBusy(false) идемпотентен. Для SplitChatPane setState
          // на размонтированном компоненте в React 18 не warns.
          setBusy(false)
        }

        // Отдаём кадр браузеру: автоскролл/отрисовка/компенсация успевают.
        await idleYield()
      }
    }

    run()
    return () => { cancelled = true }
    // chatId/isLargeChat/prependingRef/scrollContainerRef стабильны по refs;
    // isBusy/setBusy — стабильные (useCallback/getState). mount-once на
    // смену chatId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, isLargeChat])
}
