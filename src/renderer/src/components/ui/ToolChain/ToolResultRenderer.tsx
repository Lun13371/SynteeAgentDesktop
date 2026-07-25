import { useState, memo } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { ToolStep } from './ToolChain'
import type { ToolOutputMode } from '../../../../../shared/types'
import './ToolResultRenderer.css'

// ── Утилиты ────────────────────────────────────────────────────────────────

function getLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    css: 'css', scss: 'scss', html: 'html', xml: 'xml',
    sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell',
    md: 'markdown', sql: 'sql', graphql: 'graphql',
    env: 'bash', dockerfile: 'docker',
  }
  return map[ext] || 'text'
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { text, truncated: false }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true }
}

function tryParseJSON(text: string): unknown | null {
  try { return JSON.parse(text) } catch { return null }
}

// ── Суб-рендеры ────────────────────────────────────────────────────────────

const CodeResult = memo(function CodeResult({ content, lang, maxLines }: { content: string; lang: string; maxLines: number }) {
  const { text, truncated } = truncateLines(content, maxLines)
  return (
    <div className="trr-code-wrap">
      <SyntaxHighlighter
        language={lang}
        style={oneDark}
        customStyle={{ margin: 0, borderRadius: 8, fontSize: 12, maxHeight: 400, overflow: 'auto' }}
        showLineNumbers={content.split('\n').length > 3}
      >
        {text}
      </SyntaxHighlighter>
      {truncated && <div className="trr-truncated">... обрезано ({content.split('\n').length} строк всего)</div>}
    </div>
  )
}, (prev, next) => prev.content === next.content && prev.lang === next.lang && prev.maxLines === next.maxLines)

const TerminalResult = memo(function TerminalResult({ content, maxLines }: { content: string; maxLines: number }) {
  const { text, truncated } = truncateLines(content.trim(), maxLines)
  return (
    <div className="trr-terminal">
      <pre className="trr-terminal-pre">{text}</pre>
      {truncated && <div className="trr-truncated">... обрезано ({content.split('\n').length} строк)</div>}
    </div>
  )
}, (prev, next) => prev.content === next.content && prev.maxLines === next.maxLines)

function FileListResult({ content }: { content: string }) {
  const lines = content.split('\n').filter(l => l.trim())
  return (
    <div className="trr-filelist">
      {lines.map((line, i) => {
        const isDir = line.endsWith('/') || line.endsWith('\\') || !line.includes('.')
        return (
          <div key={i} className="trr-filelist-item">
            <span className="trr-filelist-icon">{isDir ? '📁' : '📄'}</span>
            <span className="trr-filelist-name">{line.trim()}</span>
          </div>
        )
      })}
    </div>
  )
}

function WebSearchResult({ content }: { content: string }) {
  const parsed = tryParseJSON(content)
  if (Array.isArray(parsed)) {
    return (
      <div className="trr-search-results">
        {(parsed as Array<{ title?: string; url?: string; snippet?: string; content?: string }>).slice(0, 5).map((r, i) => (
          <div key={i} className="trr-search-card">
            {r.title && <div className="trr-search-title">{r.title}</div>}
            {r.url && <div className="trr-search-url">{r.url}</div>}
            {(r.snippet || r.content) && (
              <div className="trr-search-snippet">{String(r.snippet || r.content || '').slice(0, 200)}</div>
            )}
          </div>
        ))}
      </div>
    )
  }
  // Plain text fallback
  return <pre className="trr-pre">{content.slice(0, 600)}</pre>
}

function KeyValueResult({ content }: { content: string }) {
  const parsed = tryParseJSON(content)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return (
      <div className="trr-kv">
        {Object.entries(parsed as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="trr-kv-row">
            <span className="trr-kv-key">{k}</span>
            <span className="trr-kv-val">{String(v)}</span>
          </div>
        ))}
      </div>
    )
  }
  return <pre className="trr-pre">{content.slice(0, 400)}</pre>
}

function FileWrittenResult({ content, args }: { content: string; args?: Record<string, unknown> }) {
  const path = String(args?.path ?? args?.file_path ?? '')
  return (
    <div className="trr-file-written">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
      <span>{path ? `Записан: ${path}` : content.slice(0, 120)}</span>
    </div>
  )
}

