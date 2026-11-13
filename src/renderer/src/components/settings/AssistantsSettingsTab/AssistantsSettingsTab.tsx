import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Toggle from '../../ui/Toggle/Toggle'
import Select from '../../ui/Select/Select'
import Stepper from '../../ui/Stepper/Stepper'
import AppIcon, { type IconName } from '../../ui/AppIcon/AppIcon'
import { SectionTitle, Group, Field } from '../SettingsPrimitives'
import { useToast } from '../../ui/Toast/Toast'
import type { AssistantsSettings, AssistantLogEntry, AgentStatsMap } from '../../../../../shared/assistants'
import { DEFAULT_ASSISTANTS_SETTINGS } from '../../../../../shared/assistants'
import './AssistantsSettingsTab.css'

type Status = { serverState: string; modelSize: string; modelDownloaded: boolean; binaryReady: boolean; idleUnloaded?: boolean }
type SetupPhase = { phase: string; percent: number; error?: string }

const PHASE_LABELS: Record<string, string> = {
  binary: 'Скачиваю движок llama.cpp…',
  model: 'Скачиваю модель…',
  starting: 'Запускаю сервер…',
  ready: 'Готово',
  error: 'Ошибка',
}

type AgentKey = 'watcherEnabled' | 'janitorEnabled' | 'doctorEnabled' | 'briefingEnabled' | 'navigatorEnabled' | 'archivistEnabled' | 'economistEnabled'

interface AgentDef {
  key: AgentKey
  name: string
  icon: IconName
  color: string
  short: string
  what: string
  when: string
  how: string[]
  effect: string
  llm: string
}

