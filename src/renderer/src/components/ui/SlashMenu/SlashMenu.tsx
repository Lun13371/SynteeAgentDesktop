import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommand } from '../../../../../shared/slashCommands'
import { getCommandArguments } from '../../../../../shared/slashCommands'
import AppIcon from '../AppIcon/AppIcon'
import './SlashMenu.css'

interface SlashMenuProps {
  commands: SlashCommand[]
  selectedIndex: number
  anchorRef: React.RefObject<HTMLElement>
  onSelect: (cmd: SlashCommand) => void
  onClose: () => void
  /** Введённый запрос без '/' (то, что юзер успел напечатать) — подсветка
   *  совпадающего префикса в имени команды. '' / undefined — без подсветки. */
  query?: string
}

/** Имя команды с подсветкой совпавшего с запросом префикса. */
function CommandLabel({ label, query }: { label: string; query?: string }) {
  const q = (query ?? '').toLowerCase()
  const idx = q ? label.toLowerCase().indexOf(q) : -1
  if (idx !== 0 || !q) return <>{label}</>
  return (
    <>
      <span className="slash-menu-label-dim">{label.slice(0, q.length)}</span>
      <span className="slash-menu-label-match">{label.slice(q.length)}</span>
    </>
  )
}

export default function SlashMenu({ commands, selectedIndex, anchorRef, onSelect, query }: SlashMenuProps) {
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
      <div className="slash-menu-head">
        <span className="slash-menu-head-title">Команды</span>
        <span className="slash-menu-head-count">{commands.length}</span>
        <span className="slash-menu-head-keys">↑↓ — выбор · Enter — вставить</span>
      </div>
      <div className="slash-menu-list">
        {commands.map((cmd, i) => {
          // Чипы аргументов: приоритет у структурированных arguments
          // (обязательные подсвечиваются), для простых команд — синтезированный
          // аргумент из argumentHint/placeholder (см. getCommandArguments).
          const args = getCommandArguments(cmd)
          const isCustom = cmd.custom && cmd.source && cmd.source !== 'builtin'
          return (
            <button
              key={cmd.name}
              className={`slash-menu-item ${i === selectedIndex ? 'slash-menu-item--active' : ''}`}
              onMouseDown={e => { e.preventDefault(); onSelect(cmd) }}
            >
              <span className="slash-menu-icon">
                <AppIcon name={cmd.icon as Parameters<typeof AppIcon>[0]['name']} size="sm" />
              </span>
              <span className="slash-menu-main">
                <span className="slash-menu-title">
                  <span className="slash-menu-label">
                    <CommandLabel label={cmd.label} query={query} />
                  </span>
                  {args.map((arg, ai) => (
                    <span
                      key={ai}
                      className={`slash-menu-arg${arg.required ? ' slash-menu-arg--req' : ''}`}
                      title={arg.description || arg.name}
                    >
                      {arg.name}
                    </span>
                  ))}
                  {isCustom && (
                    <span className={`slash-menu-source slash-menu-source--${cmd.source}`} title={`Источник: ${cmd.source}`}>
                      {cmd.source === 'user' ? 'U' : cmd.source === 'project' ? 'P' : ''}
                    </span>
                  )}
                </span>
                <span className="slash-menu-desc">{cmd.description}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>,
    document.body
  )
}
