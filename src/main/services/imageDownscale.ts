import { nativeImage } from 'electron'
import {
  MAX_IMAGE_FILE_BYTES, MAX_IMAGE_SIDE_SHARED, formatBytes, imageRejectionReason,
  inspectImage, type RasterMime,
} from '../../shared/imageFormat'

export interface NormalizedImage {
  bytes: Buffer
  mime: RasterMime
  ext: string
  width: number
  height: number
  downscaled: boolean
}

export type NormalizeResult =
  | { ok: true; image: NormalizedImage }
  | { ok: false; error: string }

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/**
 * Приводит картинку к виду, который реально принимают vision-модели:
 * растр PNG/JPEG/WebP/GIF, ≤2000 px по длинной стороне и ≤ лимита байт.
 *
 * Зачем: раньше файл уходил в модель как есть, поэтому 4K-скриншот (или
 * несколько картинок в одном запросе) приводили к 400 «image exceeds 5 MB»
 * / «dimensions exceed 2000px» или к 413 «request too large» — с сорванным
 * прогоном вместо ответа. Ресайз вместо отказа делает эти случаи рабочими.
 *
 * Electron (nativeImage) доступен только в main-процессе — там же живут
 * вложения, оверлей и скриншоты браузера. Анимированный GIF не перекодируем
 * (потеряли бы анимацию) — для него остаётся проверка размера.
 */
export function normalizeImageForVision(
  input: Buffer,
  opts: { maxSide?: number; maxBytes?: number } = {},
): NormalizeResult {
  const maxSide = opts.maxSide ?? MAX_IMAGE_SIDE_SHARED
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_FILE_BYTES

  const info = inspectImage(input)
  if (!info.mime) {
    return { ok: false, error: imageRejectionReason(info) ?? 'File is not a raster image (PNG/JPEG/WebP/GIF)' }
  }
  if (!info.supported) {
    return { ok: false, error: imageRejectionReason(info) ?? `${info.mime} is not accepted by vision models` }
  }

  const mime = info.mime as RasterMime
  const width = info.width ?? 0
  const height = info.height ?? 0
  const side = Math.max(width, height)
  if (input.byteLength <= maxBytes && side <= maxSide) {
    return { ok: true, image: { bytes: input, mime, ext: EXT_BY_MIME[mime] ?? '.png', width, height, downscaled: false } }
  }

  // Анимированный GIF ресайзом убивается — честнее отказать с понятной причиной.
  if (mime === 'image/gif') {
    return { ok: false, error: imageRejectionReason(info, { maxBytes, maxSide }) ?? 'GIF is too large' }
  }

  let image = nativeImage.createFromBuffer(input)
  if (image.isEmpty()) {
    return { ok: false, error: 'Cannot decode image data (corrupted or unsupported encoding)' }
  }
  const original = image.getSize()
  if (Math.max(original.width, original.height) > maxSide) {
    const scale = maxSide / Math.max(original.width, original.height)
    image = image.resize({
      width: Math.max(1, Math.round(original.width * scale)),
      height: Math.max(1, Math.round(original.height * scale)),
      quality: 'good',
    })
  }

  let bytes = image.toPNG()
  let outMime: RasterMime = 'image/png'
  for (let attempt = 0; attempt < 4 && bytes.byteLength > maxBytes; attempt++) {
    // PNG скриншотов тяжёлый: пробуем JPEG (альфа теряется — для фото и
    // скриншотов это приемлемо), затем уменьшаем ещё.
    const jpeg = image.toJPEG(82)
    if (jpeg.byteLength <= maxBytes) {
      bytes = jpeg
      outMime = 'image/jpeg'
      break
    }
    const size = image.getSize()
    const scale = Math.max(0.25, Math.sqrt(maxBytes / jpeg.byteLength) * 0.9)
    image = image.resize({
      width: Math.max(1, Math.floor(size.width * scale)),
      height: Math.max(1, Math.floor(size.height * scale)),
      quality: 'good',
    })
    bytes = image.toPNG()
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, error: `Image could not be reduced below ${formatBytes(maxBytes)} (got ${formatBytes(bytes.byteLength)})` }
  }

  const finalSize = image.getSize()
  return {
    ok: true,
    image: {
      bytes,
      mime: outMime,
      ext: EXT_BY_MIME[outMime] ?? '.png',
      width: finalSize.width,
      height: finalSize.height,
      downscaled: true,
    },
  }
}