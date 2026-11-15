import { useState, useEffect, useCallback, useRef } from 'react'
import Toggle from '../../ui/Toggle/Toggle'
import Select from '../../ui/Select/Select'
import AppIcon from '../../ui/AppIcon/AppIcon'
import { SectionTitle, Group, Field } from '../SettingsPrimitives'
import ProjectMapModal from '../../ui/ProjectMapModal/ProjectMapModal'
import { DEFAULT_PROJECT_MAP_SPEED, type ProjectMapSpeedSettings, type ProjectMapProjectStats, type ProjectMapAutoInfo, type CodeMapSemanticStatus } from '../../../../../shared/projectMap'
import './ProjectMapSettingsTab.css'

const STATE_LABELS: Record<string, string> = {
  idle: 'ожидает',
  building: 'индексация',
  ready: 'готова',
  error: 'ошибка',
}

const SEMANTIC_LABELS: Record<string, string> = {
  off: '—',
  warming: 'прогрев',
  ready: 'готова',
  error: 'ошибка',
}

/** Живой статус семантики из прогресс-событий (между перезагрузками listStats). */
type SemanticLive = Record<string, CodeMapSemanticStatus>

export default function ProjectMapSettingsTab() {
  const [enabled, setEnabled] = useState(true)
  const [speed, setSpeed] = useState<ProjectMapSpeedSettings>(DEFAULT_PROJECT_MAP_SPEED)
  const [auto, setAuto] = useState<ProjectMapAutoInfo | null>(null)
  const [stats, setStats] = useState<ProjectMapProjectStats[]>([])
  const [semanticLive, setSemanticLive] = useState<SemanticLive>({})
  const [mapProject, setMapProject] = useState<ProjectMapProjectStats | null>(null)
  const [device, setDevice] = useState<'auto' | 'cpu' | 'gpu'>('auto')
  const [deviceActive, setDeviceActive] = useState<string | null>(null)
  const lastStatsReload = useRef(0)

  const loadStats = useCallback(() => {
    window.syntee.projectMap.listStats().then(rows => {
      setStats(rows)
      // Свежие данные из listStats перекрывают живые события.
      setSemanticLive(prev => {
        const next: SemanticLive = {}
        for (const r of rows) next[r.projectId] = r.semantic
        // Не откатываем живой прогресс назад, если listStats старее события.
        for (const [pid, live] of Object.entries(prev)) {
          const row = next[pid]
          if (row && live.indexedDocs > row.indexedDocs) next[pid] = live
        }
        return next
      })
    }).catch(() => {})
  }, [])

  useEffect(() => {
    window.syntee.settings.get('projectMapEnabled').then(v => setEnabled(v !== false)).catch(() => {})
    window.syntee.settings.get('projectMapSpeed').then(v => setSpeed(v ?? DEFAULT_PROJECT_MAP_SPEED)).catch(() => {})
    window.syntee.settings.get('projectMapSemanticDevice').then(v => {
      const next = v === 'cpu' || v === 'gpu' ? v : 'auto'
      setDevice(next)
      // Активный провайдер показываем только рядом с выбранным режимом.
      window.syntee.projectMap.getSemanticDevice().then(d => setDeviceActive(d.active)).catch(() => {})
    }).catch(() => {})
    window.syntee.projectMap.getAutoInfo().then(setAuto).catch(() => {})
    loadStats()
  }, [loadStats])

  // Обновляем таблицу по завершении сборки/инкрементала (не на каждый файл)
  // и ведём живой прогресс семантики (фаза 'semantic', троттл 800мс на пачку).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const unsub = window.syntee.projectMap.onProgress(p => {
      if (p.semantic) {
        const s = p.semantic
        setSemanticLive(prev => ({
          ...prev,
          [p.projectId]: {
            state: s.state,
            mode: 'e5',
            totalDocs: s.totalDocs,
            indexedDocs: Math.max(s.indexedDocs, prev[p.projectId]?.indexedDocs ?? 0),
            error: null,
          },
        }))
        // Раз в 2с синхронизируем полную таблицу (имена проектов, статусы).
        const now = Date.now()
        if (now - lastStatsReload.current > 2000) {
          lastStatsReload.current = now
          loadStats()
        }
      }
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
  const saveDevice = (v: 'auto' | 'cpu' | 'gpu') => {
    setDevice(v)
    void window.syntee.settings.set('projectMapSemanticDevice', v)
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

        <Field id="pmap-device" label="Устройство для семантики" description="На чём считать E5-эмбеддинги. Авто — GPU (DirectML), если видеокарта с DX12 доступна, иначе CPU. GPU заметно ускоряет прогрев семантики, но нагружает видеокарту — в игре возможны просадки. Смена вступает в силу сразу: sidecar перезапустится, старые векторы остаются валидными.">
          <Select
            value={device}
            onChange={v => saveDevice(v as 'auto' | 'cpu' | 'gpu')}
            options={[
              { value: 'auto', label: 'Авто (GPU при доступности)' },
              { value: 'cpu', label: 'Только CPU' },
              { value: 'gpu', label: 'Только GPU (DirectML)' },
            ]}
          />
        </Field>

        {deviceActive && (
          <div className="pmap-settings-auto">
            <AppIcon name="gauge" size="xs" tone="accent" />
            <span>
              Семантика сейчас: {deviceActive === 'directml' ? 'GPU (DirectML)' : deviceActive === 'cpu' ? 'CPU' : 'провайдер ещё не определён'}
            </span>
          </div>
        )}
      </Group>

      <Group id="pmap-projects" icon="chart" title="Проекты" note="Статистика карт и ручная пересборка.">
        <div className="pmap-settings-table">
          <div className="pmap-settings-row pmap-settings-row--head">
            <span>Проект</span><span>Статус</span><span>Файлы</span><span>Узлы</span><span>Связи</span><span>Семантика</span><span />
          </div>
          {stats.length === 0 && <div className="pmap-settings-empty">Проектов пока нет.</div>}
          {stats.map(s => {
            const sem = semanticLive[s.projectId] ?? s.semantic
            const semLabel = SEMANTIC_LABELS[sem?.state] ?? sem?.state ?? '—'
            return (
              <div key={s.projectId} className="pmap-settings-row">
                <span className="pmap-settings-name" title={s.workdir}>{s.name}</span>
                <span className={`pmap-settings-state pmap-settings-state--${s.state}`}>{STATE_LABELS[s.state] ?? s.state}</span>
                <span className="pmap-settings-num">{s.indexedFiles}/{s.totalFiles}</span>
                <span className="pmap-settings-num">{s.totalNodes}</span>
                <span className="pmap-settings-num">{s.totalEdges}</span>
                <span className="pmap-settings-num" title={sem?.error ?? undefined}>
                  {sem && sem.totalDocs > 0 ? `${sem.indexedDocs}/${sem.totalDocs}` : '—'}{sem && sem.totalDocs > 0 ? ` · ${semLabel}` : ''}
                </span>
                <span className="pmap-settings-actions">
                  <button type="button" className="settings-btn" title="Пересобрать карту" onClick={() => { void window.syntee.projectMap.rebuild(s.projectId); setTimeout(loadStats, 600) }}>
                    Пересобрать
                  </button>
                  <button type="button" className="settings-btn" title="Открыть карту" onClick={() => setMapProject(s)}>
                    Карта
                  </button>
                </span>
              </div>
            )
          })}
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