/**
 * ChangelogMarkdown — renders release notes as GitHub-flavored markdown.
 *
 * Shared by UpdateAvailableModal, ForceUpdateModal and the ChangelogSettings
 * tab. Styled to match the rest of the app (dark theme, code blocks, lists).
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './ChangelogMarkdown.css'

interface Props {
  content: string | null
  className?: string
}

export default function ChangelogMarkdown({ content, className = '' }: Props) {
  if (!content || !content.trim()) {
    return <p className="changelog-empty">No changelog provided for this release.</p>
  }
  return (
    <div className={`changelog-markdown ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}
