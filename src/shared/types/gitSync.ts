export interface GitSyncCommit {
  hash: string
  shortHash: string
  author: string
  date: string
  message: string
}

export interface GitSyncProjectState {
  projectId: string
  projectName: string
  workdir: string
  branch: string
  upstream: string
  commits: GitSyncCommit[]
  ahead: number
  behind: number
  diverged: boolean
  error?: string
  lastCheckedAt: number
}

export interface GitSyncState {
  enabled: boolean
  checking: boolean
  projects: GitSyncProjectState[]
  lastCheckedAt: number
}
