/**
 * Общая логика фильтрации моделей для пикеров (ModelSelector в чате,
 * ModelPicker в настройках): capability-фильтры (AND), фильтр по цене,
 * предикат «бесплатности» и иконки/подписи для UI.
 */
import type { ModelCapability, ModelMeta } from '../../../shared/types'
import type { IconName } from '../components/ui/AppIcon/AppIcon'
import { formatPrice } from './modelFormat'

/** Фильтр по цене. Пороги — по input-цене за 1M токенов (кумулятивные). */
export type PriceFilter = 'any' | 'free' | 'under1' | 'under10' | 'expensive'

/** Пилюли цены в UI (без 'any' — сброс фильтра = все модели). */
export const PRICE_FILTERS: Exclude<PriceFilter, 'any'>[] = ['free', 'under1', 'under10', 'expensive']

export const PRICE_FILTER_LABELS: Record<PriceFilter, string> = {
  any: 'Все',
  free: 'Бесплатно',
  under1: '≤ $1',
  under10: '≤ $10',
  expensive: '> $10',
}

/** Иконки capabilities для пилюль фильтров и мини-бейджей в строках моделей. */
export const CAP_ICONS: Record<ModelCapability, IconName> = {
  vision: 'eye',
  tools: 'wrench',
  reasoning: 'brain',
  code: 'code',
  embedding: 'database',
  tts: 'volume',
  stt: 'mic',
  image_gen: 'image',
}

/** Провайдеры, чьи модели всегда бесплатны (локальный инференс). */
const FREE_PROVIDER_IDS = new Set(['ollama'])

/**
 * true, если модель заведомо бесплатна: цены известны и равны нулю
 * (на уровне каталога models.dev это фиксирует hasPricing), либо это
 * локальный провайдер. Модели с НЕизвестной ценой (undefined) — не
 * бесплатные: они не попадают в фильтр «Бесплатно».
 */
export function isModelFree(m: ModelMeta): boolean {
  if (FREE_PROVIDER_IDS.has(m.providerId)) return true
  return m.inputPrice !== undefined && m.outputPrice !== undefined
    && m.inputPrice === 0 && m.outputPrice === 0
}

/** Эффективная цена для пороговых фильтров; undefined — цена неизвестна. */
function effectivePrice(m: ModelMeta): number | undefined {
  return m.inputPrice ?? m.outputPrice
}

export function matchesPriceFilter(m: ModelMeta, f: PriceFilter): boolean {
  if (f === 'any') return true
  if (f === 'free') return isModelFree(m)
  const p = effectivePrice(m)
  if (p === undefined) return false // цена неизвестна — видна только в 'any'
  if (f === 'under1') return p <= 1
  if (f === 'under10') return p <= 10
  if (f === 'expensive') return p > 10
  return true
}

/** AND-логика: модель должна иметь ВСЕ выбранные capabilities. */
export function matchesCaps(m: ModelMeta, caps: ModelCapability[]): boolean {
  return caps.every(c => m.capabilities.includes(c))
}

export interface ModelFilter {
  query: string
  caps: ModelCapability[]
  price: PriceFilter
}

/** true, если активен хоть один фильтр (кроме поиска). */
export function hasActiveFilters(f: ModelFilter): boolean {
  return f.caps.length > 0 || f.price !== 'any'
}

/**
 * Единый пайплайн фильтрации: поиск (имя/id/провайдер) → capabilities (AND)
 * → цена. Группировка/сортировка остаются на стороне пикеров.
 */
export function filterModels(models: ModelMeta[], f: ModelFilter): ModelMeta[] {
  let out = models
  const q = f.query.trim().toLowerCase()
  if (q) {
    out = out.filter(m =>
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.providerId.toLowerCase().includes(q)
    )
  }
  if (f.caps.length) out = out.filter(m => matchesCaps(m, f.caps))
  if (f.price !== 'any') out = out.filter(m => matchesPriceFilter(m, f.price))
  return out
}

/**
 * Подпись цены для тултипа. «Бесплатно» — только когда модель бесплатна
 * целиком (обе цены = 0), иначе обычный $-формат или «—» при неизвестной цене.
 */
export function tooltipPrice(m: ModelMeta, v?: number): string {
  if (isModelFree(m)) return 'Бесплатно'
  return formatPrice(v)
}
