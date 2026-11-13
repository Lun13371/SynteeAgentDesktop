import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, writeFileSync } from 'fs'
import { get } from 'https'
import AdmZip from 'adm-zip'
import { log } from '../../core/logger'

const BINARY_URL = 'https://github.com/ggml-org/llama.cpp/releases/download/b12360/llama-b12360-bin-win-cpu-x64.zip'
const BINARY_ZIP_NAME = 'llama-server-win-x64.zip'

export function getBinDir(): string {
  const dir = join(app.getPath('userData'), 'assistants', 'bin')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getLlamaServerPath(): string {
  return join(getBinDir(), 'llama-server.exe')
}

export function isBinaryReady(): boolean {
  return existsSync(getLlamaServerPath())
}

export type BinaryProgress = { phase: 'downloading' | 'extracting' | 'done' | 'error'; percent: number; error?: string }

export function downloadBinary(onProgress: (p: BinaryProgress) => void): Promise<string> {
  if (isBinaryReady()) {
    onProgress({ phase: 'done', percent: 100 })
    return Promise.resolve(getLlamaServerPath())
  }

  const zipPath = join(getBinDir(), BINARY_ZIP_NAME)
  log('[BinaryManager] starting download from %s', BINARY_URL)

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
                  writeFileSync(join(getBinDir(), baseName), data)
                  extracted++
                }
              }
              log('[BinaryManager] extracted %d files to %s', extracted, getBinDir())
              if (!isBinaryReady()) {
                const err = 'llama-server.exe not found in zip'
                onProgress({ phase: 'error', percent: 0, error: err })
                reject(new Error(err))
                return
              }
              onProgress({ phase: 'done', percent: 100 })
              resolve(getLlamaServerPath())
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
    download(BINARY_URL, 0)
  })
}