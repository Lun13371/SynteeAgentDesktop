import { useSettingsStore } from '../../../store/settings.store'
import { DEFAULT_CONTEXT_SETTINGS, type ContextSettings } from '../../../../../core/context/contextManager'
import './ContextSettingsTab.css'

export default function ContextSettingsTab() {
  const { get, set } = useSettingsStore()
  const saved = get<Partial<ContextSettings>>('contextSettings', {})
  const s: ContextSettings = { ...DEFAULT_CONTEXT_SETTINGS, ...saved }

  const upd = (patch: Partial<ContextSettings>) => {
    set('contextSettings', { ...s, ...patch })
  }

  return (
    <div className="ctx-tab">

      {/* ── Tool truncation ── */}
      <section className="ctx-section">
        <div className="ctx-section__head">
          <h3>Обрезка результатов тулов</h3>
          <label className="ctx-toggle">
            <input type="checkbox" checked={s.toolTruncEnabled} onChange={e => upd({ toolTruncEnabled: e.target.checked })} />
            <span className="ctx-toggle__track" />
          </label>
        </div>
        <p className="ctx-section__desc">
          Большие ответы тулов (read_file, run_command, search_code и др.) обрезаются до указанного лимита.
          Показывается начало и конец, середина сжимается.
        </p>
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
          <h3>Сжатие истории (Rolling Window)</h3>
          <label className="ctx-toggle">
            <input type="checkbox" checked={s.rollingEnabled} onChange={e => upd({ rollingEnabled: e.target.checked })} />
            <span className="ctx-toggle__track" />
          </label>
        </div>
        <p className="ctx-section__desc">
          Когда история чата заполняет контекст выше порога — старые сообщения сжимаются в краткое резюме.
          Первые и последние сообщения всегда сохраняются полностью.
        </p>
        <div className={`ctx-fields${!s.rollingEnabled ? ' ctx-field--disabled' : ''}`}>
          <div className="ctx-field">
            <label>Лимит токенов модели</label>
            <div className="ctx-slider-row">
              <input type="range" min={8000} max={200000} step={4000}
                value={s.contextLimitTokens}
                disabled={!s.rollingEnabled}
                onChange={e => upd({ contextLimitTokens: +e.target.value })}
              />
              <span className="ctx-slider-val">{(s.contextLimitTokens / 1000).toFixed(0)}K</span>
            </div>
            <span className="ctx-hint">Установи по лимиту твоей модели. GPT-4o: 128K, Claude: 200K, Gemini: 1M</span>
          </div>
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
            <span className="ctx-hint">При заполнении контекста на этот % — запустится сжатие. По умолчанию: 75%</span>
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
          <h3>Счётчик токенов</h3>
          <label className="ctx-toggle">
            <input type="checkbox" checked={s.tokenCounterEnabled} onChange={e => upd({ tokenCounterEnabled: e.target.checked })} />
            <span className="ctx-toggle__track" />
          </label>
        </div>
        <p className="ctx-section__desc">
          Показывает полоску над полем ввода когда контекст заполнен более чем на 60%.
          Жёлтый — предупреждение (60–85%), красный — критично ({'>'}85%).
          ⚡ означает что история была автоматически сжата.
        </p>
      </section>

    </div>
  )
}
