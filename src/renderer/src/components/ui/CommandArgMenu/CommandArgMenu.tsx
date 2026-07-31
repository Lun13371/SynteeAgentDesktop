import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { SlashCommand, CommandArgument } from '../../../../../shared/slashCommands'
import './CommandArgMenu.css'

interface CommandArgMenuProps {
  /** Команда, для которой показываем пикер аргументов. null = скрыт. */
  cmd: SlashCommand | null
  /** Индекс текущего аргумента в cmd.arguments. */
  level: number
  /** Опции для отображения (уже отфильтрованные по введённому префиксу). */
  choices: string[]
  selectedIndex: number
  anchorRef: React.RefObject<HTMLElement>
  onSelect: (choice: string) => void
  onClose: () => void
}

export default function CommandArgMenu({
  cmd, level, choices, selectedIndex, anchorRef, onSelect, onClose,
}: CommandArgMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const arg: CommandArgument | undefined = cmd?.arguments?.[level]

  // Позиционирование — как в SlashMenu: над anchor, ширина = anchor.
  useEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    const rect = anchor.getBoundingClientRect()
    menu.style.visibility = 'hidden'
    menu.style.top = '0px'
    menu.style.left = rect.left + 'px'
    menu.style.width = rect.width + 'px'
    requestAnimationFrame(() => {
      const h = menu.offsetHeight
      const viewportH = window.innerHeight
      if (rect.top - h - 6 < 8 && rect.bottom + h + 6 < viewportH) {
        menu.style.top = (rect.bottom + 6) + 'px'
      } else {
        menu.style.top = (rect.top - h - 6) + 'px'
      }
      menu.style.visibility = 'visible'
    })
  })

  // Скролл к выбранному.
  useEffect(() => {
    const item = menuRef.current?.querySelectorAll('.cmdarg-menu-item')[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Закрытие по клику снаружи.
  useEffect(() => {
    if (choices.length === 0) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [choices.length, onClose, anchorRef])

  if (choices.length === 0 || !cmd || !arg) return null

  return createPortal(
    <AnimatePresence>
      {choices.length > 0 && (
        <motion.div
          className="cmdarg-menu"
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.92, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 6 }}
          transition={{ type: 'spring', stiffness: 480, damping: 28 }}
        >
          <div className="cmdarg-menu-header">
            <span className="cmdarg-menu-cmd">{cmd.label}</span>
            <span className="cmdarg-menu-argname">{arg.name}</span>
            {arg.description && <span className="cmdarg-menu-argdesc">{arg.description}</span>}
            {arg.required ? (
              <span className="cmdarg-menu-required">обязательный</span>
            ) : (
              <span className="cmdarg-menu-optional">опц.</span>
            )}
          </div>
          <div className="cmdarg-menu-items">
            {choices.map((choice, i) => (
              <button
                key={choice}
                className={`cmdarg-menu-item ${i === selectedIndex ? 'cmdarg-menu-item--active' : ''}`}
                onMouseDown={e => { e.preventDefault(); onSelect(choice) }}
              >
                <span className="cmdarg-menu-bullet">
                  {/* дефолт-маркер */}
                  {arg.default === choice && <span className="cmdarg-menu-default-dot" />}
                </span>
                <span className="cmdarg-menu-choice">{choice}</span>
                {arg.default === choice && <span className="cmdarg-menu-default-tag">по умолч.</span>}
              </button>
            ))}
          </div>
          <div className="cmdarg-menu-footer">
            <span>↑↓ выбор</span>
            <span>Enter / Tab — вставить</span>
            <span>Esc — пропустить</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
