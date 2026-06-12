import { motion, type HTMLMotionProps } from 'framer-motion'
import {
  Bot, Brain, Settings, User, Plus, Lock, Pin, Paperclip, Mic,
  SendHorizontal, Copy, Globe, FileText, Search, Sparkles, Calculator,
  Folder, Clipboard, Terminal, Monitor, Pencil, Check, X, AlertCircle,
  Eye, EyeOff, Palette, Link2, Database, Volume2, LoaderCircle, Minus,
  Shield, Info, RefreshCw, ChevronUp, ChevronDown, Trash2, Zap,
  Archive, ChevronRight, Filter, Clock,
  type LucideProps,
} from 'lucide-react'
import './AppIcon.css'

type IconComponent = (props: LucideProps) => JSX.Element

const ICONS = {
  bot: Bot, brain: Brain, settings: Settings, user: User, plus: Plus,
  lock: Lock, pin: Pin, paperclip: Paperclip, mic: Mic, send: SendHorizontal,
  copy: Copy, globe: Globe, fileText: FileText, search: Search,
  sparkles: Sparkles, calculator: Calculator, folder: Folder,
  clipboard: Clipboard, terminal: Terminal, monitor: Monitor, edit: Pencil,
  check: Check, x: X, alertCircle: AlertCircle, eye: Eye, eyeOff: EyeOff,
  palette: Palette, link: Link2, database: Database, volume: Volume2,
  loader: LoaderCircle, minus: Minus, shield: Shield, info: Info,
  refreshCw: RefreshCw, chevronUp: ChevronUp, chevronDown: ChevronDown,
  trash: Trash2, zap: Zap, archive: Archive, chevronRight: ChevronRight,
  filter: Filter, clock: Clock,
} satisfies Record<string, IconComponent>

export type IconName = keyof typeof ICONS
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'
export type IconTone = 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'danger'
export type IconAnimation = 'none' | 'spin' | 'pulse'

interface AppIconProps extends Omit<HTMLMotionProps<'span'>, 'children'> {
  name: IconName
  size?: IconSize
  tone?: IconTone
  animation?: IconAnimation
  strokeWidth?: number
}

export default function AppIcon({
  name,
  size = 'md',
  tone = 'default',
  animation = 'none',
  strokeWidth = 1.8,
  className,
  ...props
}: AppIconProps) {
  const Icon = ICONS[name]

  return (
    <motion.span
      className={[
        'app-icon',
        `app-icon--${size}`,
        `app-icon--${tone}`,
        animation !== 'none' ? `app-icon--${animation}` : '',
        className || '',
      ].filter(Boolean).join(' ')}
      aria-hidden="true"
      {...props}
    >
      <Icon size="100%" strokeWidth={strokeWidth} />
    </motion.span>
  )
}
