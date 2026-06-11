import { motion } from 'framer-motion'
import './TypingIndicator.css'

export default function TypingIndicator() {
  return (
    <motion.div
      className="typing-wrap"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ type: 'spring', stiffness: 300, damping: 28 }}
    >
      <div className="typing-avatar">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <polygon points="7,1 13,4 13,10 7,13 1,10 1,4"
            fill="none" stroke="var(--accent)" strokeWidth="1.2" opacity="0.8"/>
        </svg>
      </div>
      <div className="typing-bubble glass">
        {[0, 1, 2].map(i => (
          <motion.span
            key={i}
            className="typing-dot"
            animate={{ y: [0, -5, 0] }}
            transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15 }}
          />
        ))}
      </div>
    </motion.div>
  )
}
