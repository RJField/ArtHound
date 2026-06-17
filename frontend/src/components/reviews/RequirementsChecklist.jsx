import { useEffect, useState } from 'react'
import { ClipboardCheck } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { EmptyState, Spinner, StatusDot, Table, Td, Th, Tr } from '../ui'

// Computed requirement checklist for one studio↔vendor link: dispatched assets × the
// link protocol's steps. Same data for both parties (GET /api/reviews/requirements).
export default function RequirementsChecklist({ linkId }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch(`/api/reviews/requirements?linkId=${encodeURIComponent(linkId)}`, { signal: controller.signal })
      .then(setData)
      .catch(err => { if (err.name !== 'AbortError') setData({ error: err.message }) })
    return () => controller.abort()
  }, [linkId])

  if (data === null) {
    return <div className="flex justify-center py-4"><Spinner size={16} /></div>
  }
  if (data.error) {
    return <p className="text-error text-xs py-1">{data.error}</p>
  }
  if (!data.protocol) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No review protocol set on this connection."
        className="py-4"
      />
    )
  }
  if (data.assets.length === 0) {
    return (
      <EmptyState
        icon={ClipboardCheck}
        title="No dispatched assets on this connection yet — requirements apply per shared asset."
        className="py-4"
      />
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-faint text-xs">
        Protocol: <span className="text-muted">{data.protocol.name}</span>
      </p>
      <Table>
        <thead>
          <tr>
            <Th>Asset</Th>
            {data.steps.map(s => <Th key={s.id}>{s.name}</Th>)}
          </tr>
        </thead>
        <tbody>
          {data.assets.map(a => (
            <Tr key={a.canonical_asset_id}>
              <Td primary>{a.name}</Td>
              {a.requirements.map(req => (
                <Td key={req.step_def_id}>
                  {req.fulfilled ? (
                    <StatusDot
                      label={req.review_status || 'Submitted'}
                      className="text-xs text-foreground"
                    />
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  )
}
