import { useMemo, useRef } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useVirtualizer } from '@tanstack/react-virtual'
import './CodePreview.css'

export function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    css: 'css', scss: 'scss', less: 'css',
    html: 'html', xml: 'xml', svg: 'xml',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    md: 'markdown', sql: 'sql', graphql: 'graphql',
    env: 'bash', dockerfile: 'docker',
    vue: 'markup', svelte: 'markup',
  }
  return map[ext] || 'text'
}

interface CodePreviewProps {
  content: string
  language?: string
  path?: string
  showLineNumbers?: boolean
  maxHeight?: number | string
  truncated?: boolean
  totalSize?: number
  truncatedReason?: string
}

// Prism токенизирует ВЕСЬ контент синхронно. Для файлов >300 строк это
// фризит UI. Порог: до 300 строк — Prism с подсветкой, выше — виртуализированный
// plain text (рендерим только видимые строки, как VSCode).
const PRISM_MAX_LINES = 300
const LINE_HEIGHT = 18

export default function CodePreview({
  content,
  language,
  path,
  showLineNumbers,
  maxHeight = '100%',
  truncated,
  truncatedReason,
}: CodePreviewProps) {
  const lang = language ?? (path ? getLanguage(path) : 'text')
  const lines = useMemo(() => content.split('\n'), [content])
  const lineCount = lines.length
  const showLines = showLineNumbers ?? lineCount > 3
  const usePrism = lineCount <= PRISM_MAX_LINES

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: lineCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    overscan: 12,
  })

  if (usePrism) {
    return (
      <div className="code-preview">
        <SyntaxHighlighter
          language={lang}
          style={oneDark}
          customStyle={{
            margin: 0,
            borderRadius: 8,
            fontSize: 12,
            maxHeight: maxHeight,
            overflow: 'auto',
            background: 'transparent',
          }}
          showLineNumbers={showLines}
          wrapLongLines={false}
        >
          {content}
        </SyntaxHighlighter>
        {truncated && (
          <div className="code-preview__truncated">
            {truncatedReason ?? 'Файл обрезан — показана только часть содержимого'}
          </div>
        )}
      </div>
    )
  }

  // Виртуализированный plain text — рендерим только видимые строки.
  const virtualItems = virtualizer.getVirtualItems()

  return (
    <div className="code-preview">
      <div ref={scrollRef} className="code-preview__scroll" style={{ maxHeight: maxHeight }}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map(vi => {
            const line = lines[vi.index]
            return (
              <div
                key={vi.index}
                className="code-preview__vline"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  transform: `translateY(${vi.start}px)`,
                  width: '100%',
                  height: vi.size,
                }}
              >
                {showLines && <span className="code-preview__vnum">{vi.index + 1}</span>}
                <span className="code-preview__vtext">{line}</span>
              </div>
            )
          })}
        </div>
      </div>
      {truncated && (
        <div className="code-preview__truncated">
          {truncatedReason ?? 'Файл обрезан — показана только часть содержимого'}
        </div>
      )}
    </div>
  )
}
