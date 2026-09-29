// Загрузчик vendored нативного аудио-модуля (WASAPI loopback, N-API v8).
//
// Бинарник лежит в resources/native/NativeAudioSDK-<platform>-<arch>.node и
// коммитится в git — npm-пакет в рантайме не нужен, ничего не собирается и
// не докачивается. Источник бинарника: Native-Recorder-NodeJS v1.2.0 (MIT),
// https://github.com/Yidadaa/Native-Recorder-NodeJS — prebuilt NAPI-модуль,
// ABI-стабильный, работает и в Node, и в Electron без пересборки.
//
// Возможности: перечисление устройств, формат устройства и захват PCM
// (16-bit) с ЛЮБОГО устройства вывода — в отличие от Chromium loopback,
// который умеет только устройство по умолчанию.
import { app } from 'electron'
import { join } from 'path'

export interface NativeAudioDevice {
  id: string
  name: string
  type: 'input' | 'output'
  isDefault: boolean
}

export interface NativeAudioFormat {
  sampleRate: number
  channels: number
  bitDepth: number
  rawBitDepth: number
}

export interface AudioControllerInstance {
  start(
    config: { deviceType: 'input' | 'output'; deviceId: string },
    callback: (error: Error | null, data: Buffer | null) => void
  ): void
  stop(): void
}

export interface AudioControllerStatic {
  new (): AudioControllerInstance
  getDevices(): NativeAudioDevice[]
  getDeviceFormat(deviceId: string): NativeAudioFormat
}

let cached: AudioControllerStatic | null = null

/** Загружает нативный модуль (лениво, с кэшем). Бросает понятную ошибку, если бинарника нет. */
export function loadNativeAudio(): AudioControllerStatic {
  if (cached) return cached
  const fileName = `NativeAudioSDK-${process.platform}-${process.arch}.node`
  // dev: <project>/resources/native/...; packaged: <resourcesPath>/native/... (extraResources)
  const devPath = join(app.getAppPath(), 'resources', 'native', fileName)
  const prodPath = join(process.resourcesPath, 'native', fileName)
  const binaryPath = app.isPackaged ? prodPath : devPath
  try {
    // Динамический require по вычисляемому пути — rollup не может зарезолвить
    // его статически и оставляет как есть (CJS-выход main-бандла).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bindings = require(binaryPath) as { AudioController?: AudioControllerStatic }
    if (!bindings?.AudioController) {
      throw new Error('AudioController не найден в модуле')
    }
    cached = bindings.AudioController
    return cached
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Нативный аудио-модуль не загрузился (${binaryPath}): ${message}`)
  }
}
