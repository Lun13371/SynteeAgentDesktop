import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
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
}

export default function CodePreview({
  content,
  language,
  path,
  showLineNumbers,
  maxHeight = '100%',
  truncated,
}: CodePreviewProps) {
  const lang = language ?? (path ? getLanguage(path) : 'text')
  const showLines = showLineNumbers ?? content.split('\n').length > 3

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
          Файл обрезан — показана только часть содержимого
        </div>
      )}
    </div>
  )
}
