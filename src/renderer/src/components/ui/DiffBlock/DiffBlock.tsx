import { memo } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import './DiffBlock.css'

interface DiffBlockProps {
  code: string
  variant?: 'compact' | 'detailed'
  highlight?: boolean
  wrap?: boolean
}

const DiffBlockImpl = function DiffBlock({ code, variant = 'compact', highlight = false, wrap = false }: DiffBlockProps) {
  if (highlight) {
    return (
      <div className={`diff-block-shared diff-block-shared--${variant} diff-block-shared--highlight`}>
        <SyntaxHighlighter
          language="diff"
          style={oneDark}
          customStyle={{
            margin: 0,
            borderRadius: 8,
            fontSize: 12,
            maxHeight: '100%',
            overflow: 'auto',
            background: 'transparent',
            padding: '8px 0',
          }}
          showLineNumbers={false}
          wrapLongLines={wrap}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    )
  }

  const lines = code.split('\n').filter((line, i, arr) => {
    return !(i === arr.length - 1 && line === '')
  })
  return (
    <div className={`diff-block-shared diff-block-shared--${variant} ${wrap ? 'diff-block-shared--wrap' : ''}`}>
      {lines.map((line, i) => {
        let cls = 'diff-block-shared__line'
        if (line.startsWith('+++') || line.startsWith('---')) cls += ' diff-block-shared__meta'
        else if (line.startsWith('+')) cls += ' diff-block-shared__add'
        else if (line.startsWith('-')) cls += ' diff-block-shared__del'
        else if (line.startsWith('@@')) cls += ' diff-block-shared__hunk'
        else cls += ' diff-block-shared__ctx'
        return <div key={i} className={cls}>{line || '\u00A0'}</div>
      })}
    </div>
  )
}

export default memo(DiffBlockImpl)
