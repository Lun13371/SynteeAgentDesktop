import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync, renameSync } from 'fs'
import { get } from 'https'
import { totalmem } from 'os'
import { log } from '../../core/logger'

export type ModelSize = '1.2B' | '1B' | '0.8B'

export interface ModelInfo {
  size: ModelSize
  fileName: string
  url: string
  expectedBytes: number
  quant: string
  label: string
}

const MODELS: Record<ModelSize, ModelInfo> = {
  '1.2B': {
    size: '1.2B',
    fileName: 'LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    url: 'https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
    expectedBytes: 731_000_000,
    quant: 'Q4_K_M',
    label: 'LFM2.5-1.2B (Liquid AI, newest, best-in-class)',
  },
  '1B': {
    size: '1B',
    fileName: 'gemma-3-1b-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/gemma-3-1b-it-Q4_K_M.gguf',
    expectedBytes: 810_000_000,
    quant: 'Q4_K_M',
    label: 'Gemma 3 1B (IFEval 80%, proven)',
  },
  '0.8B': {
    size: '0.8B',
    fileName: 'Qwen_Qwen3.5-0.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/bartowski/Qwen_Qwen3.5-0.8B-GGUF/resolve/main/Qwen_Qwen3.5-0.8B-Q4_K_M.gguf',
    expectedBytes: 580_000_000,
    quant: 'Q4_K_M',
    label: 'Qwen3.5-0.8B (ultra-light, 580 MB)',
  },
}

export function detectModelSize(): ModelSize {
  const ram = totalmem()
  if (ram < 6 * 1024 * 1024 * 1024) return '0.8B'
  return '1.2B'
}

export function getModelsDir(): string {
  const dir = join(app.getPath('userData'), 'assistants', 'models')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getModelPath(size: ModelSize): string {
  return join(getModelsDir(), MODELS[size].fileName)
}

export function isModelDownloaded(size: ModelSize): boolean {
  const p = getModelPath(size)
  if (!existsSync(p)) return false
  try {
    const st = statSync(p)
    return st.size > MODELS[size].expectedBytes * 0.9
  } catch { return false }
}

export type DownloadProgress = { phase: 'downloading' | 'done' | 'error'; percent: number; bytes: number; error?: string }

export function downloadModel(size: ModelSize, onProgress: (p: DownloadProgress) => void): Promise<string> {
  const info = MODELS[size]
  const dest = getModelPath(size)
  if (isModelDownloaded(size)) {
    onProgress({ phase: 'done', percent: 100, bytes: statSync(dest).size })
    return Promise.resolve(dest)
  }

  return new Promise((resolve, reject) => {
    const tmp = dest + '.tmp'
    const file = createWriteStream(tmp)
    let received = 0

    const request = (url: string, redirects: number) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return }
      get(url, { headers: { 'User-Agent': 'SynteeHelper/1.0' } }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          request(res.headers.location, redirects + 1)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10) || info.expectedBytes
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          file.write(chunk)
          onProgress({ phase: 'downloading', percent: Math.min(99, Math.round(received / total * 100)), bytes: received })
        })
        res.on('end', () => {
          file.end(() => {
            try {
              if (existsSync(dest)) unlinkSync(dest)
              renameSync(tmp, dest)
              onProgress({ phase: 'done', percent: 100, bytes: received })
              log('[ModelManager] downloaded %s (%d bytes)', info.fileName, received)
              resolve(dest)
            } catch (e) { reject(e) }
          })
        })
        res.on('error', (e) => { file.end(); reject(e) })
      }).on('error', (e) => { file.end(); reject(e) })
    }

    request(info.url, 0)
  })
}

export function deleteModel(size: ModelSize): void {
  const p = getModelPath(size)
  if (existsSync(p)) {
    try { unlinkSync(p) } catch (e) { log('[ModelManager] delete failed: %s', (e as Error).message) }
  }
}

export function getModelInfo(size: ModelSize): ModelInfo {
  return MODELS[size]
}