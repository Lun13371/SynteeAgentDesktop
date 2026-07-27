import { motion } from 'framer-motion'
import Logo from '../Logo/Logo'
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
        <Logo size={14} />
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
