import { useUIStore } from '../store/ui.store'
import { BUILTIN_THEMES } from './builtinThemes'

/**
 * Светлая ли активная тема.
 *
 * Нужно только там, где по теме выбирается палитра, которую нельзя выразить
 * CSS-переменными — подсветка кода (oneDark / oneLight). Все остальные цвета
 * берутся из CSS-переменных темы и в этой проверке не нуждаются.
 *
 * Учитывает и встроенные темы (по group), и кастомные (по base).
 */
export function useIsLightTheme(): boolean {
  return useUIStore(state => {
    // Кастомная тема влияет на палитру ТОЛЬКО когда она реально активна
    // (theme === 'custom'). Иначе остаётся activeCustomThemeId от прошлой
    // кастомной темы, и подсветка кода брала палитру oneLight на тёмной
    // встроенной теме (mocha/onedark/…) → код почти чёрный на тёмном фоне,
    // карточки тулов выглядели пустыми (видны только номера строк).
    if (state.theme === 'custom') {
      const custom = state.customThemes.find(theme => theme.id === state.activeCustomThemeId)
      if (custom) return custom.base === 'light'
    }
    const builtin = BUILTIN_THEMES.find(theme => theme.id === state.theme)
    return builtin?.group === 'light'
  })
}
