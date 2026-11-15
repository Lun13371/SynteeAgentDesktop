import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import ActivityStrip, { type ActivityItem } from './ActivityStrip'
import { useChatStore } from '../../../store/chat.store'
import type { CodeMapProgress } from '../../../../../shared/projectMap'

const ASSIST_LABELS: Record<string, string> = {
  binary: 'Скачиваю движок',
  model: 'Скачиваю модель',
  starting: 'Запускаю сервер',
  ready: 'Помощники готовы',
  error: 'Ошибка настройки',
}

const MAP_LABELS: Record<string, string> = {
  scanning: 'Сканирую файлы',
  parsing: 'Разбираю код',
  resolving: 'Строю связи',
  semantic: 'Индексирую семантику',
  ready: 'Карта готова',
  error: 'Ошибка карты',
}

type AssistPhase = { phase: string; percent: number; error?: string }

/**
 * Источник активностей для единой полоски: настройка мини-агентов и
 * фоновая индексация карт проектов. Оба процесса рендерятся одним
 * переиспользуемым ActivityStrip в футере ввода.
 */
export default function ChatActivityStrip() {
  const [assist, setAssist] = useState<AssistPhase | null>(null)
  const [assistVisible, setAssistVisible] = useState(false)
  const [map, setMap] = useState<CodeMapProgress | null>(null)
  const [mapVisible, setMapVisible] = useState(false)
  // Активный проект открытого чата: чужие проекты не перебивают уведомлениями,
  // пока идёт его индексация (карта и/или семантика). Когда у активного всё
  // готово — прогресс других проектов снова показывается.
  const activeProjectId = useChatStore(s => s.activeProjectId)
  // Стартуем с false: чужие скрыты, пока статус активного не подтверждён —
  // иначе стартовый флуд событий чужих проектов успевает прорваться.
  const activeDoneRef = useRef(false)

  useEffect(() => {
    // Смена активного проекта: пока не знаем его состояние — чужие скрыты,
    // статус запрашиваем у main (карта + семантика). Без проекта — показываем всё.
    activeDoneRef.current = !activeProjectId
    if (!activeProjectId) return
    let cancelled = false
    Promise.all([
      window.syntee.projectMap.getStatus(activeProjectId),
      window.syntee.projectMap.getSemanticStatus(activeProjectId),
    ]).then(([st, sem]) => {
      if (cancelled) return
      activeDoneRef.current = st.state === 'ready'
        && (sem.totalDocs === 0 || sem.state === 'ready' || sem.state === 'off')
    }).catch(() => { activeDoneRef.current = true })
    return () => { cancelled = true }
  }, [activeProjectId])

  useEffect(() => {
    const unsub = window.syntee.assistants.onSetupProgress(p => {
      setAssist(p)
      setAssistVisible(true)
      if (p.phase === 'ready') setTimeout(() => setAssistVisible(false), 3000)
      if (p.phase === 'error') setTimeout(() => setAssistVisible(false), 6000)
    })
    return () => { unsub() }
  }, [])

  useEffect(() => {
    const unsub = window.syntee.projectMap.onProgress(p => {
      // Чужие проекты не перебивают: показываем только если у активного
      // проекта карта и семантика полностью готовы (или чат без проекта).
      if (activeProjectId && p.projectId !== activeProjectId && !activeDoneRef.current) return
      // Мелкие быстрые правки (инкрементал на пару файлов) — молча, чтобы
      // полоска не надоедала. Показываем только заметные синки/сборки.
      if (p.incremental && (p.changedFiles ?? 0) < 20) return
      // Трекинг готовности активного проекта по его же событиям.
      if (p.projectId === activeProjectId) {
        if (p.semantic) activeDoneRef.current = p.semantic.state === 'ready'
        else if (p.phase === 'ready' && !p.semantic) activeDoneRef.current = true
        else if (p.phase !== 'ready') activeDoneRef.current = false
      }
      setMap(p)
      setMapVisible(true)
      if (p.phase === 'ready') setTimeout(() => setMapVisible(false), 3000)
      if (p.phase === 'error') setTimeout(() => setMapVisible(false), 6000)
    })
    return unsub
  }, [activeProjectId])

  const items: ActivityItem[] = []

  if (assistVisible && assist) {
    const busy = assist.phase !== 'ready' && assist.phase !== 'error'
    items.push({
      id: 'assistants',
      state: busy ? 'busy' : assist.phase === 'ready' ? 'ready' : 'error',
      label: ASSIST_LABELS[assist.phase] ?? 'Настройка помощников',
      detail: assist.error,
      percent: assist.percent,
      progress: busy,
    })
  }

  if (mapVisible && map) {
    const busy = map.phase !== 'ready' && map.phase !== 'error'
    const detail: string[] = []
    if (map.projectName) detail.push(map.projectName)
    if (busy && map.totalFiles > 0) detail.push(`${map.indexedFiles}/${map.totalFiles}`)
    if (busy && (map.pendingProjects ?? 0) > 0) detail.push(`ещё ${map.pendingProjects} пр.`)
    if (map.phase === 'ready' && map.message) detail.push(map.message)
    if (map.error) detail.push(map.error)
    items.push({
      id: 'projectMap',
      state: busy ? 'busy' : map.phase === 'ready' ? 'ready' : 'error',
      label: MAP_LABELS[map.phase] ?? 'Карта проекта',
      detail: detail.join(' · ') || undefined,
      percent: map.percent,
      progress: busy,
    })
  }

  // Слот анимируется по высоте: нет активностей → 0 (не занимает разметку),
  // есть → 12px. Плавное появление/исчезновение, чат не дёргается рывком.
  return (
    <motion.div
      className="chat-activity-slot"
      initial={false}
      animate={{ height: items.length > 0 ? 12 : 0, opacity: items.length > 0 ? 1 : 0 }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
    >
      <ActivityStrip items={items} />
    </motion.div>
  )
}