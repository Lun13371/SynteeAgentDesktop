import { useState, useEffect, useCallback } from 'react'
import Toggle from '../../ui/Toggle/Toggle'
import Select from '../../ui/Select/Select'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { SectionTitle, Group, Field } from '../SettingsPrimitives'
import ProjectMapModal from '../../ui/ProjectMapModal/ProjectMapModal'
import { DEFAULT_PROJECT_MAP_SPEED, type ProjectMapSpeedSettings, type ProjectMapProjectStats, type ProjectMapAutoInfo } from '../../../../../shared/projectMap'
import './ProjectMapSettingsTab.css'

const STATE_LABELS: Record<string, string> = {
  idle: 'ожидает',
  building: 'индексация',
  ready: 'готова',
  error: 'ошибка',
}

export default function ProjectMapSettingsTab() {
  const [enabled, setEnabled] = useState(true)
  const [speed, setSpeed] = useState<ProjectMapSpeedSettings>(DEFAULT_PROJECT_MAP_SPEED)
  const [auto, setAuto] = useState<ProjectMapAutoInfo | null>(null)
  const [stats, setStats] = useState<ProjectMapProjectStats[]>([])
  const [mapProject, setMapProject] = useState<ProjectMapProjectStats | null>(null)

  const loadStats = useCallback(() => {
    window.syntee.projectMap.listStats().then(setStats).catch(() => {})
  }, [])

  useEffect(() => {
    window.syntee.settings.get('projectMapEnabled').then(v => setEnabled(v !== false)).catch(() => {})
    window.syntee.settings.get('projectMapSpeed').then(v => setSpeed(v ?? DEFAULT_PROJECT_MAP_SPEED)).catch(() => {})
    window.syntee.projectMap.getAutoInfo().then(setAuto).catch(() => {})
    loadStats()
  }, [loadStats])

  // Обновляем таблицу по завершении сборки/инкрементала (не на каждый файл).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const unsub = window.syntee.projectMap.onProgress(p => {
      if (p.phase !== 'ready' && p.phase !== 'error') return
      if (t) clearTimeout(t)
      t = setTimeout(loadStats, 400)
    })
    return () => { if (t) clearTimeout(t); unsub() }
  }, [loadStats])

  const saveEnabled = (v: boolean) => {
    setEnabled(v)
    void window.syntee.settings.set('projectMapEnabled', v)
  }
  const saveSpeed = (patch: Partial<ProjectMapSpeedSettings>) => {
    const next = { ...speed, ...patch }
    setSpeed(next)
    void window.syntee.settings.set('projectMapSpeed', next)
  }

  return (
    <div className="pmap-settings">
      <SectionTitle description="Детерминированная карта кода: файлы, символы, вызовы и зависимости. Слежение событийное (fs.watch) — в простое нагрузка нулевая, при изменениях переразбираются только затронутые файлы.">
        Карта проекта
      </SectionTitle>

      <Group id="pmap-index" icon="gauge" title="Фоновая индексация" note="Строит карты всех проектов; открытый чат — в приоритете.">
        <Field id="pmap-enabled" label="Индексировать проекты в фоне" description="Выключи, чтобы карта не строилась и не обновлялась автоматически.">
          <Toggle value={enabled} onChange={saveEnabled} />
        </Field>

        <Field id="pmap-mode" label="Скорость индексации" description="Авто подбирает бюджет от железа (ядра/память) и уступает foreground. Вручную — задаёшь сам.">
          <Select
            value={speed.mode}
            onChange={v => saveSpeed({ mode: v as ProjectMapSpeedSettings['mode'] })}
            options={[
              { value: 'auto', label: 'Авто (от железа)' },
              { value: 'manual', label: 'Вручную' },
            ]}
          />
        </Field>

        {speed.mode === 'manual' ? (
          <Field id="pmap-level" label={`Уровень: ${speed.level}`} description="0 — эко (максимальные паузы, почти не нагружает), 100 — быстро (без пауз)." block>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={speed.level}
              onChange={e => saveSpeed({ level: Number(e.target.value) })}
              className="pmap-settings-range"
            />
          </Field>
        ) : (
          auto && (
            <div className="pmap-settings-auto">
              <AppIcon name="gauge" size="xs" tone="accent" />
              <span>
                Авто: {auto.cores} ядер · {auto.memGB} ГБ ОЗУ → пауза {auto.backgroundDelayMs} мс между файлами.
                Пока идёт генерация в чате, индексация ждёт.
              </span>
            </div>
          )
        )}
      </Group>

      <Group id="pmap-projects" icon="chart" title="Проекты" note="Статистика карт и ручная пересборка.">
        <div className="pmap-settings-table">
          <div className="pmap-settings-row pmap-settings-row--head">
            <span>Проект</span><span>Статус</span><span>Файлы</span><span>Узлы</span><span>Связи</span><span />
          </div>
          {stats.length === 0 && <div className="pmap-settings-empty">Проектов пока нет.</div>}
          {stats.map(s => (
            <div key={s.projectId} className="pmap-settings-row">
              <span className="pmap-settings-name" title={s.workdir}>{s.name}</span>
              <span className={`pmap-settings-state pmap-settings-state--${s.state}`}>{STATE_LABELS[s.state] ?? s.state}</span>
              <span className="pmap-settings-num">{s.indexedFiles}/{s.totalFiles}</span>
              <span className="pmap-settings-num">{s.totalNodes}</span>
              <span className="pmap-settings-num">{s.totalEdges}</span>
              <span className="pmap-settings-actions">
                <button type="button" className="settings-btn" title="Пересобрать карту" onClick={() => { void window.syntee.projectMap.rebuild(s.projectId); setTimeout(loadStats, 600) }}>
                  Пересобрать
                </button>
                <button type="button" className="settings-btn" title="Открыть карту" onClick={() => setMapProject(s)}>
                  Карта
                </button>
              </span>
            </div>
          ))}
        </div>
      </Group>

      {mapProject && (
        <ProjectMapModal
          open
          onClose={() => setMapProject(null)}
          projectId={mapProject.projectId}
          projectName={mapProject.name}
          workdir={mapProject.workdir}
        />
      )}
    </div>
  )
}