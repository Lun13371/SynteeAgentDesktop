import { memo } from 'react'
import './DiffBlock.css'

interface DiffBlockProps {
  code: string
  variant?: 'compact' | 'detailed'
}

const DiffBlockImpl = function DiffBlock({ code, variant = 'compact' }: DiffBlockProps) {
  const lines = code.split('\n').filter((line, i, arr) => {
    return !(i === arr.length - 1 && line === '')
  })
  return (
    <div className={`diff-block-shared diff-block-shared--${variant}`}>
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
