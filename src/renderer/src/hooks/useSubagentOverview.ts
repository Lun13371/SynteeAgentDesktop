import { useEffect, useState } from 'react'
import type { SubagentOverviewItem } from '../../../shared/types/subagentOverview'

const EMPTY: SubagentOverviewItem[] = []

export function useSubagentOverview(chatId?: string): SubagentOverviewItem[] {
  const [state, setState] = useState<{ chatId: string; items: SubagentOverviewItem[] }>()

  useEffect(() => {
    if (!chatId) return
    let disposed = false
    let cleared = false
    let items = new Map<string, SubagentOverviewItem>()
    const publish = (): void => setState({ chatId, items: [...items.values()] })
    const offUpdate = window.syntee.on('agent:update', payload => {
      const event = payload as (SubagentOverviewItem & { chatId: string }) | undefined
      if (event?.chatId !== chatId) return
      const { id, task, status, createdAt, finishedAt, role } = event
      const prev = items.get(id)
      // Most updates only append steps to the full chat card.
      if (prev && prev.task === task && prev.status === status && prev.createdAt === createdAt &&
          prev.finishedAt === finishedAt && prev.role === role) return
      items.set(id, { id, task, status, createdAt, finishedAt, role })
      publish()
    })
    const offClear = window.syntee.on('agent:overviewCleared', payload => {
      const event = payload as { chatId: string } | undefined
      if (event?.chatId !== chatId) return
      cleared = true
      items.clear()
      publish()
    })

    // Subscribe before loading. A live update received during the IPC round trip wins.
    void window.syntee.agent.overview(chatId).then(snapshot => {
      if (disposed || cleared) return
      items = new Map([...snapshot.map(item => [item.id, item] as const), ...items])
      publish()
    }).catch(() => { /* Live events still work if the history could not be loaded. */ })

    return () => {
      disposed = true
      offUpdate()
      offClear()
    }
  }, [chatId])

  return state?.chatId === chatId ? state?.items ?? EMPTY : EMPTY
}
