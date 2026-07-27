interface LogoProps {
  size?: number
  className?: string
}

/**
 * Логотип Syntee — закруглённый квадрат с буквой "S".
 *
 * Div-based (не SVG) чтобы background поддерживал CSS gradient:
 * использует var(--accent-bg) который становится linear-gradient(...)
 * при включённом gradient-accent. SVG fill="var(--accent-bg)" не работает
 * с CSS linear-gradient, поэтому div — единственный вариант.
 *
 * Пропорции как у favicon Syntee-Gateway (viewBox 0 0 32 32, rx=7, font-size=18).
 */
export default function Logo({ size = 32, className }: LogoProps) {
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: size * (7 / 32),
        background: 'var(--accent-bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        lineHeight: 1,
      }}
    >
      <span
        style={{
          fontFamily: 'system-ui, sans-serif',
          fontSize: size * (18 / 32),
          fontWeight: 700,
          color: 'var(--on-accent)',
          lineHeight: 1,
          userSelect: 'none',
        }}
      >
        S
      </span>
    </div>
  )
}
