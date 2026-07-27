/* eslint-disable react-hooks/set-state-in-effect */
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useShallow } from 'zustand/react/shallow'
import { useUIStore } from '../../../store/ui.store'
import { useToast } from '../../ui/Toast/Toast'
import Toggle from '../../ui/Toggle/Toggle'
import AppIcon from '../../ui/AppIcon/AppIcon'
import {
  BUILTIN_SOUNDS, SOUND_ACTIONS, DEFAULT_SOUND_ASSIGNMENTS,
  previewSound, clearCustomSoundCache, type SoundAction,
} from '../../../utils/sounds'
import './SoundsPanel.css'

interface CustomSoundItem { id: string; name: string; size: number; mtime: number }

export default function SoundsPanel({ settings, onSet }: {
  settings: Record<string, unknown>
  onSet: (k: string, v: unknown) => void
}) {
  const [customSounds, setCustomSounds] = useState<CustomSoundItem[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { add: toast } = useToast()

  const { soundVolume, soundAssignments } = useUIStore(useShallow(s => ({
    soundVolume: s.soundVolume,
    soundAssignments: s.soundAssignments,
  })))

  const assignments: Record<string, string | null> =
    (soundAssignments as Record<string, string | null>) ||
    (settings['soundAssignments'] as Record<string, string | null>) ||
    {}

  const reloadCustom = useCallback(async () => {
    const list = await window.syntee.sound.list()
    setCustomSounds(list)
  }, [])

  useEffect(() => { reloadCustom() }, [reloadCustom])

  const onPickSound = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    e.target.value = ''
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'mp3'
      const buf = await file.arrayBuffer()
      const savedId = await window.syntee.sound.save(new Uint8Array(buf), ext, file.name)
      if (!savedId) {
        toast(`Не удалось сохранить: ${file.name}`, 'error')
      }
    }
    await reloadCustom()
    toast('Звуки загружены', 'success')
  }

  const onDeleteCustom = async (id: string) => {
    const ok = await window.syntee.sound.delete(id)
    if (!ok) { toast('Не удалось удалить', 'error'); return }
    clearCustomSoundCache(id)
    // Если этот звук был назначен на какое-то действие — сбрасываем
    const next = { ...assignments }
    let changed = false
    for (const [action, soundId] of Object.entries(next)) {
      if (soundId === id) { next[action] = null; changed = true }
    }
    if (changed) onSet('soundAssignments', next)
    await reloadCustom()
  }

  const setActionSound = (action: SoundAction, soundId: string | null) => {
    const next = { ...assignments, [action]: soundId }
    onSet('soundAssignments', next)
  }

  // Все доступные звуки для селекта: встроенные + кастомные + "нет"
  const allSoundOptions = [
    { id: null as string | null, name: '— Нет —' },
    ...BUILTIN_SOUNDS.filter(s => s.id !== 'synth.none').map(s => ({ id: s.id, name: s.name })),
    ...customSounds.map(s => ({ id: s.id, name: s.name })),
  ]

  return (
    <div className="sounds-panel">
      <Field label="Звуки интерфейса" description="Включить/выключить все звуки">
        <Toggle value={settings['uiSounds'] !== false} onChange={v => onSet('uiSounds', v)} />
      </Field>

      <Field label="Громкость" description={`${soundVolume}%`}>
        <input
          type="range" min={0} max={100} value={soundVolume}
          onChange={e => onSet('soundVolume', Number(e.target.value))}
          className="settings-slider"
        />
      </Field>

      {/* ── Свои звуки ── */}
      <div className="sounds-section">
        <div className="sounds-section-header">
          <span className="sounds-section-title">Свои звуки</span>
          <button className="sounds-upload-btn" onClick={() => fileInputRef.current?.click()}>
            <AppIcon name="plus" size="xs" /> Добавить
          </button>
          <input ref={fileInputRef} type="file" accept="audio/*" multiple onChange={onPickSound} style={{ display: 'none' }} />
        </div>
        {customSounds.length === 0 ? (
          <div className="sounds-empty">Нет загруженных звуков. Поддерживаются mp3, wav, ogg.</div>
        ) : (
          <div className="sounds-custom-list">
            <AnimatePresence>
              {customSounds.map(s => (
                <motion.div
                  key={s.id}
                  className="sounds-custom-item"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                >
                  <span className="sounds-custom-name" title={s.name}>{s.name}</span>
                  <div className="sounds-custom-actions">
                    <button
                      className="sounds-preview-btn"
                      onClick={() => previewSound(s.id)}
                      title="Прослушать"
                    >
                      <AppIcon name="volume" size="xs" />
                    </button>
                    <button
                      className="sounds-delete-btn"
                      onClick={() => onDeleteCustom(s.id)}
                      title="Удалить"
                    >
                      <AppIcon name="trash" size="xs" />
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* ── Назначения по действиям ── */}
      <div className="sounds-section">
        <div className="sounds-section-title">Звуки по действиям</div>
        <div className="sounds-actions-list">
          {SOUND_ACTIONS.map(action => {
            const assigned = assignments[action.id] ?? DEFAULT_SOUND_ASSIGNMENTS[action.id] ?? null
            return (
              <div key={action.id} className="sounds-action-row">
                <span className="sounds-action-label">{action.label}</span>
                <div className="sounds-action-controls">
                  <button
                    className="sounds-preview-btn"
                    onClick={() => previewSound(assigned)}
                    title="Прослушать"
                    disabled={!assigned}
                  >
                    <AppIcon name="volume" size="xs" />
                  </button>
                  <select
                    className="settings-select sounds-action-select"
                    value={assignments[action.id] ?? ''}
                    onChange={e => setActionSound(action.id, e.target.value || null)}
                  >
                    {allSoundOptions.map(opt => (
                      <option key={opt.id ?? 'none'} value={opt.id ?? ''}>
                        {opt.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">
        <span>{label}</span>
        {description && <p className="settings-field-desc">{description}</p>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  )
}
