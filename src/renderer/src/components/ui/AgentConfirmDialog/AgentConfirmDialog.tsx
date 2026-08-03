import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import { playConfirmSound } from '../../../utils/sounds'
import './AgentConfirmDialog.css'

interface ConfirmRequest {
  reqId: string
  toolName: string
  args: Record<string, unknown>
  dangerLevel?: string  // safe | warn | dangerous | blocked — из commandSafety (§1.4)
  dangerReason?: string
  previewDiff?: string  // diff-превью для файловых тулов (§4.1)
}

// Метаданные тулов только для иконки/лейбла. Опасность больше не дублируем —
// её считает commandSafety и присылает main-процесс (единый источник правды).
const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  run_command:    { label: 'Выполнить команду',   icon: 'terminal' },
  write_file:     { label: 'Записать файл',        icon: 'fileText' },
  edit_file:      { label: 'Редактировать файл',   icon: 'filePen'  },
  read_file:      { label: 'Прочитать файл',       icon: 'fileText' },
  list_directory: { label: 'Просмотр папки',       icon: 'folder'   },
  search_web:     { label: 'Поиск в интернете',    icon: 'globe'    },
  http_request:   { label: 'HTTP-запрос',          icon: 'globe'    },
  get_system_info:{ label: 'Инфо о системе',       icon: 'info'     },
  generate_image: { label: 'Генерация изображения',icon: 'image'    },
}

export default function AgentConfirmDialog() {
  const [queue, setQueue] = useState<ConfirmRequest[]>([])

  useEffect(() => {
    const handler = (data: ConfirmRequest) => {
      setQueue(q => [...q, data])
      playConfirmSound()
    }
    const wrapper = window.syntee.agent.onConfirm(handler)
    return () => {
      if (wrapper) window.syntee.agent.offConfirm?.(wrapper as never)
    }
  }, [])

  const respond = (reqId: string, approved: boolean) => {
    window.syntee.agent.confirmResponse(reqId, approved)
    setQueue(q => q.filter(r => r.reqId !== reqId))
  }

  const current = queue[0]
  const meta = current ? (TOOL_LABELS[current.toolName] || { label: current.toolName, icon: 'zap' }) : null
  // Опасность из единого источника (commandSafety), не локальная эвристика
  const level = current?.dangerLevel ?? 'safe'
  const isDanger = level === 'dangerous' || level === 'blocked'
  const isWarn = level === 'warn'

  return createPortal(
    <AnimatePresence>
      {current && meta && (
        <motion.div
          className="agent-confirm-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="agent-confirm-dialog"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
          >
            <div className={`agent-confirm-icon ${isDanger ? 'agent-confirm-icon--danger' : isWarn ? 'agent-confirm-icon--warn' : 'agent-confirm-icon--safe'}`}>
              <AppIcon name={meta.icon as 'zap'} size="md" />
            </div>

            <div className="agent-confirm-body">
              <div className="agent-confirm-title">
                {isDanger ? '⚠ Опасное действие' : isWarn ? 'Требует подтверждения' : 'Агент хочет выполнить действие'}
              </div>
              <div className="agent-confirm-tool">{meta.label}</div>
              {current.dangerReason && (
                <div className="agent-confirm-reason">{current.dangerReason}</div>
              )}

              {/* Аргументы */}
              <div className="agent-confirm-args">
                {Object.entries(current.args).map(([k, v]) => (
                  <div key={k} className="agent-confirm-arg">
                    <span className="agent-confirm-arg-key">{k}</span>
                    <span className="agent-confirm-arg-val">
                      {typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '…' : String(v)}
                    </span>
                  </div>
                ))}
              </div>

              {/* Diff-превью для файловых тулов (§4.1) */}
              {current.previewDiff && (
                <pre className="agent-confirm-diff">{current.previewDiff.slice(0, 2000)}</pre>
              )}

              {queue.length > 1 && (
                <div className="agent-confirm-queue">Ещё {queue.length - 1} действий в очереди</div>
              )}
            </div>

            <div className="agent-confirm-actions">
              <motion.button
                className="agent-confirm-btn agent-confirm-btn--deny"
                onClick={() => respond(current.reqId, false)}
                whileTap={{ scale: 0.95 }}
              >
                <AppIcon name="x" size="sm" />
                Отклонить
              </motion.button>
              <motion.button
                className="agent-confirm-btn agent-confirm-btn--allow"
                onClick={() => respond(current.reqId, true)}
                whileTap={{ scale: 0.95 }}
              >
                <AppIcon name="check" size="sm" />
                Разрешить
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
