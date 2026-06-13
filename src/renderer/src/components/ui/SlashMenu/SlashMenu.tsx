import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import AppIcon from '../AppIcon/AppIcon'
import './SlashMenu.css'

interface SlashMenuProps {
  commands: SlashCommand[]
  selectedIndex: number
  anchorRef: React.RefObject<HTMLElement>
  onSelect: (cmd: SlashCommand) => void
  onClose: () => void
}

export default function SlashMenu({ commands, selectedIndex, anchorRef, onSelect, onClose }: SlashMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  // Позиционируем над textarea
  useEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return

    const rect = anchor.getBoundingClientRect()
    menu.style.left = rect.left + 'px'
    menu.style.top = (rect.top - menu.offsetHeight - 6) + 'px'
    menu.style.width = rect.width + 'px'
  })

  // Скроллим к выбранному элементу
  useEffect(() => {
    const item = menuRef.current?.children[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (commands.length === 0) return null

  return createPortal(
    <div className="slash-menu glass" ref={menuRef}>
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          className={`slash-menu-item ${i === selectedIndex ? 'slash-menu-item--active' : ''}`}
          onMouseDown={e => { e.preventDefault(); onSelect(cmd) }}
        >
          <span className="slash-menu-icon">
            <AppIcon name={cmd.icon as Parameters<typeof AppIcon>[0]['name']} size="sm" />
          </span>
          <span className="slash-menu-label">{cmd.label}</span>
          <span className="slash-menu-desc">{cmd.description}</span>
          {cmd.placeholder && (
            <span className="slash-menu-hint">{cmd.placeholder}</span>
          )}
        </button>
      ))}
    </div>,
    document.body
  )
}