const AGENTS: AgentDef[] = [
  {
    key: 'watcherEnabled', name: 'Watcher', icon: 'sparkles', color: '#818cf8',
    short: 'Подкидывает релевантную память и скиллы между ходами агента.',
    what: 'Семантический подсказчик: ищет в долгосрочной памяти и скиллах то, что релевантно текущему шагу, и инжектит короткой подсказкой в контекст.',
    when: 'На старте задачи, на ошибке тула, на повторе и на смене плана.',
    how: ['Строит запрос из события (текст задачи / ошибка / повтор).', 'Локальная модель делает 2 перефразировки запроса для точности.', 'E5-эмбеддинги ищут память + скиллы по ключевым словам.', 'Локальный судья отсеивает нерелевантное, веса источников учатся на фидбеке.', 'Лучшие 1-2 подсказки инжектятся между ходами.'],
    effect: 'Агент вспоминает нужные решения и конвенции без ручного напоминания.',
    llm: 'Да — перефразировки и судья релевантности.',
  },
  {
    key: 'janitorEnabled', name: 'Janitor', icon: 'filter', color: '#4ade80',
    short: 'Сжимает дубли, перечитывания и устаревший контекст, бережёт кэш.',
    what: 'Ужимальщик контекста: сворачивает повторные вызовы тулов, перечитывания файлов и старые tool-результаты в структурные резюме с возможностью recall.',
    when: 'Каждые N ходов (интервал в настройках) и внеочередно у лимита токенов.',
    how: ['Находит одинаковые вызовы тулов и повторные read_file.', 'Оставляет последнюю версию, старое сворачивает.', 'Старые tool-результаты сжимает в резюме (путь, строки, ошибки).', 'Оригиналы кладёт в архив — агент может вернуть их через recall.', 'Не трогает «конституцию» и не сжимает, если экономия мала (бережёт кэш промпта).'],
    effect: 'Меньше токенов и денег на длинных сессиях без потери важных фактов.',
    llm: 'Опционально — улучшает структурные резюме.',
  },
  {
    key: 'doctorEnabled', name: 'Loop doctor', icon: 'zap', color: '#fb923c',
    short: 'На зацикливании предлагает альтернативу вместо простого блока.',
    what: 'Лечит лупы: когда агент повторяет один и тот же тул или ошибку, предлагает конкретный другой подход.',
    when: 'На первом мягком срабатывании loop-guard и на ошибке тула.',
    how: ['Ловит повтор тула с теми же аргументами / чередование A-B-A-B.', 'Читает недавний контекст и текст ошибки.', 'Локальная модель предлагает одну конкретную альтернативу.', 'Инжектит её как подсказку — агент меняет стратегию, а не долбит в стену.'],
    effect: 'Меньше сожжённых токенов на бесконечных повторах.',
    llm: 'Да — генерация альтернативы.',
  },
  {
    key: 'briefingEnabled', name: 'Briefing', icon: 'brain', color: '#38bdf8',
    short: 'На старте задачи даёт агенту карту проекта и «где остановились в прошлый раз».',
    what: 'Собирает working memory, последние коммиты и незакоммиченные изменения в один короткий брифинг и инжектит на старте сессии.',
    when: 'Один раз на старте сессии (первый ход).',
    how: ['Читает working memory (последняя задача, изменённые файлы, карта файлов).', 'Читает git log -3 и git status — continuity между сессиями.', 'Добавляет действующие ограничения (конституцию).', 'Инжектит компактным блоком до первого хода модели.'],
    effect: 'Агент стартует с картой состояния и продолжением прошлой работы, а не угадывает.',
    llm: 'Нет — детерминированная сборка.',
  },
  {
    key: 'navigatorEnabled', name: 'Navigator', icon: 'compass', color: '#a78bfa',
    short: 'Следит за курсом: drift от цели и нарушения закреплённых ограничений.',
    what: 'Drift-судья: периодически сверяет недавние действия агента с целью и pinned-ограничениями; возвращает к курсу или останавливает нарушение правила.',
    when: 'Каждые N ходов, когда есть активная цель или действующие ограничения.',
    how: ['Берёт хвост транскрипта, objective цели и список закреплённых ограничений.', 'Локальный судья отвечает DRIFT: YES/NO и VIOLATION: YES/NO + причина.', 'При drift или нарушении инжектит напоминание.'],
    effect: 'Меньше самодеятельности и scope creep; закреплённые правила не забываются на длинных ранах.',
    llm: 'Да — бинарные drift/violation-судьи.',
  },
  {
    key: 'archivistEnabled', name: 'Archivist', icon: 'archive', color: '#34d399',
    short: 'В конце рана дистиллирует решения и грабли в долгосрочную память, без дублей.',
    what: 'Архивариус: после завершения хода извлекает 1-3 долговечных факта, отсеивает E5-дубли и сохраняет в память; старые невостребованные авто-факты постепенно теряют вес.',
    when: 'В конце каждого рана (финальный ответ).',
    how: ['Берёт хвост транскрипта сессии.', 'Локальная модель выделяет долговечные факты, отсеивая временное.', 'E5-дедуп: почти-дубли (cosine ≥ 0.9) не сохраняются повторно.', 'Новые факты сохраняются в memory_items.', 'Раз в сутки decay: авто-факты без обращений 14 дней теряют importance (пол 0.2).', 'Watcher потом находит их и подсказывает в будущих задачах.'],
    effect: 'Память накапливается сама и не распухает → агент умнее от сессии к сессии.',
    llm: 'Да — дистилляция фактов.',
  },
  {
    key: 'economistEnabled', name: 'Economist', icon: 'gauge', color: '#4ade80',
    short: 'Следит за расходом токенов относительно окна модели; калибруется по реальным usage и сжимает ступенчато.',
    what: 'Бюджетный монитор: калибрует оценку токенов по реальным prompt_tokens из API и форсирует ступенчатую компакцию. Порог зависит от окна модели: 1M → 30%, 500k → 60%, 256k → 70%, <256k → 80%.',
    when: 'Каждый ход; срабатывает при достижении порога для окна текущей модели.',
    how: ['Определяет окно контекста текущей модели.', 'Калибрует chars/4 по реальным prompt_tokens (EMA) — точно и для русского текста.', 'Ступень 1 (порог): лёгкая оптимизация — дедуп и перечитывания, без свёртки старых результатов.', 'Ступень 2 (порог +15%): глубокое сжатие с резюме и recall-архивом.', 'Сообщает в чат карточкой при переходе ступени.'],
    effect: 'Большие окна оптимизируются раньше (дёшево), маленькие — позже (не теряем контекст). Нет внезапных 413.',
    llm: 'Нет — детерминированный мониторинг.',
  },
]

