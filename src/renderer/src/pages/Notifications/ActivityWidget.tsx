import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useActivityStore } from '../../store/activity.store'
import Logo from '../../components/ui/Logo/Logo'
import './ActivityWidget.css'

/**
 * ActivityWidget — компактный информер активности ИИ в overlay-окне уведомлений.
 *
 * ВСЕГДА компактный (нет разворота). Показывает:
 *  - Логотип Syntee + текущую фазу ("Думает...", "read_file")
 *  - Счётчик тулов
 *  - Мини-строка с последними 3 тулами (✓/✗/spinner)
 *
 * CSS backdrop-filter для glass-эффекта (без desktopCapturer — без DXGI лагов).
 * Подписывается на activity:* события от ActivityManager (main процесс).
 */

/** Текстовое описание фазы для компактного вида */
function phaseLabel(phase: string, currentTool: string | null): string {
  switch (phase) {
    case 'thinking': return 'Думает...'
    case 'tool': return currentTool || 'Тул...'
    default: return 'Готово'
  }
}

const STATUS_DOT: Record<string, string> = {
  running: '○',
  done: '✓',
  error: '✗',
}

export default function ActivityWidget() {
  const {
    status, phase, currentTool, stepsLog,
    visible, setRunning, setDone, setError,
    setPhase, setCurrentTool, setToolProgress, addStep, updateStep,
    setVisible, showWidget,
  } = useActivityStore()

  // Ref для setTimeout в onToolProgress — очищается при unmount
  const progressTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ── Подписка на события из main ──────────────────────────────────
  useEffect(() => {
    const offRun = (window.syntee as any).activity.onRunStatus((data: {
      chatId: string; status: string; msgId?: string; error?: string
    }) => {
      if (data.status === 'running') setRunning()
      else if (data.status === 'done') setDone()
      else if (data.status === 'error') setError()
      else if (data.status === 'cancelled') setDone()
    })

    const offStep = (window.syntee as any).activity.onStep((step: {
      type: string; toolName?: string; toolArgs?: Record<string, unknown>
      content?: string; success?: boolean; callId?: string
      pendingCallId?: string; chatId?: string
    }) => {
      if (step.type === 'tool_call' || step.type === 'tool_call_pending') {
        setPhase('tool')
        setCurrentTool(step.toolName || null)
        if (step.toolName) {
          const stepId = step.callId || step.pendingCallId || `${Date.now()}-${Math.random()}`
          addStep({
            id: stepId,
            toolName: step.toolName,
            status: 'running',
            args: step.toolArgs,
            ts: Date.now(),
          })
        }
      } else if (step.type === 'tool_result') {
        if (step.callId) {
          updateStep(step.callId, {
            status: step.success === false ? 'error' : 'done',
            result: step.content,
          })
        }
        setPhase('thinking')
        setCurrentTool(null)
      } else if (step.type === 'thinking') {
        setPhase('thinking')
      }
    })

    const offProgress = (window.syntee as any).activity.onToolProgress((data: {
      toolName: string; stage: string; detail?: string
      filesProcessed?: number; filesTotal?: number
    }) => {
      setToolProgress({
        toolName: data.toolName,
        stage: data.stage,
        detail: data.detail,
        filesProcessed: data.filesProcessed,
        filesTotal: data.filesTotal,
      })
      if (data.stage === 'done') {
        if (progressTimerRef.current) clearTimeout(progressTimerRef.current)
        progressTimerRef.current = setTimeout(() => setToolProgress(null), 1000)
      }
    })

    const offHide = (window.syntee as any).activity.onHide(() => {
      // Только setVisible(false) — НЕ вызываем reset().
      // reset() сбрасывает status в 'idle' → showWidget() проверяет
      // status === 'running' → false → виджет не появится при следующем
      // сворачивании. status должен оставаться 'running' пока агент работает.
      setVisible(false)
    })

    const offShow = (window.syntee as any).activity.onShow(() => {
      showWidget()
    })

    return () => {
      offRun(); offStep(); offProgress(); offHide(); offShow()
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current)
    }
  }, [setRunning, setDone, setError, setPhase, setCurrentTool, setToolProgress, addStep, updateStep, setVisible, showWidget])

  const shouldRender = visible && status !== 'idle'
  const isRunning = status === 'running'
  // Последние 3 тула для мини-строки
  const recentTools = stepsLog.slice(-3)

  return (
    <AnimatePresence>
      {shouldRender && (
        <motion.div
          className="activity-widget"
          initial={{ opacity: 0, scale: 0.3, y: -40 }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: {
              type: 'spring',
              stiffness: 200,
              damping: 18,
              mass: 0.8,
              opacity: { duration: 0.2, ease: 'easeOut' },
            },
          }}
          exit={{
            opacity: 0,
            scale: 0.3,
            y: -30,
            transition: {
              duration: 0.25,
              ease: [0.4, 0, 0.2, 1],
            },
          }}
          onMouseEnter={() => (window.syntee as any).notification.setIgnoreMouseEvents(false)}
          onMouseLeave={() => (window.syntee as any).notification.setIgnoreMouseEvents(true)}
          style={{ transformOrigin: '50% 0%' }}
        >
          {/* Главная строка */}
          <div className="activity-widget__bar">
            <div className="activity-widget__logo-wrap">
              <Logo size={22} />
            </div>
            <span className="activity-widget__label">
              {phaseLabel(phase, currentTool)}
            </span>
            {isRunning && stepsLog.length > 0 && (
              <span className="activity-widget__counter">
                {stepsLog.length}
              </span>
            )}
          </div>

          {/* Мини-строка с последними тулами */}
          {isRunning && recentTools.length > 0 && (
            <div className="activity-widget__tools">
              {recentTools.map((step) => (
                <span
                  key={step.id}
                  className={`activity-widget__tool-chip activity-widget__tool-chip--${step.status}`}
                >
                  <span className="activity-widget__tool-dot">
                    {step.status === 'running' ? (
                      <motion.span
                        className="activity-widget__tool-spinner"
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                      />
                    ) : (
                      STATUS_DOT[step.status] || '○'
                    )}
                  </span>
                  {step.toolName}
                </span>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
