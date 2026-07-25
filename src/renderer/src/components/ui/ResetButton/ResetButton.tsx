import { motion } from 'framer-motion'
import AppIcon from '../AppIcon/AppIcon'
import './ResetButton.css'

interface ResetButtonProps {
  current: unknown
  defaultValue: unknown
  onReset: () => void
  /** aria-label / tooltip override. По умолчанию «Восстановить по умолчанию». */
  label?: string
}

// Сравнение значений: для массивов/объектов — JSON.stringify, для примитивов — ===.
// Это правильно для наших настроек (числа, строки, булевы, массивы строк).
function isDefault(current: unknown, defaultValue: unknown): boolean {
  if (current === defaultValue) return true
  // NaN === NaN → false, но NaN едва ли встретится в настройках
  if (typeof current !== typeof defaultValue) return false
  if (current !== null && typeof current === 'object') {
    return JSON.stringify(current) === JSON.stringify(defaultValue)
  }
  return false
}

/**
 * Кнопка восстановления значения по умолчанию.
 * Рендерится ТОЛЬКО когда current ≠ defaultValue (для массивов/объектов —
 * глубокое сравнение через JSON.stringify). Когда значение = дефолту —
 * возвращает null, не занимая места в layout'е.
 *
 * Inline-размещение: small square button, hover → accent.
 */
export default function ResetButton({ current, defaultValue, onReset, label }: ResetButtonProps) {
  if (isDefault(current, defaultValue)) return null
  return (
    <motion.button
      type="button"
      className="reset-btn"
      onClick={onReset}
      title={label ?? 'Восстановить по умолчанию'}
      aria-label={label ?? 'Восстановить по умолчанию'}
      whileTap={{ scale: 0.85 }}
      whileHover={{ scale: 1.1 }}
    >
      <AppIcon name="rewind" size="xs" tone="muted" />
    </motion.button>
  )
}
