// ── Web scraping & image search — полностью бесплатно, без API-ключей ────
//
// fetch_page: URL → чистый markdown/текст (Jina Reader рендерит JS, fallback —
//   прямой fetch с браузерными заголовками + регэксп-чистка HTML).
// search_images: запрос → список картинок (DuckDuckGo Images, без ключа).

import type { ToolResult } from './_shared'

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ru;q=0.8',
}

// ── fetch_page ────────────────────────────────────────────────────────────

/**
 * Скачать веб-страницу и вернуть её содержимое в чистом виде (markdown/текст).
 * Приоритет 1: Jina Reader (https://r.jina.ai/<url>) — рендерит JS, отдаёт
 *   markdown. Бесплатно без ключа (~20 RPM с IP).
 * Приоритет 2: прямой fetch с браузерными заголовками + регэксп-чистка HTML.
 */
export async function fetchPage(url: string): Promise<ToolResult> {
  if (!url) return { success: false, output: '', error: 'url is required' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { success: false, output: '', error: `Invalid URL: ${url}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { success: false, output: '', error: `Only http/https supported, got: ${parsed.protocol}` }
  }

  // 1) Jina Reader — рендерит JS, отдаёт markdown
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { 'X-Return-Format': 'markdown', ...BROWSER_HEADERS },
      signal: AbortSignal.timeout(25000),
    })
    if (res.ok) {
      const md = await res.text()
      if (md.length > 200) {
        const trimmed = md.slice(0, 30000)
        return {
          success: true,
          output:
            trimmed.length < md.length
              ? `${trimmed}\n\n...[truncated ${md.length - 30000} chars]`
              : trimmed,
        }
      }
    }
  } catch {
    /* fallthrough to local fetch */
  }

  // 2) Fallback: прямой fetch + чистка HTML
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(20000),
    })

    const html = await res.text()

    // Детект бот-защиты — агенту нужна понятная ошибка, а не заглушка
    if (
      res.status === 403 ||
      /just a moment|cf-browser-verification|enable javascript and cookies|cf-challenge/i.test(html)
    ) {
      return {
        success: false,
        output: '',
        error:
          'Site is protected by bot detection (Cloudflare or similar). Jina Reader failed and direct fetch was blocked. Try search_web for this info instead.',
      }
    }

    if (!res.ok) {
      return { success: false, output: '', error: `HTTP ${res.status} ${res.statusText}` }
    }

    const text = cleanHtml(html)
    return {
      success: true,
      output: `[Page: ${url}]\n\n${text.slice(0, 30000)}${text.length > 30000 ? `\n\n...[truncated ${text.length - 30000} chars]` : ''}`,
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'fetch_page timed out (20s). Try again later.' }
    }
    return { success: false, output: '', error: `fetch_page failed: ${e.message}` }
  }
}

/** Вырезает script/style/nav/header/footer, снимает теги, декодирует сущности. */
function cleanHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|nav|header|footer|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|article|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── search_images ─────────────────────────────────────────────────────────

interface DDGImageResult {
  title: string
  image: string
  thumbnail: string
  url: string
  width: number
  height: number
  source: string
}

/**
 * Поиск картинок через DuckDuckGo Images (без API-ключа).
 * Шаг 1: получаем vqd-токен со страницы поиска.
 * Шаг 2: дёргаем i.js — JSON с прямыми URL картинок, тумбнейлами, размерами.
 */
export async function searchImages(query: string): Promise<ToolResult> {
  if (!query) return { success: false, output: '', error: 'query is required' }

  try {
    // Шаг 1: vqd-токен
    const r1 = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10000) },
    )
    const html = await r1.text()
    const vqd =
      html.match(/vqd=([\d-]+)[&"']/)?.[1] ?? html.match(/vqd="?([\d-]+)"?/)?.[1]
    if (!vqd) {
      return {
        success: false,
        output: '',
        error: 'Could not get DuckDuckGo search token. Try again later or refine the query.',
      }
    }

    // Шаг 2: JSON с картинками
    const r2 = await fetch(
      `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`,
      {
        headers: {
          ...BROWSER_HEADERS,
          Referer: 'https://duckduckgo.com/',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      },
    )
    if (!r2.ok) {
      return { success: false, output: '', error: `DuckDuckGo images error: ${r2.status} ${r2.statusText}` }
    }

    const data = (await r2.json()) as { results?: DDGImageResult[] }
    const top = (data.results ?? []).slice(0, 10)
    if (!top.length) {
      return { success: true, output: `No images found for "${query}".` }
    }

    const formatted = top
      .map(
        (r, i) =>
          `[${i + 1}] ${r.title}\nImage: ${r.image}\nThumbnail: ${r.thumbnail}\nPage: ${r.url}\nSize: ${r.width}x${r.height} (${r.source})`,
      )
      .join('\n\n')

    return {
      success: true,
      output: `Image search results for "${query}":\n\n${formatted}`,
    }
  } catch (e: any) {
    if (e.name === 'AbortError') {
      return { success: false, output: '', error: 'search_images timed out. Try again later.' }
    }
    return { success: false, output: '', error: `search_images failed: ${e.message}` }
  }
}
