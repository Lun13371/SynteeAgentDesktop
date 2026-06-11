import { motion } from 'framer-motion'
import './Sidebar.css'

export default function Sidebar() {
  return (
    <motion.aside
      className="sidebar glass"
      initial={{ x: -20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
    >
      <div className="sidebar-top">
        <motion.button
          className="sidebar-new-chat"
          whileTap={{ scale: 0.95 }}
          whileHover={{ scale: 1.02 }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Новый чат
        </motion.button>
      </div>

      <div className="sidebar-list">
        <div className="sidebar-group-label">Сегодня</div>
        {/* Список чатов будет добавлен в стадии 03 */}
        <div className="sidebar-empty">Нет чатов</div>
      </div>

      <div className="sidebar-bottom">
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">S</div>
          <span className="sidebar-user-name">Пользователь</span>
          <motion.button
            className="sidebar-settings-btn no-drag"
            whileTap={{ scale: 0.88 }}
            title="Настройки"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.93 2.93l1.41 1.41M11.66 11.66l1.41 1.41M2.93 13.07l1.41-1.41M11.66 4.34l1.41-1.41"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
          </motion.button>
        </div>
      </div>
    </motion.aside>
  )
}
