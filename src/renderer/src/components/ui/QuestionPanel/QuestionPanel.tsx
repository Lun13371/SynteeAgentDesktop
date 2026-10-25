import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { QuestionSpec, QuestionAnswer, QuestionType } from '../../../../../shared/types'
import AppIcon from '../AppIcon/AppIcon'
import { playConfirmSound } from '../../../utils/sounds'
import { useChatStore } from '../../../store/chat.store'
import './QuestionPanel.css'

interface PendingQuestion {
  reqId: string
  chatId: string
  msgId: string
  questions: QuestionSpec[]
}

interface AnswerDraft {
  values: string[]
  text: string
  value?: boolean
}

const EMPTY_DRAFT: AnswerDraft = { values: [], text: '' }

/** Стабильная пустая ссылка для черновиков «нет активного запроса». */
const EMPTY_DRAFTS: Record<string, AnswerDraft> = {}

/**
 * Нормализация вопросов от AI.
 * - options может прийти как string[] вместо объектов
 * - options без value / с дубликатами → все опции «выделялись все сразу»
 *   (values.includes(undefined) === true у каждой опции)
 * - id генерируем, если модель его не дала
 */
function normalizeQuestions(raw: QuestionSpec[]): QuestionSpec[] {
  return (raw || []).map((q, i) => {
    const options = Array.isArray(q.options)
      ? q.options
          .map((rawOpt, oi) => {
            const opt = typeof rawOpt === 'string' ? { value: rawOpt, label: rawOpt } : rawOpt
            return {
              ...opt,
              value: typeof opt.value === 'string' && opt.value.trim() !== ''
                ? opt.value
                : (typeof opt.label === 'string' && opt.label.trim() !== '' ? opt.label : `opt_${oi}`),
              label: typeof opt.label === 'string' && opt.label.trim() !== '' ? opt.label : `Вариант ${oi + 1}`,
            }
          })
          // Дедуп по value: дубликаты получают уникальный суффикс
          .map((opt, oi, arr) =>
            arr.findIndex(o => o.value === opt.value) === oi
              ? opt
              : { ...opt, value: `${opt.value}_${oi}` },
          )
      : undefined
    return {
      ...q,
      id: q.id || `q_${Date.now()}_${i}`,
      options,
    }
  })
}

/** Пустые черновики для всех вопросов запроса. */
function emptyDrafts(questions: QuestionSpec[]): Record<string, AnswerDraft> {
  const init: Record<string, AnswerDraft> = {}
  for (const q of questions) init[q.id!] = { ...EMPTY_DRAFT }
  return init
}

/**
 * Встать в очередь. КЛЮЧЕВОЕ: новый вопрос НЕ перекрывает активный —
 * раньше панель имела один слот, второй ask_user (из другого чата/суб-агента)
 * затирал первый, его черновики сбрасывались, а ответ никогда не
 * отправлялся → агент висел в ожидании. now: FIFO + дедуп по reqId.
 */
export function enqueueQuestion(queue: PendingQuestion[], item: PendingQuestion): PendingQuestion[] {
  return queue.some(x => x.reqId === item.reqId) ? queue : [...queue, item]
}

/** Снять запрос из очереди (ответ/пропуск/Стоп) — с любой позиции. */
export function dequeueQuestion(queue: PendingQuestion[], reqId: string): PendingQuestion[] {
  return queue.filter(x => x.reqId !== reqId)
}

/** Авто-detect типа если не указан. */
function resolveType(q: QuestionSpec): QuestionType {
  if (q.type) return q.type
  if (q.options && q.options.length > 0) return 'choice'
  return 'text'
}

/** Проверяет условие showIf вопроса против уже данных ответов. */
function isQuestionVisible(q: QuestionSpec, answers: Record<string, AnswerDraft>): boolean {
  if (!q.showIf) return true
  const dep = answers[q.showIf.questionId]
  if (!dep) return false
  // equals может быть строкой или массивом. Для yesno — "true"/"false".
  const target = q.showIf.equals
  const targets = Array.isArray(target) ? target : [target]
  // Проверяем по values (choice) или value (yesno)
  if (dep.value !== undefined) {
    return targets.includes(String(dep.value))
  }
  if (dep.values && dep.values.length > 0) {
    return dep.values.some(v => targets.includes(v))
  }
  return false
}

