import { useMemo } from 'react'
import './Identicon.css'

interface IdenticonProps {
  /** Seed string — usually user id or email. */
  seed: string
  /** Diameter in pixels. */
  size?: number
  /** Override avatar URL. If provided, renders an <img> instead of the generated identicon. */
  src?: string | null
  /** Optional alt text. */
  alt?: string
  className?: string
}

/**
 * Deterministic identicon — generates a unique geometric avatar from a seed.
 * Uses a simple hash → hue + 5×5 grid pattern (GitHub-style).
 *
 * If `src` is provided (user-uploaded avatar URL), renders an <img> instead.
 */
export default function Identicon({ seed, size = 32, src, alt, className }: IdenticonProps) {
  const { hue, pattern } = useMemo(() => generateIdenticon(seed), [seed])

  if (src) {
    return (
      <img
        src={src}
        alt={alt ?? 'avatar'}
        width={size}
        height={size}
        className={`identicon identicon--img ${className ?? ''}`}
        style={{ width: size, height: size }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none'
        }}
      />
    )
  }

  const cellSize = size / 5
  const cells: { x: number; y: number }[] = []
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (pattern[y * 3 + x]) {
        cells.push({ x, y })
        // Mirror to the right half for symmetry (skip center column duplicate)
        if (x < 2) cells.push({ x: 4 - x, y })
      }
    }
  }

  return (
    <div
      className={`identicon ${className ?? ''}`}
      style={{
        width: size,
        height: size,
        background: `hsl(${hue}, 18%, 22%)`,
        borderRadius: '50%',
        overflow: 'hidden',
        display: 'flex',
        flexShrink: 0,
      }}
      role="img"
      aria-label={alt ?? `avatar for ${seed}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {cells.map((c, i) => (
          <rect
            key={i}
            x={c.x * cellSize}
            y={c.y * cellSize}
            width={cellSize + 0.5}
            height={cellSize + 0.5}
            fill={`hsl(${hue}, 65%, 58%)`}
          />
        ))}
      </svg>
    </div>
  )
}

/** Hash a string to a 32-bit integer (FNV-1a variant). */
function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function generateIdenticon(seed: string): { hue: number; pattern: boolean[] } {
  const h1 = hashString(seed || 'anonymous')
  const h2 = hashString((seed || 'anonymous') + '|salt')
  const hue = h1 % 360
  // 15-bit pattern (5 rows × 3 columns; right half mirrored)
  const bits = h2
  const pattern: boolean[] = []
  for (let i = 0; i < 15; i++) {
    pattern.push(((bits >> i) & 1) === 1)
  }
  return { hue, pattern }
}
