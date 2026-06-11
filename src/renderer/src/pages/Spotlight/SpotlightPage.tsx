import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'

export default function SpotlightPage() {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') window.syntee.spotlight.hide()
    if (e.key === 'Enter' && value.trim()) {
      // будет реализовано в стадии 03
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: -8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
      style={{
        width: '100%',
        background: 'rgba(20,20,20,0.92)',
        backdropFilter: 'blur(40px) saturate(180%)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 16px', height: 56 }}>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{ flexShrink: 0, opacity: 0.5 }}>
          <circle cx="7.5" cy="7.5" r="5.5" stroke="white" strokeWidth="1.5"/>
          <path d="M13 13l3 3" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Спросите что угодно..."
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            color: 'white',
            fontSize: 15,
            padding: '0 12px',
            caretColor: 'white',
          }}
        />
      </div>
    </motion.div>
  )
}
