import { useCallback, useEffect, useState } from 'react'
import { Bot } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '../../../lib/api'
import { EmptyState, SectionLabel, Spinner } from '../../ui'
import AgentActivityList from '../../agent/AgentActivityList'

// Triage endpoint per record kind.
const ENDPOINT = {
  flag:           id => `/api/agent-activity/flags/${id}`,
  review_request: id => `/api/agent-activity/review-requests/${id}`,
  proposal:       id => `/api/agent-activity/proposals/${id}`,
}

export default function AgentTab({ asset }) {
  const [items, setItems]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId]   = useState(null)

  const load = useCallback((signal) => {
    if (!asset?.canonicalId) { setItems([]); return }
    setLoading(true)
    apiFetch(`/api/agent-activity/asset/${encodeURIComponent(asset.canonicalId)}`, signal ? { signal } : {})
      .then(setItems)
      .catch(err => { if (err.name !== 'AbortError') { toast.error(err.message); setItems([]) } })
      .finally(() => setLoading(false))
  }, [asset?.canonicalId])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function handleStatusChange(item, status) {
    setBusyId(item.id)
    try {
      const updated = await apiFetch(ENDPOINT[item.kind](item.id), {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      })
      setItems(prev => prev.map(i =>
        (i.kind === item.kind && i.id === item.id) ? { ...i, status: updated.status } : i
      ))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-6"><Spinner /></div>
  }

  return (
    <div className="h-full overflow-y-auto p-3 flex flex-col gap-2">
      <SectionLabel>
        Agent activity {items?.length ? <span className="text-faint tabular-nums">({items.length})</span> : ''}
      </SectionLabel>
      {!items?.length
        ? <EmptyState icon={Bot} title="No agent activity." />
        : <AgentActivityList items={items} onStatusChange={handleStatusChange} busyId={busyId} />}
    </div>
  )
}
