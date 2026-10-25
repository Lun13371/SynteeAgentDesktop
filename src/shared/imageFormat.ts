/**
 * Image format sniffing, hard limits and token cost — единый источник правды
 * для всех путей, которые превращают БАЙТЫ ФАЙЛА в ВХОД МОДЕЛИ.
 *
 * Зачем: расширение — это подсказка, а не доказательство. Файл с именем
 * `*.png` может быть бинарём, архивом, скриптом или текстом. Раньше тип
 * определялся ТОЛЬКО по расширению (`mimeFromExt`), поэтому такой файл
 * целиком кодировался в base64 и уходил в контекст как «картинка»:
 *   • провайдер отвечал 400/413 → чат ломался;
 *   • payload раздувался на мегабайты, а подсчёт токенов его не видел
 *     (учитывались только text-парты) → контекст-бар и аварийный клапан
 *     молчали, пока запрос не начинал падать.
 *
 * Теперь перед отправкой проверяются реальные magic bytes и реальные размеры
 * в пикселях, а лимиты (байты / пиксели / сторона / бюджет на запрос) лежат
 * здесь — одни и те же для analyze_image, вложений и восстановления истории.
 *
 * Модуль renderer-safe: никаких node-импортов, работает на Uint8Array.
 */

/** MIME, которые реально принимают vision-модели ([OI]/Anthropic/Gemini). */
export type RasterMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'

const SUPPORTED_MIMES: ReadonlySet<string> = new Set<RasterMime>([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

/** Потолок на один файл, который мы готовы отправить как пиксели.
 *  3.5 МБ → ~4.7 МБ base64, что укладывается в 5 МБ на изображение у Anthropic. */
export const MAX_IMAGE_FILE_BYTES = 3.5 * 1024 * 1024
/** Бюджет на ВСЕ пиксели одного запроса (base64 растёт на 4/3). */
export const MAX_IMAGE_REQUEST_BYTES = 12 * 1024 * 1024
/** Потолок по площади: 20 МБ PNG легко оказывается 10000×9000 px. */
export const MAX_IMAGE_PIXELS = 32 * 1000 * 1000
/** Потолок по стороне, когда изображение в запросе одно (Anthropic: 8000px). */
export const MAX_IMAGE_SIDE_SINGLE = 8000
/** Потолок по стороне, когда изображений несколько (Anthropic: 2000px). */
export const MAX_IMAGE_SIDE_SHARED = 2000
/** Совместимость: максимальная сторона по умолчанию для одиночного изображения. */
export const MAX_IMAGE_SIDE = MAX_IMAGE_SIDE_SINGLE
/** Сколько картинок максимум в одном раунде / одном сообщении с вложениями. */
export const MAX_IMAGES_PER_ROUND = 6
/** Сколько картинок максимум переподставляем из истории чата. */
export const MAX_IMAGES_IN_HISTORY = 3
/** Бюджет base64 для пикселей, восстановленных из истории. */
export const MAX_HISTORY_IMAGE_BYTES = 8 * 1024 * 1024
/**
 * Цена одного изображения в токенах для оценки контекста.
 * [OI] high detail упирается в ~1.1k токенов на большое изображение;
 * Anthropic считает (w*h)/750 — фиксированная цена чуть выше типичной,
 * чтобы клапан срабатывал ДО 413, а не после.
 */
export const IMAGE_TOKEN_COST = 1100

export interface ImageSniff {
  /** Реальный тип по magic bytes; null — это не изображение. */
  mime: string | null
  /** true — байты можно отправлять в vision-модель как есть. */
  supported: boolean
  width: number | null
  height: number | null
}

export interface ImageInspection extends ImageSniff {
  bytes: number
  /** true — содержимое похоже на текст (файл с расширением картинки, но текст). */
  looksText: boolean
}

function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
}

function u32le(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0
}

function u32be(b: Uint8Array, i: number): number {
  return (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0
}

function ascii(b: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end && i < b.length; i++) out += String.fromCharCode(b[i])
  return out
}

/** JPEG не хранит размер в заголовке — идём по сегментам до SOFn. */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue }
    const marker = b[i + 1]
    // Padding / standalone-маркеры без длины сегмента.
    if (marker === 0xff) { i++; continue }
    if (marker === 0x01 || marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = u16be(b, i + 2)
    if (len < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) }
    }
    i += 2 + len
  }
  return null
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null
  const fourcc = ascii(b, 12, 16)
  if (fourcc === 'VP8 ') {
    // Lossy: 3-byte frame tag, 3-byte start code 0x9d 0x01 0x2a.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (fourcc === 'VP8L') {
    if (b[20] !== 0x2f) return null
    // 14 бит width-1, затем 14 бит height-1 (LSB-first bitstream).
    const width = 1 + (b[21] | ((b[22] & 0x3f) << 8))
    const height = 1 + (((b[22] >> 6) & 0x03) | (b[23] << 2) | ((b[24] & 0x0f) << 10))
    return { width, height }
  }
  if (fourcc === 'VP8X') {
    return { width: 1 + u32le(b, 24) % 0x1000000, height: 1 + u32le(b, 27) % 0x1000000 }
  }
  return null
}

