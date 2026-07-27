export type BgStyle =
  | 'particles'
  | 'matrix'
  | 'waves'
  | 'aurora'
  | 'fireflies'
  | 'starfield'
  | 'nebula'
  | 'topographic'
  | 'geometric'
  | 'none'

export type BgMessage =
  | { type: 'init'; canvas: OffscreenCanvas; style: BgStyle; color: string; w: number; h: number }
  | { type: 'setStyle'; style: BgStyle }
  | { type: 'setColor'; color: string }
  | { type: 'resize'; w: number; h: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'destroy' }

export const FALLBACK_RGB = '255, 255, 255'

export const SOFT_STYLES = new Set<BgStyle>([
  'aurora',
  'fireflies',
  'nebula',
  'waves',
  'topographic',
])
export const SOFT_FRAME_MS = 1000 / 20
export const SHARP_FRAME_MS = 1000 / 30
