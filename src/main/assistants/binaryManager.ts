import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, writeFileSync } from 'fs'
import { get } from 'https'
import AdmZip from 'adm-zip'
import { log } from '../../core/logger'

/**
 * Две сборки llama.cpp из одного релиза:
 *  - `cpu`    — обычная, работает везде;
 *  - `vulkan` — с Vulkan-бэкендом: `--n-gpu-layers` уводит модель в VRAM
 *    любой DX12-карты (NVIDIA/AMD/Intel). CUDA не берём — он только NVIDIA.
 *
 * ⚠️ DLL у сборок конфликтуют по именам (ggml.dll и др.), поэтому cpu живёт
 * в `assistants/bin/` (как раньше — уже скачанное не перекачивается),
 * vulkan — в `assistants/bin-vulkan/`.
 */
export type LlamaFlavor = 'cpu' | 'vulkan'

const RELEASE_TAG = 'b12360'
const BINARY_URLS: Record<LlamaFlavor, string> = {
  cpu: `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE_TAG}/llama-${RELEASE_TAG}-bin-win-cpu-x64.zip`,
  vulkan: `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE_TAG}/llama-${RELEASE_TAG}-bin-win-vulkan-x64.zip`,
}
const BINARY_ZIP_NAMES: Record<LlamaFlavor, string> = {
  cpu: 'llama-server-win-x64.zip',
  vulkan: 'llama-server-win-vulkan-x64.zip',
}

function getBinDir(flavor: LlamaFlavor): string {
  const sub = flavor === 'vulkan' ? 'bin-vulkan' : 'bin'
  const dir = join(app.getPath('userData'), 'assistants', sub)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getLlamaServerPath(flavor: LlamaFlavor = 'cpu'): string {
  return join(getBinDir(flavor), 'llama-server.exe')
}

export function isBinaryReady(flavor: LlamaFlavor = 'cpu'): boolean {
  return existsSync(getLlamaServerPath(flavor))
}

export type BinaryProgress = { phase: 'downloading' | 'extracting' | 'done' | 'error'; percent: number; error?: string }

export function downloadBinary(flavor: LlamaFlavor, onProgress: (p: BinaryProgress) => void): Promise<string> {
  if (isBinaryReady(flavor)) {
    onProgress({ phase: 'done', percent: 100 })
    return Promise.resolve(getLlamaServerPath(flavor))
  }

  const zipPath = join(getBinDir(flavor), BINARY_ZIP_NAMES[flavor])
  log('[BinaryManager] starting %s download from %s', flavor, BINARY_URLS[flavor])

  return new Promise((resolve, reject) => {
    const download = (url: string, redirects: number) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return }
      get(url, { headers: { 'User-Agent': 'SynteeHelper/1.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          log('[BinaryManager] redirect → %s', res.headers.location.slice(0, 100))
          download(res.headers.location, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          const err = `HTTP ${res.statusCode} from GitHub`
          log('[BinaryManager] %s', err)
          onProgress({ phase: 'error', percent: 0, error: err })
          reject(new Error(err))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10) || 40_000_000
        let received = 0
        const file = createWriteStream(zipPath)
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          file.write(chunk)
          onProgress({ phase: 'downloading', percent: Math.min(90, Math.round(received / total * 90)) })
        })
        res.on('end', () => {
          file.end(() => {
            try {
              onProgress({ phase: 'extracting', percent: 92 })
              log('[BinaryManager] downloaded %d bytes, extracting…', received)
              const zip = new AdmZip(zipPath)
              const entries = zip.getEntries()
              let extracted = 0
              for (const entry of entries) {
                const baseName = entry.entryName.split('/').pop() ?? ''
                if (baseName === 'llama-server.exe' || baseName.endsWith('.dll')) {
                  const data = entry.getData()
                  writeFileSync(join(getBinDir(flavor), baseName), data)
                  extracted++
                }
              }
              log('[BinaryManager] extracted %d files to %s', extracted, getBinDir(flavor))
              if (!isBinaryReady(flavor)) {
                const err = 'llama-server.exe not found in zip'
                onProgress({ phase: 'error', percent: 0, error: err })
                reject(new Error(err))
                return
              }
              onProgress({ phase: 'done', percent: 100 })
              resolve(getLlamaServerPath(flavor))
            } catch (e) {
              log('[BinaryManager] extraction failed: %s', (e as Error).message)
              onProgress({ phase: 'error', percent: 0, error: (e as Error).message })
              reject(e)
            }
          })
        })
        res.on('error', (e) => { file.end(); reject(e) })
      }).on('error', (e) => {
        log('[BinaryManager] download error: %s', e.message)
        onProgress({ phase: 'error', percent: 0, error: e.message })
        reject(e)
      })
    }
    download(BINARY_URLS[flavor], 0)
  })
}
