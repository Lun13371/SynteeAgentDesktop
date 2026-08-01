import { createContext, useContext } from 'react'

// Контекст принудительного перемера рядов виртуализатора чата.
// Дефолтный measureElement (@tanstack/react-virtual) меряет ряд синхронно на
// монтировании и дальше ловит рост через ResizeObserver. Но высота ряда может
// измениться после монтирования в сценариях, где RO не гарантированно ловит
// финальное значение вовремя: framer-motion анимация height:0→'auto' у
// SystemDivider (RO ловит промежуточные высоты), асинхронный рендер Mermaid SVG,
// тяжёлый главный поток во время стрима. В таких случаях кэш высоты остаётся
// устаревшим (меньше реальной) → следующий ряд позиционируется по
// start_prev + staleSize_prev и налезает на предыдущий. Перезаход в чат
// пересоздаёт виртуализатор с пустым кэшем → всё норм (поэтому баг «рандомный,
// чинится перезаходом»).
//
// requestRemeasure() дёргает virtualizer.resizeItem(idx, realHeight) для всех
// смонтированных рядов (их немного — только overscan) → кэш высот
// синхронизируется с реальным DOM, ряды перепозиционируются. Визуально ноль:
// меняется только位置/высота в кэше виртуализатора.
export type RemeasureFn = () => void

export const ChatRemeasureContext = createContext<RemeasureFn | null>(null)

// Возвращает функцию перемера или null (если вне провайдера — например, в
// превью/сайдчате без виртуализатора). Компоненты-листья (MermaidBlock,
// SystemDivider) вызывают её по факту дорисовки контента.
export function useChatRemeasure(): RemeasureFn | null {
  return useContext(ChatRemeasureContext)
}
