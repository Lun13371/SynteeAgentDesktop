/**
 * debug-stream-test.ts
 * Временный IPC для диагностики reasoning токенов.
 * Вызывается из renderer через window.syntee.debug.streamTest()
 * Результат виден в DevTools консоли renderer-а.
 */
import { ipcMain, BrowserWindow } from 'electron'
import * as Store from 'electron-store'

export function registerDebugIPC(store: Store): void {
  // Открыть DevTools для текущего окна
  ipcMain.handle('debug:open-devtools', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win) win.webContents.openDevTools({ mode: 'detach' })
  })
  ipcMain.handle('debug:stream-test', async () => {
    const providers = (store.get('providers') as Array<{
      name: string; baseUrl: string; apiKey: string
    }>) || []

    const results: Record<string, unknown> = {}

    const tests = [
      { providerName: 'OnlySQ',  model: 'deepseek-r1' },
      { providerName: 'VoidAI',  model: 'glm-5' },
      { providerName: 'OnlySQ',  model: 'deepseek-r1' },
    ]

    for (const t of tests) {
      const provider = providers.find(p =>
        p.name.toLowerCase().includes(t.providerName.toLowerCase())
      )
      if (!provider) {
        results[`${t.providerName}/${t.model}`] = 'provider not found'
        continue
      }

      try {
        const chunks = await doStreamTest(provider.baseUrl, provider.apiKey, t.model)
        results[`${t.providerName}/${t.model}`] = chunks
      } catch (e: unknown) {
        results[`${t.providerName}/${t.model}`] = String(e)
      }
    }

    return results
  })
}

async function doStreamTest(
  baseUrl: string,
  apiKey: string,
  model: string
): Promise<unknown[]> {
  const https = await import('https')
  const http  = await import('http')
  const { URL } = await import('url')

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: 'Сколько 7*8? Коротко.' }],
      max_tokens: 150,
    })

    const parsed = new URL(baseUrl + '/chat/completions')
    const lib    = parsed.protocol === 'https:' ? https : http

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'text/event-stream',
      },
    }, (res) => {
      const seen: unknown[] = []
      const seenKeys = new Set<string>()
      let buf = ''
      let count = 0

      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { seen.push('[DONE]'); continue }
          try {
            const j     = JSON.parse(raw)
            const delta = j.choices?.[0]?.delta ?? {}
            const keys  = Object.keys(delta).sort().join(',')
            count++

            if (!seenKeys.has(keys) || count <= 5) {
              seenKeys.add(keys)
              const entry: Record<string, unknown> = { chunk: count, keys: Object.keys(delta) }
              for (const [k, v] of Object.entries(delta)) {
                entry[k] = typeof v === 'string' ? v.slice(0, 200) : v
              }
              seen.push(entry)
            }
          } catch {}
        }
      })

      res.on('end', () => resolve(seen))
      res.on('error', reject)
    })

    req.on('error', reject)
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}
