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

  // Пересчитываем позицию после каждого рендера
  useEffect(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return

    const rect = anchor.getBoundingClientRect()
    // Ставим снизу от anchor сначала чтобы получить высоту
    menu.style.visibility = 'hidden'
    menu.style.top = '0px'
    menu.style.left = rect.left + 'px'
    menu.style.width = rect.width + 'px'

    // После получения высоты — ставим над anchor
    requestAnimationFrame(() => {
      const h = menu.offsetHeight
      menu.style.top = (rect.top - h - 6) + 'px'
      menu.style.visibility = 'visible'
    })
  })

  // Скроллим к выбранному
  useEffect(() => {
    const item = menuRef.current?.querySelectorAll('.slash-menu-item')[selectedIndex] as HTMLElement
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  if (commands.length === 0) return null

  return createPortal(
    <div className="slash-menu" ref={menuRef}>
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
          {cmd.argumentHint && (
            <span className="slash-menu-hint">{cmd.argumentHint}</span>
          )}
          {!cmd.argumentHint && cmd.placeholder && (
            <span className="slash-menu-hint">{cmd.placeholder}</span>
          )}
          {cmd.custom && cmd.source && cmd.source !== 'builtin' && (
            <span className={`slash-menu-source slash-menu-source--${cmd.source}`} title={`Источник: ${cmd.source}`}>
              {cmd.source === 'user' ? 'U' : cmd.source === 'project' ? 'P' : ''}
            </span>
          )}
        </button>
      ))}
    </div>,
    document.body
  )
}
