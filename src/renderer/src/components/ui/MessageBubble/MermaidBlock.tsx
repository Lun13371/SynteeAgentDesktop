import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  themeVariables: {
    primaryColor: '#a855f7',
    primaryTextColor: '#e2e8f0',
    primaryBorderColor: '#3f3f46',
    lineColor: '#71717a',
    sectionBkgColor: '#18181b',
    background: '#09090b',
    mainBkg: '#18181b',
    nodeBorder: '#3f3f46',
    clusterBkg: '#18181b',
    titleColor: '#e2e8f0',
    edgeLabelBackground: '#18181b',
    fontFamily: 'inherit',
  },
  flowchart: { curve: 'basis', useMaxWidth: true },
})

let idCounter = 0

// Код считается "завершённым" если последняя непустая строка — не стрелка/разделитель
function isLikelyComplete(code: string): boolean {
  const trimmed = code.trim()
  if (!trimmed) return false
  // Минимум 2 строки
  const lines = trimmed.split('\n').filter(l => l.trim())
  if (lines.length < 2) return false
  const last = lines[lines.length - 1].trim()
  // Незавершённые признаки: строка заканчивается на --> или -- или |
  if (/-->$|--$|\|$|:$/.test(last)) return false
  return true
}

export default function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef(`mermaid-${++idCounter}`)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(0)  // версия — отменяем устаревшие рендеры

  useEffect(() => {
    // Не рендерим незавершённый код во время стриминга
    if (!isLikelyComplete(code)) return

    // Debounce 500мс — ждём паузы в стриминге
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      const version = ++activeRef.current
      try {
        // Уникальный id для каждого рендера чтобы избежать конфликтов
        const renderId = `${idRef.current}-${version}`
        const result = await mermaid.render(renderId, code)
        // Если за время рендера пришёл новый вызов — игнорируем
        if (version !== activeRef.current) return
        setError(null)
        setSvg(result.svg)
      } catch (e: unknown) {
        if (version !== activeRef.current) return
        const msg = e instanceof Error ? e.message : String(e)
        // Не показываем ошибки парсинга незавершённого кода
        if (msg.includes('Parse error') || msg.includes('Lexical error')) return
        setError(msg)
      }
    }, 500)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [code])

  if (error) {
    return (
      <div className="mermaid-error">
        <span>⚠ Ошибка диаграммы</span>
        <pre>{error}</pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="mermaid-block mermaid-block--loading">
        <span className="mermaid-dots">···</span>
      </div>
    )
  }

  return (
    <div
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