function SearchCodeResult({ content }: { content: string }) {
  const lines = content.split('\n').filter(l => l.trim())
  return (
    <div className="trr-code-matches">
      {lines.slice(0, 20).map((line, i) => (
        <div key={i} className="trr-code-match-line">
          <pre>{line}</pre>
        </div>
      ))}
      {lines.length > 20 && <div className="trr-truncated">... ещё {lines.length - 20} совпадений</div>}
    </div>
  )
}

// ── Главный компонент ──────────────────────────────────────────────────────

interface Props {
  call: ToolStep
  result: ToolStep
  mode: ToolOutputMode
}

const ToolResultRenderer = memo(function ToolResultRenderer({ call, result, mode }: Props) {
  const [expanded, setExpanded] = useState(false)
  const toolName = call.toolName ?? ''
  const content = result.content ?? ''
  const args = call.toolArgs ?? {}
  const maxLines = mode === 'detailed' || expanded ? 9999 : 60

  // ── detailed: показываем аргументы ──
  const showArgs = mode === 'detailed'

  return (
    <div className="trr-wrap">
      {showArgs && Object.keys(args).length > 0 && (
        <div className="trr-args-section">
          <div className="trr-section-label">Аргументы</div>
          <div className="trr-args">
            {Object.entries(args).map(([k, v]) => (
              <div key={k} className="trr-arg-row">
                <span className="trr-arg-key">{k}</span>
                <pre className="trr-arg-val">{String(v).slice(0, 500)}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="trr-result-section">
        {mode !== 'compact' && (
          <div className="trr-section-label" style={{ color: result.success === false ? '#f87171' : '#4ade80' }}>
            {result.success === false ? 'Ошибка' : 'Результат'}
          </div>
        )}

        {renderResult(toolName, content, args, maxLines)}

        {mode === 'normal' && content.split('\n').length > 60 && !expanded && (
          <button className="trr-expand-btn" onClick={() => setExpanded(true)}>
            Показать полностью ({content.split('\n').length} строк)
          </button>
        )}
      </div>
    </div>
  )
}, (prev, next) => prev.call === next.call && prev.result === next.result && prev.mode === next.mode)

export default ToolResultRenderer

function renderResult(toolName: string, content: string, args: Record<string, unknown>, maxLines: number) {
  // read_file → code с подсветкой
  if (toolName === 'read_file' || toolName === 'read_files') {
    const path = String(args.path ?? args.file_path ?? '')
    const lang = getLanguage(path)
    return <CodeResult content={content} lang={lang} maxLines={maxLines} />
  }

  // write_file / edit_file / multi_edit_file → плашка успеха
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'multi_edit_file') {
    return <FileWrittenResult content={content} args={args} />
  }

  // run_command → terminal
  if (toolName === 'run_command') {
    return <TerminalResult content={content} maxLines={maxLines} />
  }

  // find_files / list_directory → файловое дерево
  if (toolName === 'find_files' || toolName === 'list_directory') {
    return <FileListResult content={content} />
  }

  // search_web → карточки
  if (toolName === 'search_web') {
    return <WebSearchResult content={content} />
  }

  // search_code → строки с совпадениями
  if (toolName === 'search_code') {
    return <SearchCodeResult content={content} />
  }

  // get_system_info / get_file_outline → key-value
  if (toolName === 'get_system_info' || toolName === 'get_file_outline') {
    return <KeyValueResult content={content} />
  }

  // http_request → key-value (status line + headers + body)
  if (toolName === 'http_request') {
    return <KeyValueResult content={content} />
  }

  // list_extensions → key-value (статичный отчёт)
  if (toolName === 'list_extensions') {
    return <KeyValueResult content={content} />
  }

  // MCP-тулы (mcp__server__tool) — пробуем JSON-парсинг, fallback → terminal-стиль
  if (toolName.startsWith('mcp__')) {
    // Пытаемся распарсить JSON-ответ (многие MCP-серверы возвращают JSON)
    try {
      const parsed = JSON.parse(content)
      if (typeof parsed === 'object' && parsed !== null) {
        const formatted = JSON.stringify(parsed, null, 2)
        return <TerminalResult content={formatted} maxLines={maxLines} />
      }
    } catch { /* не JSON — рендерим как текст */ }
    return <TerminalResult content={content} maxLines={maxLines} />
  }

  // default → pre
  const { text, truncated } = truncateLines(content, maxLines)
  return (
    <>
      <pre className="trr-pre">{text}</pre>
      {truncated && <div className="trr-truncated">... обрезано</div>}
    </>
  )
}