/** Похоже ли содержимое на текст (нет NUL, печатных байтов большинство). */
function detectText(b: Uint8Array): boolean {
  const limit = Math.min(b.length, 512)
  if (limit === 0) return false
  let printable = 0
  for (let i = 0; i < limit; i++) {
    const c = b[i]
    if (c === 0) return false
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 0xc0) printable++
  }
  return printable / limit > 0.9
}

/** Определяет реальный формат по первым байтам. Никогда не бросает. */
export function sniffImage(b: Uint8Array): ImageSniff {
  const mimeOf = (mime: string, width: number | null = null, height: number | null = null): ImageSniff =>
    ({ mime, supported: SUPPORTED_MIMES.has(mime), width, height })

  if (b.length >= 24 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    // IHDR обязан быть первым чанком: длина(4) + 'IHDR'(4) + width(4) + height(4).
    if (ascii(b, 12, 16) === 'IHDR') return mimeOf('image/png', u32be(b, 16), u32be(b, 20))
    return mimeOf('image/png')
  }

  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b)
    return mimeOf('image/jpeg', size?.width ?? null, size?.height ?? null)
  }

  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') {
    return mimeOf('image/gif', u16le(b, 6), u16le(b, 8))
  }

  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') {
    const size = webpSize(b)
    return mimeOf('image/webp', size?.width ?? null, size?.height ?? null)
  }

  if (b.length >= 26 && ascii(b, 0, 2) === 'BM') {
    const dib = u32le(b, 14)
    if (dib >= 12) {
      return mimeOf('image/bmp', Math.abs(u32le(b, 18) | 0), Math.abs(u32le(b, 22) | 0))
    }
    return mimeOf('image/bmp')
  }

  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02) && b[3] === 0x00) {
    return mimeOf('image/x-icon')
  }

  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12)
    if (brand === 'avif' || brand === 'avis') return mimeOf('image/avif')
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'mif1') return mimeOf('image/heic')
  }

  if (b.length >= 4 &&
      ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
       (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) {
    return mimeOf('image/tiff')
  }

  // SVG — текстовый формат: ищем корневой тег в первых байтах.
  const head = ascii(b, 0, Math.min(b.length, 1024)).toLowerCase()
  if (head.includes('<svg')) return mimeOf('image/svg+xml')

  return { mime: null, supported: false, width: null, height: null }
}

