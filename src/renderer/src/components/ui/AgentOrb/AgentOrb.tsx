import { memo } from 'react'
import './AgentOrb.css'

export type AgentOrbStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

// Iridescent identity palettes — three hues per role, anchored on the role's
// badge color (subagent-roles.ts). The conic wheel sweeps through all three so
// the orb continuously iridesces between them while the agent works.
const ROLE_PALETTES: Record<string, readonly [string, string, string]> = {
  researcher:        ['#60a5fa', '#22d3ee', '#818cf8'], // blue → cyan → indigo
  'deep-researcher': ['#a78bfa', '#e879f9', '#38bdf8'], // violet → fuchsia → sky
  editor:            ['#fbbf24', '#fb923c', '#f472b6'], // amber → orange → pink
  implementer:       ['#34d399', '#2dd4bf', '#a3e635'], // emerald → teal → lime
  reviewer:          ['#f472b6', '#fb7185', '#c084fc'], // pink → rose → purple
}
// Unknown / role-less agents get the signature pink→cyan→indigo sweep.
const FALLBACK_PALETTE: readonly [string, string, string] = ['#f472b6', '#22d3ee', '#818cf8']
// Terminal states settle to a static gradient: success → green, failure → red,
// cancelled → neutral slate. No motion once the agent is no longer working.
const DONE_PALETTE: readonly [string, string, string] = ['#34d399', '#22c55e', '#86efac']
const ERROR_PALETTE: readonly [string, string, string] = ['#fb7185', '#ef4444', '#f87171']
const CANCELLED_PALETTE: readonly [string, string, string] = ['#94a3b8', '#64748b', '#cbd5e1']

function paletteFor(role: string | undefined, status: AgentOrbStatus): readonly [string, string, string] {
  if (status === 'done') return DONE_PALETTE
  if (status === 'error') return ERROR_PALETTE
  if (status === 'cancelled') return CANCELLED_PALETTE
  return (role && ROLE_PALETTES[role]) || FALLBACK_PALETTE
}

interface AgentOrbProps {
  role?: string
  status?: AgentOrbStatus
  size?: number
  className?: string
}

const AgentOrb = memo(function AgentOrb({ role, status = 'running', size = 18, className }: AgentOrbProps) {
  const [c1, c2, c3] = paletteFor(role, status)
  const live = status === 'running' || status === 'pending'
  const style = {
    '--orb-c1': c1,
    '--orb-c2': c2,
    '--orb-c3': c3,
    '--orb-size': `${size}px`,
  } as React.CSSProperties

  return (
    <span
      className={`agent-orb agent-orb--${status}${live ? ' agent-orb--live' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden="true"
    >
      <span className="agent-orb__body">
        <span className="agent-orb__spin" />
        <span className="agent-orb__iris" />
        <span className="agent-orb__sheen" />
      </span>
    </span>
  )
}, (prev, next) =>
  prev.role === next.role && prev.status === next.status &&
  prev.size === next.size && prev.className === next.className)

export default AgentOrb