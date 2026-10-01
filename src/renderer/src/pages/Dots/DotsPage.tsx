// ── DotsPage: always-on фоновые агенты (аналог OpenAI Dots) ──────────────
// Слева — список Dot'ов (карточки с живыми каплями, стиль сайдбара), справа —
// чат выбранного Dot'а (наследует MessageBubble + ChatInput).
// Визард — простая условная отрисовка (без AnimatePresence: fixed-оверлей
// + exit-анимации страницы конфликтуют, оставляем mount-анимацию).
import { useEffect, useMemo, useState } from 'react'
import AppIcon from '../../components/ui/AppIcon/AppIcon'
import ModelSelector from '../../components/ui/ModelSelector/ModelSelector'
import { useToast } from '../../components/ui/Toast/Toast'
import { useDotsStore } from '../../store/dots.store'
import type { Dot } from '../../../../shared/types'
import { DotBlob } from './DotBlob'
import { DotCard } from './DotCard'
import { DotChat } from './DotChat'
import { DotWizard } from './DotWizard'
import './DotsPage.css'

export default function DotsPage() {
  const { add: toast } = useToast()
  const dots = useDotsStore(s => s.dots)
  const loaded = useDotsStore(s => s.loaded)
  const selectedDotId = useDotsStore(s => s.selectedDotId)
  const runsByDot = useDotsStore(s => s.runsByDot)
  const settings = useDotsStore(s => s.settings)
  const wizard = useDotsStore(s => s.wizard)
  const { selectDot, loadRuns, setSettings, setWizard } = useDotsStore.getState()

  const [showSettings, setShowSettings] = useState(false)

  // Первичная загрузка (push-события DOTS_* слушает App.tsx глобально —
  // бейдж в TitleBar живёт и при закрытой странице; здесь только рефреш
  // данных и настроек при открытии страницы).
  useEffect(() => {
    window.syntee.dots.list().then(d => {
      useDotsStore.setState({ dots: d, loaded: true })
    }).catch(() => {
      useDotsStore.setState({ loaded: true })
    })
    window.syntee.dots.getSettings().then(s => {
      useDotsStore.setState({ settings: s })
    }).catch(() => {})
  }, [])

  // История ранов выбранного Dot'а
  useEffect(() => {
    if (selectedDotId) void loadRuns(selectedDotId)
  }, [selectedDotId, loadRuns, dots])

  const selectedDot: Dot | null = useMemo(
    () => dots.find(d => d.id === selectedDotId) ?? null,
    [dots, selectedDotId],
  )
  const wizardDot: Dot | null = useMemo(
    () => wizard.dotId ? dots.find(d => d.id === wizard.dotId) ?? null : null,
    [dots, wizard.dotId],
  )

  const handleWake = (dotId: string) => {
    window.syntee.dots.runNow(dotId).then(() => {
      toast('Dot разбужен — смотри чат', 'info')
    }).catch(() => {})
  }

  const handleDelete = (dot: Dot) => {
    window.syntee.dots.delete(dot.id).then(() => {
      if (selectedDotId === dot.id) selectDot(null)
      toast(`Dot «${dot.name}» удалён`, 'info')
    }).catch(() => {})
  }

  const runningCount = dots.filter(d => d.state.status === 'running').length

  return (
    <div className="dots-page">
      {/* Шапка */}
      <div className="dots-header">
        <div className="dots-header-icon">
          <AppIcon name="orbit" size="md" />
        </div>
        <div>
          <div className="dots-header-title">Dots</div>
          <div className="dots-header-sub">
            {dots.length === 0 ? 'всегда-живущие агенты' : `${dots.length} Dot’ов${runningCount > 0 ? ` · ${runningCount} работает` : ''}`}
          </div>
        </div>
        <div className="dots-header-spacer" />
        <button
          type="button"
          className={`dots-header-btn${showSettings ? ' dots-header-btn--active' : ''}`}
          onClick={() => setShowSettings(v => !v)}
        >
          <AppIcon name="settings" size="xs" /> Настройки
        </button>
        <button
          type="button"
          className="dots-header-btn dots-header-btn--primary"
          onClick={() => setWizard(true)}
        >
          <AppIcon name="plus" size="xs" /> Создать
        </button>
      </div>

      {/* Настройки Dots (поповер) */}
      {showSettings && settings && (
        <div className="dots-settings">
          <div className="dots-settings-row">
            <div>
              <div className="dots-settings-label">Dots включены</div>
              <div className="dots-settings-hint">Главный тумблер: пауза для всех триггеров</div>
            </div>
            <button
              type="button"
              className={`dots-toggle${settings.enabled ? ' dots-toggle--on' : ''}`}
              onClick={() => void setSettings({ enabled: !settings.enabled })}
            />
          </div>
          <div className="dots-settings-row">
            <div>
              <div className="dots-settings-label">Уведомления</div>
              <div className="dots-settings-hint">Трей/overlay, когда Dot просыпается с отчётом</div>
            </div>
            <button
              type="button"
              className={`dots-toggle${settings.notify ? ' dots-toggle--on' : ''}`}
              onClick={() => void setSettings({ notify: !settings.notify })}
            />
          </div>
          <div>
            <div className="dots-settings-label" style={{ marginBottom: 6 }}>Модель по умолчанию</div>
            <ModelSelector
              modelId={settings.modelId ?? ''}
              providerId={settings.modelProvider ?? undefined}
              onChange={(modelId, providerId) => void setSettings({ modelId, modelProvider: providerId })}
            />
            <div className="dots-settings-hint" style={{ marginTop: 6 }}>
              Применяется к НОВЫМ Dot’ам без своей модели. Пусто = назначение main.
            </div>
          </div>
        </div>
      )}

      {/* Тело: список + чат */}
      <div className="dots-body">
        <div className="dots-list">
          {loaded && dots.length === 0 && (
            <div className="dots-list-empty">
              <DotBlob color="#7c6cff" icon="bot" status="sleeping" size={56} />
              <div className="dots-list-empty-title">Пока пусто</div>
              <div className="dots-list-empty-text">
                Создай Dot’а: задай задачу — он будет просыпаться, проверять и сообщать.
              </div>
            </div>
          )}
          {dots.map(dot => (
            <DotCard
              key={dot.id}
              dot={dot}
              selected={dot.id === selectedDotId}
              onSelect={() => selectDot(dot.id)}
              onWake={() => handleWake(dot.id)}
              onEdit={() => setWizard(true, dot.id)}
              onDelete={() => handleDelete(dot)}
            />
          ))}
        </div>

        {selectedDot ? (
          <DotChat
            dot={selectedDot}
            runs={runsByDot[selectedDot.id] ?? []}
            onWake={() => handleWake(selectedDot.id)}
          />
        ) : (
          <div className="dots-empty">
            <div className="dots-empty-blob">
              <DotBlob color="#7c6cff" icon="orbit" status="sleeping" size={96} />
            </div>
            <div className="dots-empty-title">Твои Dot’ы ждут задач</div>
            <div className="dots-empty-text">
              Dot — это агент, который живёт в фоне: просыпается по расписанию,
              следит за тем, что важно тебе, и сам пишет, когда есть новости.
              Если новостей нет — молчит.
            </div>
            <button
              type="button"
              className="dots-header-btn dots-header-btn--primary"
              onClick={() => setWizard(true)}
            >
              <AppIcon name="plus" size="xs" /> Создать первого Dot’а
            </button>
          </div>
        )}
      </div>

      {/* Визард — простая условная отрисовка (см. комментарий в шапке файла) */}
      {wizard.open && (
        <DotWizard dot={wizardDot} onClose={() => setWizard(false)} />
      )}
    </div>
  )
}
