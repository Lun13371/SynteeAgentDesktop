import { truncateToTokensAsync } from '../tokens/usageTracker'

/** Limit attached file previews independently of file size. Full files stay on disk. */
export async function previewAttachmentText(text: string, tokenBudget: number): Promise<{ text: string; tokens: number; truncated: boolean }> {
  const budget = Math.max(0, Math.floor(tokenBudget))
  if (!budget) return { text: '', tokens: 0, truncated: text.length > 0 }
  // Avoid sending megabytes to the tokenizer just to keep a short excerpt.
  const candidate = text.slice(0, budget * 4)
  const head = await truncateToTokensAsync(candidate, budget)
  if (candidate.length === text.length && !head.truncated) return head
  const headBudget = Math.floor(budget * 0.75)
  const start = await truncateToTokensAsync(text.slice(0, headBudget * 4), headBudget)
  const tailBudget = budget - headBudget
  const end = await truncateToTokensAsync(text.slice(-tailBudget), tailBudget)
  return {
    text: `${start.text}\n[… middle omitted; use read_file/search_code with the full path for details …]\n${end.text}`,
    tokens: start.tokens + end.tokens + 32,
    truncated: true,
  }
}
