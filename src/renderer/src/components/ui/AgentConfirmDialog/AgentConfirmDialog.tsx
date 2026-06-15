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
}

const TOOL_LABELS: Record<string, { label: string; icon: string; danger: boolean }> = {
  run_command:    { label: 'Выполнить команду',   icon: 'terminal', danger: true },
  write_file:     { label: 'Записать файл',        icon: 'fileText', danger: false },
  edit_file:      { label: 'Редактировать файл',   icon: 'filePen',  danger: false },
  multi_edit_file:{ label: 'Мульти-редактирование',icon: 'filePen',  danger: false },
  read_file:      { label: 'Прочитать файл',       icon: 'fileText', danger: false },
  list_directory: { label: 'Просмотр папки',       icon: 'folder',   danger: false },
  search_web:     { label: 'Поиск в интернете',    icon: 'globe',    danger: false },
  get_clipboard:  { label: 'Читать буфер обмена',  icon: 'clipboard',danger: false },
  set_clipboard:  { label: 'Записать в буфер',     icon: 'clipboard',danger: true },
  get_system_info:{ label: 'Инфо о системе',       icon: 'info',     danger: false },
  generate_image: { label: 'Генерация изображения',icon: 'image',    danger: true },
}

const DANGEROUS_CMD_PATTERNS = [
  'rm ', 'rmdir', 'del ', 'rd ', 'format', 'shutdown',
  'taskkill', 'kill ', 'reg delete', 'reg add', 'netsh',
  'bcdedit', 'diskpart', 'dd if=', 'shred', 'wipefs', 'mkfs',
]

function isDangerousCommand(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName !== 'run_command') return TOOL_LABELS[toolName]?.danger ?? false
  const cmd = String(args.command ?? '').toLowerCase()
  return DANGEROUS_CMD_PATTERNS.some(p => cmd.includes(p))
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
  const meta = current ? (TOOL_LABELS[current.toolName] || { label: current.toolName, icon: 'zap', danger: false }) : null
  const isDanger = current ? isDangerousCommand(current.toolName, current.args) : false

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
            <div className={`agent-confirm-icon ${isDanger ? 'agent-confirm-icon--danger' : 'agent-confirm-icon--safe'}`}>
              <AppIcon name={meta.icon as 'zap'} size="md" />
            </div>

            <div className="agent-confirm-body">
              <div className="agent-confirm-title">
                {isDanger ? '⚠ Опасное действие' : 'Агент хочет выполнить действие'}
              </div>
              <div className="agent-confirm-tool">{meta.label}</div>

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
