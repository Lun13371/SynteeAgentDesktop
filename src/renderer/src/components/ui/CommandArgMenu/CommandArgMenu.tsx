import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import type { SlashCommand, CommandArgument } from '../../../../../shared/slashCommands'
import { getCommandArguments } from '../../../../../shared/slashCommands'
import './CommandArgMenu.css'

interface CommandArgMenuProps {
  /** Команда, для которой показываем пикер. null = скрыт. */
  cmd: SlashCommand | null
  /** Индекс текущего аргумента в cmd.arguments. */
  level: number
  /** Опции для отображения (уже отфильтрованные по введённому префиксу).
   *  Пустой массив при заданном cmd+arg — free-text режим: аргумент без
   *  choices, показываем подсказку-карточку вместо списка опций. */
  choices: string[]
  selectedIndex: number
  /** Частично введённый префикс текущего аргумента — подсветка совпадения
   *  в опциях. '' — ввод не начат (после пробела). */
  prefix?: string
  anchorRef: React.RefObject<HTMLElement>
  onSelect: (choice: string) => void
  onClose: () => void
}

/** Опция с подсветкой совпавшего префикса (case-insensitive). */
function ChoiceLabel({ choice, prefix }: { choice: string; prefix?: string }) {
  const p = (prefix ?? '').toLowerCase()
  if (!p) return <>{choice}</>
  const idx = choice.toLowerCase().indexOf(p)
  if (idx !== 0) return <>{choice}</>
  return (
    <>
      <span className="cmdarg-menu-choice-match">{choice.slice(0, p.length)}</span>
      {choice.slice(p.length)}
    </>
  )
}

export default function CommandArgMenu({
  cmd, level, choices, selectedIndex, prefix, anchorRef, onSelect, onClose,
}: CommandArgMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  // Эффективный список аргументов: у команд без структурированных arguments
  // он синтезируется из placeholder/argumentHint — free-text подсказка
  // работает для ВСЕХ команд, а не только для enum-пикера.
  const args = cmd ? getCommandArguments(cmd) : []
  const arg: CommandArgument | undefined = args[level]
  const totalArgs = args.length
  const freeText = choices.length === 0 && !!cmd && !!arg

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
    if (!cmd) return
    const close = (e: MouseEvent): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      if (anchorRef.current?.contains(e.target as Node)) return
      onClose()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', close), 0)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', close) }
  }, [choices.length, cmd, onClose, anchorRef])

  if (!cmd || !arg) return null

  return createPortal(
    <AnimatePresence>
      {(freeText || choices.length > 0) && (
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
            {totalArgs > 1 && (
              <span className="cmdarg-menu-steps" title={`Аргумент ${level + 1} из ${totalArgs}`}>
                {Array.from({ length: totalArgs }, (_, i) => (
                  <span
                    key={i}
                    className={`cmdarg-menu-step${i < level ? ' cmdarg-menu-step--done' : ''}${i === level ? ' cmdarg-menu-step--cur' : ''}`}
                  />
                ))}
              </span>
            )}
            {arg.required ? (
              <span className="cmdarg-menu-required">обязательный</span>
            ) : (
              <span className="cmdarg-menu-optional">опц.</span>
            )}
          </div>
          <div className="cmdarg-menu-sub">
            <span className="cmdarg-menu-argname">{arg.name}</span>
            {arg.description && <span className="cmdarg-menu-argdesc">{arg.description}</span>}
          </div>
          {freeText ? (
            <div className="cmdarg-menu-free">
              <svg className="cmdarg-menu-free-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              <span>Свободный текст — допишите значение и отправьте</span>
            </div>
          ) : (
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
                  <span className="cmdarg-menu-choice">
                    <ChoiceLabel choice={choice} prefix={prefix} />
                  </span>
                  {arg.default === choice && <span className="cmdarg-menu-default-tag">по умолч.</span>}
                  {i === selectedIndex && (
                    <svg className="cmdarg-menu-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="cmdarg-menu-footer">
            {freeText ? (
              <>
                <span>Enter — отправить</span>
                <span>Esc — скрыть подсказку</span>
              </>
            ) : (
              <>
                <span>↑↓ выбор</span>
                <span>Enter / Tab — вставить</span>
                <span>Esc — пропустить</span>
              </>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
