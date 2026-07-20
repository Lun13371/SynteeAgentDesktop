import { useState, useEffect } from 'react'
import type { BrandLogo } from '../../../utils/modelFormat'
import './BrandAvatar.css'

interface BrandAvatarProps {
  logo: BrandLogo | null
  /** Цвет фолбэк-точки, когда логотипа нет (getProviderColor). */
  fallbackColor: string
  size?: number
  className?: string
}

/**
 * Рендерит либо SVG-логотип бренда, либо цветную точку-фолбэк.
 * НЕ вкладывает <img> внутрь точки — раньше это давало обрезанный
 * "полосатый" вид, потому что точка была 7-8px с border-radius:50%,
 * а логотип 14-16px внутри неё.
 *
 * Для однотонных SVG (fill="currentColor") логотип рисуется через
 * CSS mask-image + background-color, а не <img> — иначе currentColor
 * не наследует цвет страницы и рисуется чёрным силуэтом, невидимым
 * на тёмном фоне.
 */
export default function BrandAvatar({ logo, fallbackColor, size = 16, className }: BrandAvatarProps) {
  // Если <img> не смог загрузить logo.url (битая ссылка/провайдер iconUrl
  // недоступен) — откатываемся на цветную точку вместо нативной иконки
  // "broken image".
  const [imgFailed, setImgFailed] = useState(false)
  useEffect(() => { setImgFailed(false) }, [logo?.url])

  if (!logo || (imgFailed && !logo.mono)) {
    return (
      <span
        className={`brand-avatar brand-avatar--dot ${className ?? ''}`}
        style={{ width: size * 0.45, height: size * 0.45, background: fallbackColor }}
      />
    )
  }

  if (logo.mono) {
    // Vite инлайнит SVG как data:-URI с ЛИТЕРАЛЬНЫМИ одиночными кавычками
    // (fill='currentColor', не %27) и не экранирует их. Непроцитированный
    // CSS url-token обрывается на первой ' — из-за этого mask-image не
    // применялась вообще, и вместо иконки рисовался сплошной background
    // (белый круг). Оборачиваем URL в двойные кавычки, чтобы ' внутри
    // data-URI не ломала парсинг токена.
    return (
      <span
        className={`brand-avatar brand-avatar--mono ${className ?? ''}`}
        style={{
          width: size,
          height: size,
          maskImage: `url("${logo.url}")`,
          WebkitMaskImage: `url("${logo.url}")`,
        }}
      />
    )
  }

  return (
    <img
      src={logo.url}
      alt=""
      className={`brand-avatar brand-avatar--img ${className ?? ''}`}
      style={{ width: size, height: size }}
      onError={() => setImgFailed(true)}
    />
  )
}
