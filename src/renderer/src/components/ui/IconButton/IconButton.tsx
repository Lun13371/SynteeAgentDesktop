import { motion, type HTMLMotionProps } from 'framer-motion'
import AppIcon, { type IconAnimation, type IconName, type IconSize, type IconTone } from '../AppIcon/AppIcon'
import './IconButton.css'

interface IconButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  icon: IconName
  label: string
  size?: IconSize
  tone?: IconTone
  iconAnimation?: IconAnimation
  active?: boolean
  danger?: boolean
}

export default function IconButton({
  icon,
  label,
  size = 'sm',
  tone = 'default',
  iconAnimation = 'none',
  active = false,
  danger = false,
  className,
  ...props
}: IconButtonProps) {
  return (
    <motion.button
      type="button"
      className={[
        'icon-button',
        active ? 'icon-button--active' : '',
        danger ? 'icon-button--danger' : '',
        className || '',
      ].filter(Boolean).join(' ')}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.92 }}
      title={label}
      aria-label={label}
      {...props}
    >
      <AppIcon name={icon} size={size} tone={tone} animation={iconAnimation} />
    </motion.button>
  )
}
