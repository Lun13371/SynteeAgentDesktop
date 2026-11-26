export interface SubagentOverviewItem {
  id: string
  task: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  createdAt: number
  finishedAt?: number | null
  role?: string | null
}
