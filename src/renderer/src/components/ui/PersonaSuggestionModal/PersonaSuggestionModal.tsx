import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { getPersona, type PersonaId } from '../../../../../shared/modes'
import './PersonaSuggestionModal.css'

export interface PersonaSuggestionModalProps {
  personaId: PersonaId
  /** First-message snippet (truncated) shown to give context why we suggested. */
  messagePreview?: string
  onAccept: () => void
  onDismiss: () => void
  onNeverAsk: () => void
}

const ICONS: Record<string, string> = {
  debugger:
    '<path d="M12 3a6 6 0 0 0-4 10.5c.5.5 1 1.5 1 2.5h6c0-1 .5-2 1-2.5A6 6 0 0 0 12 3z"/><path d="M9 21h6"/><path d="M10 16v5"/><path d="M14 16v5"/>',
  reviewer:
    '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  refactorer:
    '<path d="M4 4l6 6"/><path d="M20 4l-6 6"/><path d="M4 20l6-6"/><path d="M20 20l-6-6"/>',
  testWriter:
    '<path d="M9 2h6l1 3h4v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5h4z"/><path d="M9 13l2 2 4-4"/>',
  mentor:
    '<path d="M12 14l9-5-9-5-9 5 9 5z"/><path d="M12 14v7"/><path d="M5 11v4l7 4 7-4v-4"/>',
  architect:
    '<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/><path d="M9 9v.01"/><path d="M9 12v.01"/><path d="M9 15v.01"/><path d="M9 18v.01"/>',
}

export function PersonaSuggestionModal({
  personaId,
  messagePreview,
  onAccept,
  onDismiss,
  onNeverAsk,
}: PersonaSuggestionModalProps) {
  const persona = getPersona(personaId)
  const name = persona.nameEn
  const icon = ICONS[personaId] ?? ICONS.debugger

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
      else if (e.key === 'Enter') onAccept()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAccept, onDismiss])

  return createPortal(
    <div
      className="chat-input-persona-suggest-overlay"
      onClick={onDismiss}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="chat-input-persona-suggest"
        style={{ ['--persona-color' as string]: persona.color || 'var(--accent)' } as React.CSSProperties}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="chat-input-persona-suggest-title">
          <span
            className="chat-input-persona-suggest-icon"
            dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 24 24">${icon}</svg>` } as { __html: ReactNode }}
          />
          <span>Switch to {name}?</span>
        </div>
        <div className="chat-input-persona-suggest-body">
          This looks like a <strong>{name.toLowerCase()}</strong> task.
          {messagePreview ? (
            <>
              {' '}
              You said: <em>"{messagePreview.length > 80 ? messagePreview.slice(0, 80) + '…' : messagePreview}"</em>
            </>
          ) : null}
          <br />
          Switch the chat's persona to {name}? You can change it any time via the <strong>+</strong> menu or <strong>/persona</strong>.
        </div>
        <div className="chat-input-persona-suggest-actions">
          <button
            className="chat-input-persona-suggest-btn chat-input-persona-suggest-btn--primary"
            onClick={onAccept}
            autoFocus
          >
            Switch to {name}
          </button>
          <button
            className="chat-input-persona-suggest-btn chat-input-persona-suggest-btn--ghost"
            onClick={onDismiss}
          >
            Not now
          </button>
          <button
            className="chat-input-persona-suggest-btn chat-input-persona-suggest-btn--never"
            onClick={onNeverAsk}
          >
            Never suggest
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
