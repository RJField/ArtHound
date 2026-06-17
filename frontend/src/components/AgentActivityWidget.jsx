import { useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { Card, SectionLabel, EmptyState, Skeleton } from './ui'
import AgentActivityList from './agent/AgentActivityList'

// Org roll-up of recent agent-written records, for the studio/vendor home dashboard.
export default function AgentActivityWidget() {
  const [items, setItems] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/agent-activity/recent?limit=8', { signal: controller.signal })
      .then(setItems)
      .catch(e => { if (e.name !== 'AbortError') setItems([]) })
    return () => controller.abort()
  }, [])

  return (
    <Card className="flex flex-col gap-3">
      <SectionLabel>Agent activity</SectionLabel>
      {items === null
        ? <Skeleton className="h-16 w-full" />
        : items.length === 0
          ? <EmptyState icon={Bot} title="No agent activity yet." />
          : <AgentActivityList items={items} showAsset />}
    </Card>
  )
}
