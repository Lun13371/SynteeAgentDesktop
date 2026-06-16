import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useSettingsStore } from '../../../store/settings.store'
import { DEFAULT_CONTEXT_SETTINGS, type ContextSettings } from '../../../../../core/context/contextManager'
import './ContextSettingsTab.css'

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <motion.button
      className={`settings-toggle ${value ? 'settings-toggle--on' : ''}`}
      onClick={() => onChange(!value)}
      whileTap={{ scale: 0.93 }}
    >
      <motion.span
        className="settings-toggle-thumb"
        animate={{ x: value ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </motion.button>
  )
}

export default function ContextSettingsTab() {
  const { get, set } = useSettingsStore()
  const saved = get<Partial<ContextSettings>>('contextSettings', {})
  const s: ContextSettings = { ...DEFAULT_CONTEXT_SETTINGS, ...saved }

  const upd = (patch: Partial<ContextSettings>) => {
    set('contextSettings', { ...s, ...patch })
  }

  // Агентные настройки — через agent.getSettings/setSettings
  const [agentS, setAgentS] = useState<{
    readFileCache: boolean
    toolSummarization: boolean
    contextCompactionPct: number
    preserveRecentToolRounds: number
  }>({
    readFileCache: true,
    toolSummarization: true,
    contextCompactionPct: 75,
    preserveRecentToolRounds: 8,
  })

  useEffect(() => {
    window.syntee.agent.getSettings().then((r: Record<string, unknown>) => {
      setAgentS({
        readFileCache: r.readFileCache !== false,
        toolSummarization: r.toolSummarization !== false,
        contextCompactionPct: typeof r.contextCompactionPct === 'number' ? r.contextCompactionPct : 75,
        preserveRecentToolRounds: typeof r.preserveRecentToolRounds === 'number' ? r.preserveRecentToolRounds : 8,
      })
    }).catch(() => {})
  }, [])

  const setAgentSetting = (key: string, value: unknown) => {
    setAgentS(prev => ({ ...prev, [key]: value }))
    window.syntee.agent.setSettings({ [key]: value }).catch(() => {})
  }

  const AgentToggle = ({ settingKey, defaultValue }: { settingKey: keyof typeof agentS; defaultValue: boolean }) => (
    <Toggle
      value={agentS[settingKey] as boolean ?? defaultValue}
      onChange={v => setAgentSetting(settingKey, v)}
    />
  )

  return (
    <div className="ctx-tab">

      {/* ── Tool truncation ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Обрезка результатов тулов</h3>
            <p className="ctx-section__desc">
              Большие ответы тулов (read_file, run_command, search_code и др.) обрезаются до указанного лимита.
              Показывается начало и конец, середина сжимается.
            </p>
          </div>
          <Toggle value={s.toolTruncEnabled} onChange={v => upd({ toolTruncEnabled: v })} />
        </div>
        <div className={`ctx-field${!s.toolTruncEnabled ? ' ctx-field--disabled' : ''}`}>
          <label>Макс. символов на тул-результат</label>
          <div className="ctx-slider-row">
            <input type="range" min={500} max={16000} step={500}
              value={s.toolMaxChars}
              disabled={!s.toolTruncEnabled}
              onChange={e => upd({ toolMaxChars: +e.target.value })}
            />
            <span className="ctx-slider-val">{s.toolMaxChars.toLocaleString()}</span>
          </div>
          <span className="ctx-hint">Рекомендуется 3000–6000. По умолчанию: 4000</span>
        </div>
      </section>

      {/* ── Rolling window ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Сжатие истории (Rolling Window)</h3>
            <p className="ctx-section__desc">
              Когда история чата заполняет контекст выше порога — старые сообщения сжимаются в резюме.
              Первые и последние сообщения всегда сохраняются полностью.
              Лимит токенов берётся автоматически от активной модели провайдера.
            </p>
          </div>
          <Toggle value={s.rollingEnabled} onChange={v => upd({ rollingEnabled: v })} />
        </div>
        <div className={`ctx-fields${!s.rollingEnabled ? ' ctx-field--disabled' : ''}`}>
          <div className="ctx-field">
            <label>Триггер сжатия (%)</label>
            <div className="ctx-slider-row">
              <input type="range" min={50} max={95} step={5}
                value={s.rollingTriggerPct}
                disabled={!s.rollingEnabled}
                onChange={e => upd({ rollingTriggerPct: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.rollingTriggerPct}%</span>
            </div>
            <span className="ctx-hint">При заполнении на этот % — запустится сжатие. По умолчанию: 75%</span>
          </div>
          <div className="ctx-row2">
            <div className="ctx-field">
              <label>Сохранять первых сообщений</label>
              <div className="ctx-slider-row">
                <input type="range" min={1} max={6} step={1}
                  value={s.rollingKeepFirst}
                  disabled={!s.rollingEnabled}
                  onChange={e => upd({ rollingKeepFirst: +e.target.value })}
                />
                <span className="ctx-slider-val">{s.rollingKeepFirst}</span>
              </div>
            </div>
            <div className="ctx-field">
              <label>Сохранять последних сообщений</label>
              <div className="ctx-slider-row">
                <input type="range" min={4} max={30} step={2}
                  value={s.rollingKeepLast}
                  disabled={!s.rollingEnabled}
                  onChange={e => upd({ rollingKeepLast: +e.target.value })}
                />
                <span className="ctx-slider-val">{s.rollingKeepLast}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Token counter ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Счётчик токенов</h3>
            <p className="ctx-section__desc">
              Показывает полоску над полем ввода когда контекст заполнен более чем на 60%.
              Жёлтый — предупреждение (60–85%), красный — критично (&gt;85%).
              ⚡ означает что история была автоматически сжата.
            </p>
          </div>
          <Toggle value={s.tokenCounterEnabled} onChange={v => upd({ tokenCounterEnabled: v })} />
        </div>
      </section>

      {/* ── Рабочая память ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Рабочая память агента</h3>
            <p className="ctx-section__desc">
              Агент автоматически запоминает что делал в этом чате — изменённые файлы, принятые решения, текущее состояние проекта.
              Память сохраняется между сообщениями и включается в system prompt.
              Агент сам обновляет её через инструмент <code>update_working_memory</code> в конце сессии.
            </p>
          </div>
        </div>
        <div className="ctx-field">
          <span className="ctx-hint">💡 Подсказка: напиши агенту «запомни что ты сделал» — он обновит рабочую память вручную.</span>
        </div>
      </section>


      {/* ── Diff журнал + File Map ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Контекст правок</h3>
            <p className="ctx-section__desc">
              Diff журнал и карта файлов — агент помнит что менял и что читал между запросами.
            </p>
          </div>
        </div>
        <div className="ctx-fields">
          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Diff журнал правок</label>
              <p className="ctx-section__desc">Сохранять изменённые строки при edit_file/write_file</p>
            </div>
            <Toggle value={s.diffJournalEnabled} onChange={v => upd({ diffJournalEnabled: v })} />
          </div>
          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>File Map</label>
              <p className="ctx-section__desc">Карта файлов с содержимым — AI знает что уже читал</p>
            </div>
            <Toggle value={s.fileMapEnabled} onChange={v => upd({ fileMapEnabled: v })} />
          </div>
          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Кэш файлов внутри запроса</label>
              <p className="ctx-section__desc">Не читать один файл повторно в рамках одного запроса</p>
            </div>
            <AgentToggle settingKey="readFileCache" defaultValue={true} />
          </div>
          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Суммаризация tool-истории</label>
              <p className="ctx-section__desc">Сжимать старые tool-раунды внутри одного длинного ответа агента</p>
            </div>
            <AgentToggle settingKey="toolSummarization" defaultValue={true} />
          </div>
          <div className="ctx-field" style={{ marginTop: 12 }}>
            <label>Порог сжатия внутреннего контекста (%)</label>
            <div className="ctx-slider-row">
              <input
                type="range"
                min={50}
                max={90}
                step={5}
                value={agentS.contextCompactionPct}
                onChange={e => setAgentSetting('contextCompactionPct', Number(e.target.value))}
              />
              <span className="ctx-slider-val">{agentS.contextCompactionPct}%</span>
            </div>
          </div>
          <div className="ctx-field" style={{ marginTop: 12 }}>
            <label>Хранить полных tool-раундов</label>
            <div className="ctx-slider-row">
              <input
                type="range"
                min={2}
                max={16}
                step={1}
                value={agentS.preserveRecentToolRounds}
                onChange={e => setAgentSetting('preserveRecentToolRounds', Number(e.target.value))}
              />
              <span className="ctx-slider-val">{agentS.preserveRecentToolRounds}</span>
            </div>
          </div>
        </div>
      </section>

    </div>
  )
}