export default function AssistantsSettingsTab() {
  const addToast = useToast(s => s.add)
  const [s, setS] = useState<AssistantsSettings>(DEFAULT_ASSISTANTS_SETTINGS)
  const [status, setStatus] = useState<Status>({ serverState: 'stopped', modelSize: '1.2B', modelDownloaded: false, binaryReady: false })
  const [setup, setSetup] = useState<SetupPhase | null>(null)
  const [log, setLog] = useState<AssistantLogEntry[]>([])
  const [stats, setStats] = useState<AgentStatsMap>({})
  const [info, setInfo] = useState<AgentDef | null>(null)

  const refresh = useCallback(() => {
    window.syntee.assistants.getSettings().then(setS).catch(() => {})
    window.syntee.assistants.getStatus().then(setStatus).catch(() => {})
    window.syntee.assistants.getLog().then(setLog).catch(() => {})
    window.syntee.assistants.getStats().then(setStats).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const unsub = window.syntee.assistants.onSetupProgress((p) => {
      setSetup(p)
      if (p.phase === 'ready') {
        refresh()
        addToast('Мини-агенты готовы к работе', 'success')
        setTimeout(() => setSetup(null), 2000)
      }
      if (p.phase === 'error') addToast(p.error ?? 'Ошибка настройки мини-агентов', 'error')
    })
    const interval = setInterval(refresh, 10_000)
    return () => { unsub(); clearInterval(interval) }
  }, [refresh, addToast])

  const upd = (patch: Partial<AssistantsSettings>) => {
    const next = { ...s, ...patch }
    setS(next)
    window.syntee.assistants.updateSettings(patch).then(setS).catch(() => {})
    if (patch.enabled === true) {
      setSetup({ phase: 'binary', percent: 0 })
      window.syntee.assistants.setup().then(res => {
        if (!res.ok) addToast(res.error ?? 'Не удалось запустить', 'error')
      })
    }
  }

  const isSettingUp = setup !== null && setup.phase !== 'ready' && setup.phase !== 'error'
  const isReady = status.serverState === 'ready'

  // Esc закрывает модалку — как в остальных модалках приложения.
  useEffect(() => {
    if (!info) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setInfo(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [info])

  return (
    <div className="assistants-tab">
      <SectionTitle description="Фоновые мини-агенты на маленькой локальной модели: подсказывают, сжимают, проверяют и помнят — параллельно с основным агентом">
        Мини-агенты
      </SectionTitle>

      {!s.enabled && !isSettingUp && (
        <div className="assistants-banner">
          <span className="assistants-banner-icon">✦</span>
          <div>
            <strong>Попробуйте мини-агентов</strong>
            <p>Семь фоновых агентов на локальной модели: подсказки из памяти и возможностей, сжатие контекста, защита от лупов и drift, накопление памяти. Всё локально, ничего не отправляет наружу. Включите — настроится само.</p>
          </div>
          <Toggle value={s.enabled} onChange={v => upd({ enabled: v })} />
        </div>
      )}

      {isSettingUp && (
        <div className="assistants-setup">
          <div className="assistants-setup-spinner" />
          <div className="assistants-setup-info">
            <strong>{PHASE_LABELS[setup!.phase] ?? 'Настройка…'}</strong>
            <div className="assistants-progress"><div style={{ width: `${setup!.percent}%` }} /></div>
          </div>
        </div>
      )}

      {isReady && !isSettingUp && (
        <div className="assistants-ready">
          <span className="assistants-dot assistants-dot--ready" />
          <span>Работает · {status.modelSize} · всё локально</span>
        </div>
      )}

      {!isReady && !isSettingUp && s.enabled && (
        <div className="assistants-ready assistants-ready--off">
          <span className="assistants-dot assistants-dot--stopped" />
          <span>
            {status.idleUnloaded
              ? 'Выгружена из памяти (простой > 5 мин) · поднимется сама при следующем вызове'
              : `Сервер не запущен · ${status.modelDownloaded ? 'модель на месте' : 'модель не скачана'}`}
          </span>
        </div>
      )}

      <Group id="assistants-basic" icon="settings" title="Запуск"
        right={<Toggle value={s.enabled} onChange={v => upd({ enabled: v })} />}>
        <Field label="Модель" description="Авто — LFM2.5 для большинства ПК. Gemma — лучше следует инструкциям. Qwen — самый лёгкий">
          <Select
            value={s.modelSize}
            onChange={v => upd({ modelSize: v as AssistantsSettings['modelSize'] })}
            options={[
              { value: 'auto', label: 'Авто (LFM2.5)' },
              { value: '1.2B', label: 'LFM2.5-1.2B · 731 МБ · лучший' },
              { value: '1B', label: 'Gemma 3 1B · 810 МБ · IFEval 80%' },
              { value: '0.8B', label: 'Qwen3.5-0.8B · 580 МБ · ultra-light' },
            ]}
            disabled={!s.enabled}
          />
        </Field>
      </Group>

      <Group id="assistants-agents" icon="bot" title="Мини-агенты">
        {AGENTS.map(a => {
          const st = stats[a.key.replace('Enabled', '')]
          return (
            <div className="ma-row" key={a.key}>
              <div className="ma-row-main">
                <div className="ma-row-head">
                  <span className="ma-row-icon" style={{ color: a.color, background: `${a.color}1a` }}><AppIcon name={a.icon} size="xs" /></span>
                  <span className="ma-row-name">{a.name}</span>
                  <button className="ma-info-btn" title={`Как работает ${a.name}`} onClick={() => setInfo(a)} aria-label={`Подробнее о ${a.name}`}>
                    <AppIcon name="info" size="xs" />
                  </button>
                </div>
                <p className="ma-row-desc">{a.short}</p>
                {st && (st.fired > 0 || st.skipped > 0) && (
                  <p className="ma-stats">
                    сработал {st.fired} · пропусков {st.skipped}
                    {st.saved > 0 && ` · −${st.saved >= 1000 ? `${(st.saved / 1000).toFixed(1)}k` : st.saved} токенов`}
                  </p>
                )}
              </div>
              <Toggle value={s[a.key]} onChange={v => upd({ [a.key]: v } as Partial<AssistantsSettings>)} disabled={!s.enabled} />
            </div>
          )
        })}
      </Group>

      <Group id="assistants-advanced" icon="settings" title="Тонкая настройка">
        <Field label="Бюджет подсказки (токенов)" description="Максимум токенов на одну инъекцию watcher">
          <Stepper value={s.hintBudgetTokens} onChange={v => upd({ hintBudgetTokens: v })} min={100} max={1000} step={50} />
        </Field>
        <Field label="Cooldown (ходов)" description="Минимум ходов между инъекциями">
          <Stepper value={s.hintCooldownRounds} onChange={v => upd({ hintCooldownRounds: v })} min={1} max={5} step={1} />
        </Field>
        <Field label="Интервал скана janitor (ходов)" description="Каждые N ходов janitor анализирует контекст">
          <Stepper value={s.janitorScanInterval} onChange={v => upd({ janitorScanInterval: v })} min={2} max={20} step={1} />
        </Field>
        <Field label="Порог «холодного» контекста (ходов)" description="Сообщения старше K ходов могут сжиматься">
          <Stepper value={s.janitorColdThreshold} onChange={v => upd({ janitorColdThreshold: v })} min={5} max={50} step={5} />
        </Field>
        <Field label="Мин. экономия janitor (токенов)" description="Не сжимать, если экономия меньше — бережёт кэш промпта">
          <Stepper value={s.janitorMinSavingsTokens} onChange={v => upd({ janitorMinSavingsTokens: v })} min={0} max={2000} step={50} />
        </Field>
        <Field label="Интервал navigator (ходов)" description="Как часто проверять drift относительно цели">
          <Stepper value={s.navigatorInterval} onChange={v => upd({ navigatorInterval: v })} min={2} max={20} step={1} />
        </Field>
        <Field label="Порог релевантности E5 (%)" description="Минимальный cosine score для подсказки из памяти">
          <Stepper value={Math.round(s.relevanceThreshold * 100)} onChange={v => upd({ relevanceThreshold: v / 100 })} min={30} max={95} step={5} />
        </Field>
        <Field label="Источник: память">
          <Toggle value={s.sources.memory} onChange={v => upd({ sources: { ...s.sources, memory: v } })} />
        </Field>
        <Field label="Источник: скиллы">
          <Toggle value={s.sources.skills} onChange={v => upd({ sources: { ...s.sources, skills: v } })} />
        </Field>
      </Group>

      <Group id="assistants-log" icon="chart" title="Живой лог">
        {log.length === 0 && <p className="assistants-log-empty">Лог пуст — мини-агенты ещё не работали</p>}
        {log.length > 0 && (
          <div className="assistants-log">
            {log.slice(-50).reverse().map((e, i) => (
              <div key={i} className={`assistants-log-entry assistants-log-entry--${e.role}`}>
                <span className="assistants-log-time">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className="assistants-log-role">{e.role}</span>
                <span className="assistants-log-kind">{e.kind}</span>
                <span className="assistants-log-detail">{e.detail}</span>
                {e.tokensSaved != null && <span className="assistants-log-saved">−{e.tokensSaved} tok</span>}
              </div>
            ))}
          </div>
        )}
      </Group>

      {createPortal(
        <AnimatePresence>
          {info && (
          <motion.div className="ma-modal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={() => setInfo(null)}>
            <motion.div className="ma-modal" initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.94, y: 12 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }} onClick={e => e.stopPropagation()}>
              <div className="ma-modal-head">
                <span className="ma-row-icon ma-modal-icon" style={{ color: info.color, background: `${info.color}1a` }}><AppIcon name={info.icon} size="sm" /></span>
                <div>
                  <h3>{info.name}</h3>
                  <p>{info.short}</p>
                </div>
                <button className="ma-modal-close" onClick={() => setInfo(null)} aria-label="Закрыть"><AppIcon name="x" size="sm" /></button>
              </div>
              <div className="ma-modal-body">
                <section><h4>Что делает</h4><p>{info.what}</p></section>
                <section><h4>Когда включается</h4><p>{info.when}</p></section>
                <section><h4>Как работает</h4>
                  <ol>{info.how.map((h, i) => <li key={i}>{h}</li>)}</ol>
                </section>
                <section><h4>Что даёт</h4><p>{info.effect}</p></section>
                <div className="ma-modal-llm"><AppIcon name="brain" size="xs" /><span>Локальная модель: {info.llm}</span></div>
              </div>
            </motion.div>
          </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  )
}