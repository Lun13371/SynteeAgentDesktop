import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
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

export default function MermaidBlock({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [svg, setSvg] = useState<string>('')
  const id = useRef(`mermaid-${++idCounter}`)

  useEffect(() => {
    setError(null)
    mermaid.render(id.current, code)
      .then(({ svg }) => setSvg(svg))
      .catch(e => setError(String(e?.message || e)))
  }, [code])

  if (error) {
    return (
      <div className="mermaid-error">
        <span>⚠ Ошибка диаграммы:</span>
        <pre>{error}</pre>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      className="mermaid-block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
