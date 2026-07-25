import type { ToolResult } from './_shared'

export async function searchWeb(query: string, apiKey?: string): Promise<ToolResult> {
  if (!apiKey) return { success: false, output: '', error: 'Нет Tavily API ключа. Добавьте в Настройки → Интеграции' }
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)  // 15с таймаут
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: 'basic' }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const data = await res.json() as { results: Array<{ title: string; url: string; content: string }> }
    const formatted = data.results.map((r, i) =>
      '[' + (i+1) + '] ' + r.title + '\nURL: ' + r.url + '\n' + r.content.slice(0, 300) + '...'
    ).join('\n\n')
    return { success: true, output: formatted }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'Веб-поиск превысил таймаут (15с). Попробуйте позже или уточните запрос.' }
    }
    return { success: false, output: '', error: e.message }
  }
}

// ── http_request — прямой HTTP-клиент без shell ──────────────────────────
export async function httpRequest(params: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  timeout?: number
}): Promise<ToolResult> {
  const { url: urlStr, method = 'GET', headers = {}, body, timeout = 30 } = params

  if (!urlStr) return { success: false, output: '', error: 'url is required' }

  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return { success: false, output: '', error: `Invalid URL: ${urlStr}` }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { success: false, output: '', error: `Only http/https supported, got: ${url.protocol}` }
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout * 1000)

    const fetchOpts: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    }
    if (body && method !== 'GET' && method !== 'HEAD') {
      fetchOpts.body = body
    }

    const res = await fetch(urlStr, fetchOpts)
    clearTimeout(timer)

    const status = res.status
    const resHeaders: Record<string, string> = {}
    res.headers.forEach((v, k) => { resHeaders[k] = v })

    let resBody: string
    const rawText = await res.text()

    // Обрезаем очень длинные ответы
    const maxChars = 8000
    if (rawText.length > maxChars) {
      resBody = rawText.slice(0, maxChars) + `\n\n...[обрезано ${rawText.length - maxChars} символов]`
    } else {
      resBody = rawText
    }

    const headerStr = Object.entries(resHeaders)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n')

    const output = [
      `[HTTP ${method} ${urlStr}]`,
      `Status: ${status} ${res.statusText}`,
      `Headers:`,
      headerStr,
      ``,
      `Body:`,
      resBody,
    ].join('\n')

    return { success: true, output }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: `Request timed out after ${timeout}s` }
    }
    return { success: false, output: '', error: e.message }
  }
}