export default function QuestionPanel() {
  // ── Очередь вопросов ───────────────────────────────────────────────
  // Панель ГЛОБАЛЬНАЯ (один экземпляр в App), а ask_user может прийти из
  // любого чата и от любого суб-агента. Раньше здесь был один слот
  // (pending), и новый вопрос перезаписывал предыдущий: черновики сбрасывались,
  // а ответ на старый запрос никогда не отправлялся → тот агент зависал
  // навсегда в ожидании questionResponse. Теперь FIFO-очередь (как в
  // AgentConfirmDialog): активный = queue[0], остальные ждут своей очереди.
  const [queue, setQueue] = useState<PendingQuestion[]>([])
  // Черновики — per-reqId, иначе ответы/условия showIf перетекают между
  // вопросами разных запросов.
  const [draftsByReq, setDraftsByReq] = useState<Record<string, Record<string, AnswerDraft>>>({})
  // Позиция визарда привязана к reqId: при смене головы очереди индекс
  // схлопывается в 0 сам, без setState в эффекте (и без сброса активного
  // вопроса, когда в очередь встаёт новый).
  const [wizard, setWizard] = useState<{ reqId: string; idx: number }>({ reqId: '', idx: 0 })
  // Раскрытое пояснение — id вопроса, к которому оно открыто (при переходе
  // на другой вопрос схлопывается автоматически).
  const [helpFor, setHelpFor] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const pending = queue[0] ?? null
  const activeReqId = pending?.reqId ?? null
  const drafts = (pending && draftsByReq[pending.reqId]) || EMPTY_DRAFTS

  const dropDrafts = useCallback((reqId: string) => {
    setDraftsByReq(prev => {
      if (!(reqId in prev)) return prev
      const next = { ...prev }
      delete next[reqId]
      return next
    })
  }, [])

  /** Отправить ответ на активный запрос и снять его с головы очереди. */
  const finishCurrent = useCallback((reqId: string, answers: QuestionAnswer[]) => {
    window.syntee.agent.questionResponse(reqId, answers)
    setQueue(q => dequeueQuestion(q, reqId))
    dropDrafts(reqId)
  }, [dropDrafts])

  // Вопрос может прийти из чата, который сейчас не открыт — показываем откуда он.
  const pendingChatTitle = useChatStore(s =>
    s.currentChatId === pending?.chatId ? undefined : s.chats.find(c => c.id === pending?.chatId)?.title,
  )

  useEffect(() => {
    const wrapper = window.syntee.agent.onQuestion((data) => {
      const questions = normalizeQuestions(data.questions as QuestionSpec[])
      const item: PendingQuestion = {
        reqId: data.reqId,
        chatId: data.chatId,
        msgId: data.msgId,
        questions,
      }
      setDraftsByReq(prev => ({ ...prev, [item.reqId]: emptyDrafts(questions) }))
      // Встаём в очередь, а не перекрываем активный вопрос.
      // Дедуп по reqId — на случай повторной доставки того же запроса.
      setQueue(q => enqueueQuestion(q, item))
      playConfirmSound()
    })
    // Запрос закрыт извне (Стоп/ответ через notification overlay) — снимаем
    // его с любого места очереди, а не только с головы.
    const offDismiss = window.syntee.agent.onQuestionDismiss((reqId) => {
      setQueue(q => dequeueQuestion(q, reqId))
      dropDrafts(reqId)
    })
    return () => {
      if (wrapper) window.syntee.agent.offQuestion?.(wrapper as never)
      offDismiss()
    }
  }, [dropDrafts])

  // Видимый список вопросов (с учётом showIf — фильтруется по уже данным ответам)
  const visibleQuestions = useMemo(() => {
    if (!pending) return []
    return pending.questions.filter(q => isQuestionVisible(q, drafts))
  }, [pending, drafts])

  // Эффективный индекс — если visibleIdx вышел за пределы (вопрос скрылся showIf),
  // clamp к последнему видимому. Без setState в effect.
  const visibleIdx = wizard.reqId === activeReqId ? wizard.idx : 0
  const effectiveVisibleIdx = Math.min(visibleIdx, Math.max(0, visibleQuestions.length - 1))
  const currentQuestion = visibleQuestions[effectiveVisibleIdx]
  const currentQuestionId = currentQuestion?.id ?? null
  const currentDraft = currentQuestion ? (drafts[currentQuestion.id!] || EMPTY_DRAFT) : EMPTY_DRAFT
  const helpExpanded = currentQuestionId !== null && helpFor === currentQuestionId

  // Фокус в поле ввода: при смене активного запроса и при навигации по вопросам.
  useEffect(() => {
    if (!activeReqId || !currentQuestionId) return
    const t = setTimeout(() => inputRef.current?.focus(), 220)
    return () => clearTimeout(t)
  }, [activeReqId, currentQuestionId, effectiveVisibleIdx])

  const updateDraft = useCallback((reqId: string, qId: string, patch: Partial<AnswerDraft>) => {
    setDraftsByReq(prev => {
      const forReq = prev[reqId] || {}
      return { ...prev, [reqId]: { ...forReq, [qId]: { ...(forReq[qId] || EMPTY_DRAFT), ...patch } } }
    })
  }, [])

  const toggleOption = (reqId: string, qId: string, value: string, multiple: boolean) => {
    setDraftsByReq(prev => {
      const forReq = prev[reqId] || {}
      const cur = forReq[qId] || EMPTY_DRAFT
      let values: string[]
      if (multiple) {
        values = cur.values.includes(value)
          ? cur.values.filter(v => v !== value)
          : [...cur.values, value]
      } else {
        values = cur.values.includes(value) ? [] : [value]
      }
      return { ...prev, [reqId]: { ...forReq, [qId]: { ...cur, values } } }
    })
  }

  const setYesNo = (reqId: string, qId: string, val: boolean) => {
    updateDraft(reqId, qId, { value: val })
  }

  const isCurrentAnswered = useMemo(() => {
    if (!currentQuestion) return false
    const type = resolveType(currentQuestion)
    switch (type) {
      case 'yesno':
        return currentDraft.value !== undefined
      case 'choice':
        return currentDraft.values.length > 0 || (currentQuestion.allowCustom !== false && currentDraft.text.trim() !== '')
      case 'text':
      default:
        return currentDraft.text.trim() !== ''
    }
  }, [currentQuestion, currentDraft])

  // Проверка что все обязательные ВИДИМЫЕ вопросы отвечены
  const allRequiredAnswered = useMemo(() => {
    return visibleQuestions.every(q => {
      if (!q.required) return true
      const d = drafts[q.id!]
      if (!d) return false
      const type = resolveType(q)
      switch (type) {
        case 'yesno': return d.value !== undefined
        case 'choice':
          return d.values.length > 0 || (q.allowCustom !== false && d.text.trim() !== '')
        case 'text':
        default:
          return d.text.trim() !== ''
      }
    })
  }, [visibleQuestions, drafts])

  const isLastVisible = effectiveVisibleIdx === visibleQuestions.length - 1
  const canGoNext = isCurrentAnswered || !currentQuestion?.required

  const resetHelp = () => setHelpFor(null)

  // Навигация пишется вместе с reqId активного запроса — так смена головы
  // очереди автоматически начинает визард с первого вопроса.
  const goToStep = (idx: number) => {
    if (!activeReqId) return
    resetHelp()
    setWizard({ reqId: activeReqId, idx })
  }

  const handleNext = () => {
    if (!canGoNext) return
    if (effectiveVisibleIdx < visibleQuestions.length - 1) {
      goToStep(effectiveVisibleIdx + 1)
    }
  }

  const handleBack = () => {
    if (effectiveVisibleIdx > 0) {
      goToStep(effectiveVisibleIdx - 1)
    }
  }

  const handleSubmit = () => {
    if (!pending || !allRequiredAnswered) return
    // Возвращаем ответы на ВСЕ вопросы (включая скрытые showIf — для них пустые)
    const answers: QuestionAnswer[] = pending.questions.map(q => {
      const d = drafts[q.id!] || EMPTY_DRAFT
      const type = resolveType(q)
      const ans: QuestionAnswer = { id: q.id! }
      if (type === 'yesno') {
        ans.value = d.value
      }
      if (d.values.length > 0) ans.values = d.values
      if (d.text.trim()) ans.text = d.text.trim()
      return ans
    })
    finishCurrent(pending.reqId, answers)
  }

  // Крестик/«Пропустить» — пропускает ТОЛЬКО текущий запрос (пустые ответы),
  // следующий из очереди показывается сразу после.
  const handleSkip = () => {
    if (!pending) return
    finishCurrent(pending.reqId, pending.questions.map(q => ({ id: q.id! })))
  }

  const hasRequired = pending?.questions.some(q => q.required) ?? false
  const total = visibleQuestions.length
  const progress = total > 0 ? ((effectiveVisibleIdx + 1) / total) * 100 : 0
  const type = currentQuestion ? resolveType(currentQuestion) : 'text'

  return (
    <AnimatePresence>
      {pending && currentQuestion && (
        <motion.div
          className="qp-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <motion.div
            className="qp-panel"
            initial={{ y: 32, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            transition={{
              duration: 0.3,
              ease: [0.16, 1, 0.3, 1],
              exit: { duration: 0.18, ease: 'easeIn' },
            }}
          >
            <div className="qp-progress-track">
              <motion.div
                className="qp-progress-fill"
                animate={{ width: `${progress}%` }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              />
            </div>

            <div className="qp-header">
              <div className="qp-header-icon">
                <AppIcon name={typeIcon(type)} size="sm" />
              </div>
              <div className="qp-header-text">
                <div className="qp-header-title">
                  {typeLabel(type)}
                  {pendingChatTitle && (
                    <span className="qp-header-origin" title={`Вопрос пришёл из чата «${pendingChatTitle}»`}>
                      {pendingChatTitle}
                    </span>
                  )}
                </div>
                <div className="qp-header-sub">
                  {total > 1 ? `Вопрос ${effectiveVisibleIdx + 1} из ${total}` : 'Syntee хочет уточнить'}
                  {queue.length > 1 && (
                    <span
                      className="qp-queue-badge"
                      title={`Ещё ${queue.length - 1} в очереди:\n${queue
                        .slice(1)
                        .map(x => x.questions[0]?.header || x.questions[0]?.question || '')
                        .filter(Boolean)
                        .join('\n')}`}
                    >
                      +{queue.length - 1} в очереди
                    </span>
                  )}
                </div>
              </div>
              <button
                className="qp-close"
                onClick={handleSkip}
                title={queue.length > 1 ? 'Пропустить текущий (перейти к следующему)' : 'Пропустить все'}
                type="button"
              >
                <AppIcon name="x" size="sm" />
              </button>
            </div>

            <div className="qp-body">
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentQuestion.id}
                  className="qp-question"
                  initial={{ opacity: 0, x: 24 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -24 }}
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                >
                  <div className="qp-q-header">
                    {currentQuestion.header && (
                      <div className="qp-q-label">{currentQuestion.header}</div>
                    )}
                    <div className="qp-q-text">
                      {currentQuestion.question}
                      {currentQuestion.required && (
                        <span className="qp-required" title="Обязательный">*</span>
                      )}
                    </div>
                  </div>

                  {/* Help text — раскрывающийся блок */}
                  {currentQuestion.helpText && (
                    <button
                      className="qp-help-toggle"
                      onClick={() => setHelpFor(helpExpanded ? null : currentQuestion.id!)}
                      type="button"
                    >
                      <AppIcon name="info" size="xs" />
                      {helpExpanded ? 'Скрыть пояснение' : 'Пояснение'}
                    </button>
                  )}
                  <AnimatePresence>
                    {helpExpanded && currentQuestion.helpText && (
                      <motion.div
                        className="qp-help-text"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        {currentQuestion.helpText}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* ── Рендер по типу ── */}
                  {type === 'yesno' && (
                    <div className="qp-yesno">
                      <motion.button
                        className={`qp-yesno-btn${currentDraft.value === true ? ' qp-yesno-btn--yes qp-yesno-btn--active' : ' qp-yesno-btn--yes'}`}
                        onClick={() => setYesNo(pending.reqId, currentQuestion.id!, true)}
                        whileTap={{ scale: 0.96 }}
                        whileHover={{ scale: 1.02 }}
                        type="button"
                      >
                        <AppIcon name="check" size="md" />
                        Да
                      </motion.button>
                      <motion.button
                        className={`qp-yesno-btn${currentDraft.value === false ? ' qp-yesno-btn--no qp-yesno-btn--active' : ' qp-yesno-btn--no'}`}
                        onClick={() => setYesNo(pending.reqId, currentQuestion.id!, false)}
                        whileTap={{ scale: 0.96 }}
                        whileHover={{ scale: 1.02 }}
                        type="button"
                      >
                        <AppIcon name="x" size="md" />
                        Нет
                      </motion.button>
                    </div>
                  )}

                  {type === 'choice' && currentQuestion.options && (
                    <div className={`qp-options${currentQuestion.multiple ? ' qp-options--multi' : ''}`}>
                      {currentQuestion.options.map(opt => {
                        const selected = currentDraft.values.includes(opt.value)
                        return (
                          <motion.button
                            key={opt.value}
                            className={`qp-option${selected ? ' qp-option--selected' : ''}`}
                            onClick={() => toggleOption(pending.reqId, currentQuestion.id!, opt.value, !!currentQuestion.multiple)}
                            whileTap={{ scale: 0.97 }}
                            whileHover={{ scale: 1.015 }}
                            type="button"
                          >
                            <div className="qp-option-mark">
                              {currentQuestion.multiple ? (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  {selected && <polyline points="20 6 9 17 4 12" />}
                                </svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <circle cx="12" cy="12" r="9" />
                                  {selected && <circle cx="12" cy="12" r="4.5" fill="currentColor" />}
                                </svg>
                              )}
                            </div>
                            <div className="qp-option-body">
                              <div className="qp-option-label">{opt.label}</div>
                              {opt.description && <div className="qp-option-desc">{opt.description}</div>}
                            </div>
                          </motion.button>
                        )
                      })}
                    </div>
                  )}

                  {/* Текстовое поле — для text, choice+allowCustom */}
                  {(type === 'text' || (type === 'choice' && currentQuestion.allowCustom !== false)) && (
                    <textarea
                      ref={inputRef}
                      className={`qp-input${currentQuestion.multiline ? ' qp-input--multiline' : ''}`}
                      placeholder={currentQuestion.placeholder || (type === 'choice' ? 'Свой ответ…' : 'Введите ответ…')}
                      value={currentDraft.text}
                      onChange={e => updateDraft(pending.reqId, currentQuestion.id!, { text: e.target.value })}
                      rows={currentQuestion.multiline ? 6 : 2}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault()
                          if (isLastVisible) {
                            if (allRequiredAnswered) handleSubmit()
                          } else if (canGoNext) {
                            handleNext()
                          }
                        }
                      }}
                    />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="qp-footer">
              <div className="qp-footer-left">
                {effectiveVisibleIdx > 0 && (
                  <button className="qp-btn qp-btn--ghost" onClick={handleBack} type="button">
                    <AppIcon name="chevronLeft" size="sm" />
                    Назад
                  </button>
                )}
                {!hasRequired && (
                  <button className="qp-btn qp-btn--ghost qp-btn--link" onClick={handleSkip} type="button">
                    {currentQuestion.skipLabel || 'Пропустить'}
                  </button>
                )}
              </div>
              <div className="qp-footer-right">
                <div className="qp-hint">
                  <kbd>⌘</kbd><kbd>↵</kbd>
                </div>
                {!isLastVisible ? (
                  <motion.button
                    className={`qp-btn qp-btn--primary${!canGoNext ? ' qp-btn--disabled' : ''}`}
                    onClick={handleNext}
                    disabled={!canGoNext}
                    whileTap={{ scale: canGoNext ? 0.96 : 1 }}
                    type="button"
                  >
                    Далее
                    <AppIcon name="chevronRight" size="sm" />
                  </motion.button>
                ) : (
                  <motion.button
                    className={`qp-btn qp-btn--primary qp-btn--submit${!allRequiredAnswered ? ' qp-btn--disabled' : ''}`}
                    onClick={handleSubmit}
                    disabled={!allRequiredAnswered}
                    whileTap={{ scale: allRequiredAnswered ? 0.96 : 1 }}
                    type="button"
                  >
                    <AppIcon name="check" size="sm" />
                    Отправить
                  </motion.button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Иконка по типу вопроса. */
function typeIcon(type: QuestionType): 'helpCircle' | 'check' {
  switch (type) {
    case 'yesno': return 'check'
    case 'choice': return 'helpCircle'
    case 'text':
    default: return 'helpCircle'
  }
}

/** Лейбл по типу вопроса. */
function typeLabel(type: QuestionType): string {
  switch (type) {
    case 'yesno': return 'Да/Нет'
    case 'choice': return 'Выбор'
    case 'text':
    default: return 'Уточнение'
  }
}
