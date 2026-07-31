import { useEffect, useState } from 'react'
import {
  applyAccentToDOM,
  applyCustomThemeToDOM,
  applyFontToDOM,
  applyGlassToDOM,
  applyGradientAccentToDOM,
} from '../../App'
import type { CustomTheme } from '../../../../shared/types'
import TrayMenuPage from './TrayMenuPage'

/**
 * Лёгкая обёртка для окна трей-меню (роут #/tray-menu).
 *
 * НЕ рендерит полный <App/> — иначе в этом окне запустились бы
 * messenger WS, gateway polling, billing polling, chat preload и т.д.
 * (существующая проблема Spotlight/Voice/Overlay, которые грузят
 * весь App). Здесь применяем только визуальные настройки (тема,
 * accent, glass, шрифт) и рендерим саму карточку меню.
 *
 * Хелперы apply* переиспользуются из App.tsx (DRY): это чистые
 * DOM-мутации над CSS-переменными, без побочных эффектов.
 */
export default function TrayMenuApp() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const apply = async () => {
      try {
        const [theme, accentColor, glassBlur, fontFamily, accentGradient,
          customThemes, activeCustomThemeId] = await Promise.all([
          window.syntee.settings.get('theme'),
          window.syntee.settings.get('accentColor'),
          window.syntee.settings.get('glassBlur'),
          window.syntee.settings.get('fontFamily'),
          window.syntee.settings.get('accentGradient'),
          window.syntee.settings.get('customThemes'),
          window.syntee.settings.get('activeCustomThemeId'),
        ])

        if (cancelled) return

        const root = document.documentElement
        root.setAttribute('data-theme', (theme as string) || 'dark')

        if (fontFamily) applyFontToDOM(fontFamily as string)

        // Кастомная тема — инжектит CSS-переменные через style-элемент.
        if (theme === 'custom' && activeCustomThemeId) {
          const ct = (customThemes as CustomTheme[] | undefined)?.find(t => t.id === activeCustomThemeId)
          if (ct) applyCustomThemeToDOM(ct)
        } else {
          applyCustomThemeToDOM(null)
        }

        if (accentColor) applyAccentToDOM(accentColor as string)
        if (typeof glassBlur === 'number') applyGlassToDOM(glassBlur)
        if (accentGradient) {
          const ag = accentGradient as { enabled: boolean; color2: string; angle: number }
          applyGradientAccentToDOM(ag.enabled, ag.color2, ag.angle, (accentColor as string) || '#ffffff')
        }
      } catch {
        // ok — меню отрисуется на дефолтной :root теме
      } finally {
        if (!cancelled) setReady(true)
      }
    }
    apply()
    return () => { cancelled = true }
  }, [])

  if (!ready) return null
  return <TrayMenuPage />
}
