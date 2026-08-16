/**
 * Shared framer-motion spring presets for consistent tactile animations.
 *
 * Usage:
 *   import { whileHoverBtn, whileTapBtn, springHover } from '../utils/motionPresets'
 *   <motion.button whileHover={whileHoverBtn} whileTap={whileTapBtn} transition={springHover} />
 *
 * Philosophy: small buttons (24-32px) get bigger scale (1.08/0.90),
 * wide buttons get subtle scale (1.02/0.98) to avoid layout shift.
 */

// ── Spring transitions ──────────────────────────────────────────────

/** Standard hover spring — moderate bounce */
export const springHover = { type: 'spring' as const, stiffness: 400, damping: 25 }

/** Standard tap spring — snappy */
export const springTap = { type: 'spring' as const, stiffness: 500, damping: 30 }

/** Bouncy spring for stagger items (matches plus-menu feel) */
export const springBouncy = { type: 'spring' as const, stiffness: 520, damping: 28 }

/** Dropdown spring — smooth, slightly slower */
export const dropdownSpring = { type: 'spring' as const, stiffness: 420, damping: 32 }

// ── whileHover / whileTap scale presets ─────────────────────────────

/** Standard button (32px) — hover grows 6%, tap shrinks 10% */
export const whileHoverBtn = { scale: 1.06 }
export const whileTapBtn = { scale: 0.90 }

/** Small button (20-24px) — hover grows 4%, tap shrinks 8% */
export const whileHoverSm = { scale: 1.04 }
export const whileTapSm = { scale: 0.92 }

/** Tiny button (16-20px) — hover grows 15%, tap shrinks 15% (big tactile feel) */
export const whileHoverTiny = { scale: 1.15 }
export const whileTapTiny = { scale: 0.85 }

/** Wide button (full-width like extensions) — subtle to avoid layout shift */
export const whileHoverWide = { scale: 1.02 }
export const whileTapWide = { scale: 0.98 }

/** List item (chat items) — very subtle */
export const whileHoverListItem = { scale: 1.01 }
export const whileTapListItem = { scale: 0.99 }

// ── Stagger variants (matching plus-menu pattern) ───────────────────

export const staggerContainer = {
  hidden: { opacity: 0, scale: 0.5 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { staggerChildren: 0.04, delayChildren: 0.08, type: 'spring', stiffness: 350, damping: 26 },
  },
  exit: {
    opacity: 0,
    scale: 0.5,
    transition: { staggerChildren: 0.02, staggerDirection: -1, duration: 0.18 },
  },
}

export const staggerItem = {
  hidden: { opacity: 0, x: -12, scale: 0.96 },
  visible: { opacity: 1, x: 0, scale: 1, transition: { type: 'spring', stiffness: 520, damping: 28 } },
  exit: { opacity: 0, x: -6, transition: { duration: 0.1 } },
}
