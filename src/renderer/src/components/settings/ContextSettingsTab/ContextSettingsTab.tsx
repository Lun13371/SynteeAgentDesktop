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
  const [agentS, setAgentS] = useState<{ readFileCache: boolean; toolSummarization: boolean; autoMemoryInterval: number }>({
    readFileCache: true, toolSummarization: true, autoMemoryInterval: 5,
  })

  useEffect(() => {
    window.syntee.agent.getSettings().then((r: Record<string, unknown>) => {
      setAgentS(prev => ({
        readFileCache: r.readFileCache !== false,
        toolSummarization: r.toolSummarization !== false,
        autoMemoryInterval: (r.autoMemoryInterval as number) ?? 5,
        ...prev,
      }))
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

      {/* ── Структурированная память ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Структурированная рабочая память</h3>
            <p className="ctx-section__desc">
              Агент ведёт структурированный журнал: текущая задача, изменённые файлы, diff правок, карта файлов, архитектурные решения.
              Вместо хаотичных append-строк — всегда актуальная картина проекта.
            </p>
          </div>
          <Toggle value={s.structuredMemoryEnabled} onChange={v => upd({ structuredMemoryEnabled: v })} />
        </div>

        <div className={`ctx-fields${!s.structuredMemoryEnabled ? ' ctx-field--disabled' : ''}`}>
          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Diff журнал правок</label>
              <p className="ctx-section__desc">Сохранять изменённые строки при edit_file/write_file — AI знает что именно менял</p>
            </div>
            <Toggle value={s.diffJournalEnabled} onChange={v => upd({ diffJournalEnabled: v })} />
          </div>

          <div className={`ctx-field${!s.diffJournalEnabled ? ' ctx-field--disabled' : ''}`} style={{ marginTop: 8 }}>
            <label>Строк diff на правку</label>
            <div className="ctx-slider-row">
              <input type="range" min={2} max={20} step={1}
                value={s.diffJournalLines}
                disabled={!s.diffJournalEnabled}
                onChange={e => upd({ diffJournalLines: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.diffJournalLines}</span>
            </div>
            <span className="ctx-hint">Сколько строк изменений сохранять на каждый файл. По умолчанию: 5</span>
          </div>

          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>File Map</label>
              <p className="ctx-section__desc">Карта файлов: сколько раз читал/писал каждый файл — AI не читает одно повторно</p>
            </div>
            <Toggle value={s.fileMapEnabled} onChange={v => upd({ fileMapEnabled: v })} />
          </div>
        </div>
      </section>

      {/* ── Project Index ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Project Index</h3>
            <p className="ctx-section__desc">
              Автоматически читать AGENTS.md / CLAUDE.md / README.md и package.json из рабочей директории и добавлять в контекст.
              AI сразу знает стек, структуру и правила проекта без лишних вопросов.
            </p>
          </div>
          <Toggle value={s.projectIndexEnabled} onChange={v => upd({ projectIndexEnabled: v })} />
        </div>
      </section>

      {/* ── История тулов ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>История агентных сессий</h3>
            <p className="ctx-section__desc">
              Сжатая история прошлых агентных запросов добавляется в начало каждого запроса — AI помнит что делал раньше.
            </p>
          </div>
        </div>
        <div className="ctx-fields">
          <div className="ctx-field">
            <label>Количество прошлых сессий</label>
            <div className="ctx-slider-row">
              <input type="range" min={0} max={5} step={1}
                value={s.toolHistorySessions}
                onChange={e => upd({ toolHistorySessions: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.toolHistorySessions === 0 ? 'выкл' : s.toolHistorySessions}</span>
            </div>
            <span className="ctx-hint">0 = отключено. По умолчанию: 3</span>
          </div>

          <div className="ctx-field" style={{ marginTop: 8 }}>
            <label>Символов на результат тула</label>
            <div className="ctx-slider-row">
              <input type="range" min={100} max={1200} step={100}
                value={s.toolHistoryChars}
                onChange={e => upd({ toolHistoryChars: +e.target.value })}
              />
              <span className="ctx-slider-val">{s.toolHistoryChars}</span>
            </div>
            <span className="ctx-hint">Сколько символов результата сохранять на каждый вызов тула. По умолчанию: 600</span>
          </div>
        </div>
      </section>

      {/* ── Оптимизация агента ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <div>
            <h3>Оптимизация агента</h3>
            <p className="ctx-section__desc">
              Настройки экономии токенов и улучшения контекста при длинных агентских сессиях.
            </p>
          </div>
        </div>

        <div className="ctx-fields">
          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Кэш прочитанных файлов</label>
              <p className="ctx-section__desc">Не читать один файл повторно в рамках одного запроса — экономит токены</p>
            </div>
            <AgentToggle settingKey="readFileCache" defaultValue={true} />
          </div>

          <div className="ctx-section__head" style={{ marginTop: 12 }}>
            <div>
              <label style={{ fontWeight: 600, fontSize: 13 }}>Сжатие истории тулов</label>
              <p className="ctx-section__desc">Автоматически сжимать старые вызовы инструментов в краткое резюме при длинных сессиях</p>
            </div>
            <AgentToggle settingKey="toolSummarization" defaultValue={true} />
          </div>

          <div className="ctx-field" style={{ marginTop: 12 }}>
            <label>Авто-память каждые N шагов</label>
            <div className="ctx-slider-row">
              <select className="ctx-select" value={agentS.autoMemoryInterval ?? 5}
                onChange={e => setAgentSetting('autoMemoryInterval', Number(e.target.value))}>
                <option value={0}>Отключено</option>
                <option value={3}>Каждые 3 шага</option>
                <option value={5}>Каждые 5 шагов</option>
                <option value={10}>Каждые 10 шагов</option>
                <option value={15}>Каждые 15 шагов</option>
              </select>
            </div>
            <span className="ctx-hint">Автоматически сохранять прогресс в рабочую память. По умолчанию: каждые 5</span>
          </div>
        </div>
      </section>

    </div>
  )
}
