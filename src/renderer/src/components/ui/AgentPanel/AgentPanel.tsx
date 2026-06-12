import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import './AgentPanel.css'

interface AgentStep {
  type: 'thought' | 'tool_call' | 'tool_result' | 'answer'
  toolName?: string
  toolArgs?: Record<string, unknown>
  content: string
  success?: boolean
}

interface AgentPanelProps {
  onClose: () => void
}

export default function AgentPanel({ onClose }: AgentPanelProps) {
  const [steps, setSteps] = useState<AgentStep[]>([])
  const [running, setRunning] = useState(false)
  const [query, setQuery] = useState('')
  const [answer, setAnswer] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const offStep = window.syntee.on('agent:step', (step: AgentStep) => {
      setSteps(prev => [...prev, step])
      setRunning(true)
    })
    const offDone = window.syntee.on('agent:done', (data: { answer: string }) => {
      setAnswer(data.answer)
      setRunning(false)
    })
    const offErr = window.syntee.on('agent:error', (data: { error: string }) => {
      setSteps(prev => [...prev, { type: 'tool_result', content: 'Ошибка: ' + data.error, success: false }])
      setRunning(false)
    })
    return () => { offStep(); offDone(); offErr() }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [steps])

  const handleRun = async () => {
    if (!query.trim() || running) return
    setSteps([])
    setAnswer('')
    setRunning(true)
    await (window.syntee as any).agent?.run(query)
  }

  const ICONS: Record<string, string> = {
    run_command: '⚡',
    read_file: '📄',
    write_file: '✏️',
    list_directory: '📁',
    get_clipboard: '📋',
    set_clipboard: '📋',
    search_web: '🌐',
    get_system_info: '💻',
  }

  return (
    <motion.div
      className="agent-panel glass"
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
    >
      {/* Заголовок */}
      <div className="agent-panel-header">
        <div className="agent-panel-title">
          <span className="agent-panel-icon">🤖</span>
          Агент
          {running && <span className="agent-running-dot" />}
        </div>
        <button className="agent-close-btn" onClick={onClose}>✕</button>
      </div>

      {/* Шаги */}
      <div className="agent-steps">
        <AnimatePresence initial={false}>
          {steps.map((step, i) => (
            <motion.div
              key={i}
              className={`agent-step agent-step--${step.type}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              {step.type === 'tool_call' && (
                <div className="agent-step-tool">
                  <span className="agent-tool-icon">{ICONS[step.toolName || ''] || '🔧'}</span>
                  <span className="agent-tool-name">{step.toolName}</span>
                  {step.toolArgs && Object.keys(step.toolArgs).length > 0 && (
                    <code className="agent-tool-args">
                      {Object.entries(step.toolArgs).map(([k, v]) =>
                        `${k}: ${String(v).slice(0, 60)}`
                      ).join(', ')}
                    </code>
                  )}
                </div>
              )}
              {step.type === 'tool_result' && (
                <div className={`agent-step-result ${step.success === false ? 'agent-step-result--error' : ''}`}>
                  <span className="agent-result-icon">{step.success === false ? '❌' : '✅'}</span>
                  <pre className="agent-result-text">{step.content.slice(0, 300)}{step.content.length > 300 ? '...' : ''}</pre>
                </div>
              )}
              {step.type === 'answer' && (
                <div className="agent-step-answer">
                  <span>💬</span>
                  <p>{step.content}</p>
                </div>
              )}
            </motion.div>
          ))}
          {running && steps.length === 0 && (
            <motion.div className="agent-thinking" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <span className="agent-dot" /><span className="agent-dot" /><span className="agent-dot" />
              Думаю...
            </motion.div>
          )}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>

      {/* Ответ */}
      <AnimatePresence>
        {answer && (
          <motion.div
            className="agent-answer-box"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
          >
            <p>{answer}</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Ввод */}
      <div className="agent-input-row">
        <input
          className="agent-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleRun()}
          placeholder="Задача для агента..."
          disabled={running}
        />
        <motion.button
          className="agent-run-btn"
          onClick={handleRun}
          disabled={running || !query.trim()}
          whileTap={{ scale: 0.93 }}
        >
          {running ? '⏳' : '▶'}
        </motion.button>
      </div>
    </motion.div>
  )
}
