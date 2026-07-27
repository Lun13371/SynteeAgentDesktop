import { motion } from 'framer-motion'
import { playClickSound } from '../../../utils/sounds'

export interface ToggleProps {
  value: boolean
  onChange: (v: boolean) => void
  /** Если true — toggle нельзя переключить (полу-прозрачный, без cursor). */
  disabled?: boolean
  /** ARIA-метка для скринридеров. */
  'aria-label'?: string
}

// Единый toggle-switch для всех настроек. Раньше копия этой логики
// жила в SettingsPage / ContextSettingsTab / IndexingSettingsTab —
// теперь один источник правды. CSS-классы (.settings-toggle,
// .settings-toggle-thumb) определены в SettingsPage.css глобально.
// Thumb позиция (x) анимируется framer-motion — CSS transform не трогать.
export default function Toggle({ value, onChange, disabled, ...rest }: ToggleProps) {
  return (
    <motion.button
      type="button"
      className={`settings-toggle ${value ? 'settings-toggle--on' : ''}${disabled ? ' settings-toggle--disabled' : ''}`}
      onClick={() => { if (!disabled) { playClickSound(); onChange(!value) } }}
      whileTap={disabled ? undefined : { scale: 0.93 }}
      disabled={disabled}
      aria-pressed={value}
      {...rest}
    >
      <motion.span
        className="settings-toggle-thumb"
        animate={{ x: value ? 20 : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </motion.button>
  )
}