/** Полная проверка байтов: формат, размеры, текстовость. */
export function inspectImage(b: Uint8Array): ImageInspection {
  const sniff = sniffImage(b)
  return { ...sniff, bytes: b.byteLength, looksText: sniff.mime === null && detectText(b) }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * Причина, по которой эти байты НЕЛЬЗЯ отправлять как пиксели.
 * null — можно.
 */
export function imageRejectionReason(
  info: ImageInspection,
  opts: { maxBytes?: number; maxSide?: number } = {},
): string | null {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_FILE_BYTES
  const maxSide = opts.maxSide ?? MAX_IMAGE_SIDE_SINGLE
  if (!info.mime) {
    return info.looksText
      ? 'File is not an image: its content is text, only the extension says otherwise'
      : 'File is not a raster image (magic bytes do not match PNG/JPEG/WebP/GIF)'
  }
  if (!info.supported) {
    return `${info.mime} is not accepted by vision models — convert it to PNG/JPEG/WebP/GIF first`
  }
  if (info.bytes > maxBytes) {
    return `Image is too large (${formatBytes(info.bytes)}, limit ${formatBytes(maxBytes)})`
  }
  if (info.width && info.height) {
    if (info.width > maxSide || info.height > maxSide) {
      return `Image dimensions are too large (${info.width}×${info.height} px, limit ${maxSide} px per side)`
    }
    if (info.width * info.height > MAX_IMAGE_PIXELS) {
      return `Image is too large (${info.width}×${info.height} px, limit ${MAX_IMAGE_PIXELS} px total)`
    }
  }
  return null
}

/** Описание картинки для бюджета запроса — без самих байтов. */
export interface ImagePayloadInfo {
  base64Bytes: number
  width: number | null
  height: number | null
}

export interface ImageRequestLimits {
  /** Сколько изображений допустимо в одном запросе. */
  maxImages: number
  /** Суммарный base64-бюджет запроса. */
  maxBytes: number
  /** Потолок стороны, когда изображение в запросе одно. */
  singleSide: number
  /** Потолок стороны, когда изображений несколько. */
  sharedSide: number
}

export const DEFAULT_IMAGE_REQUEST_LIMITS: ImageRequestLimits = {
  maxImages: MAX_IMAGES_PER_ROUND,
  maxBytes: MAX_IMAGE_REQUEST_BYTES,
  singleSide: MAX_IMAGE_SIDE_SINGLE,
  sharedSide: MAX_IMAGE_SIDE_SHARED,
}

/**
 * Бюджет пикселей ОДНОГО запроса к модели.
 *
 * Один экземпляр обслуживает и восстановление истории, и текущий раунд
 * тулов: провайдеры считают лимиты на весь запрос целиком.
 *
 * Два правила провайдеров, которые ломали чат:
 *  • Anthropic: ≤8 000 px по стороне для одного изображения, но ≤2 000 px,
 *    если изображений несколько — иначе 400 и сорванный прогон;
 *  • ≤5 МБ base64 на изображение и общий лимит на тело запроса.
 * Поэтому «большая» картинка может ехать только в одиночку, а свежие
 * результаты получают бюджет раньше старых (история гидратируется с конца).
 */
export class ImageRequestBudget {
  /** Сколько изображений уже принято. */
  images = 0
  /** Сколько base64-байт уже принято. */
  bytes = 0
  /** Принято ли изображение с длинной стороной больше sharedSide. */
  hasLarge = false
  /** Пути, уже приложенные в этом запросе — дедупликация одинаковых файлов. */
  readonly seen = new Set<string>()

  constructor(private readonly limits: ImageRequestLimits = DEFAULT_IMAGE_REQUEST_LIMITS) {}

  /** null — изображение можно приложить; строка — понятная причина отказа. */
  reject(info: ImagePayloadInfo, cap?: number): string | null {
    const side = Math.max(info.width ?? 0, info.height ?? 0)
    const maxImages = Math.min(this.limits.maxImages, cap ?? this.limits.maxImages)
    if (side > this.limits.singleSide) {
      return `image is ${side}px on its long side (limit ${this.limits.singleSide}px)`
    }
    const large = side > this.limits.sharedSide
    if (large) {
      if (this.images > 0) {
        return `a ${side}px image cannot share a request with other images (limit ${this.limits.sharedSide}px per side when several images are sent)`
      }
    } else {
      if (this.hasLarge) {
        return `this request already carries a larger image (limit ${this.limits.sharedSide}px per side when several images are sent)`
      }
      if (this.images >= maxImages) return `request already carries ${maxImages} image(s)`
    }
    if (this.bytes + info.base64Bytes > this.limits.maxBytes) {
      return `image budget for one request is exhausted (${formatBytes(this.limits.maxBytes)})`
    }
    return null
  }

  /** Учитывает принятое изображение. */
  accept(info: ImagePayloadInfo): void {
    this.images++
    this.bytes += info.base64Bytes
    if (Math.max(info.width ?? 0, info.height ?? 0) > this.limits.sharedSide) this.hasLarge = true
  }
}

/** Длина base64-payload в data:-URL (или в голой строке base64). */
export function imagePayloadBytes(url: string): number {
  const comma = url.indexOf(',')
  return comma === -1 ? url.length : url.length - comma - 1
}
