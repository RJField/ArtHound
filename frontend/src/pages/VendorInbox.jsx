import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { formatRawFields, fieldDisplayString } from '../lib/fields'
import DetailModal from '../components/DetailModal'

const SKIP = new Set(['Name', 'name'])

function buildModalProps(d) {
  const data      = d.payload_data?.data ?? {}
  const name      = data['Name'] || data['name'] || '—'
  const itemType  = fieldDisplayString(data['Item Type'] || data['item_type'] || '')
  const priority  = d.payload_data?.priority
  const studio    = d.payload_data?.sender_studio_name || 'Unknown Studio'
  const date      = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'
  const badge     = [itemType, priority != null ? `P${priority}` : ''].filter(Boolean).join(' · ')
  const raw       = Object.fromEntries(Object.entries(data).filter(([k]) => !SKIP.has(k)))

  return {
    title:  name,
    badge:  badge || undefined,
    fields: [
      { label: 'From',     value: studio },
      { label: 'Received', value: date },
      ...formatRawFields(raw),
    ],
  }
}

export default function VendorInbox() {
  const [dispatches, setDispatches] = useState([])
  const [loading, setLoading]       = useState(true)
  const [activeModal, setActiveModal] = useState(null) // modal props

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/api/payloads/vendor-inbox')
      setDispatches(data)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openDispatch(d) {
    apiFetch(`/api/payloads/${encodeURIComponent(d.id)}/viewed`, { method: 'POST' }).catch(() => {})
    setActiveModal(buildModalProps(d))
  }

  return (
    <main className="flex-1 flex flex-col p-6 gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-foreground text-lg font-semibold">Incoming Scope</h1>
        <button
          onClick={load}
          className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {loading && <p className="text-muted text-sm">Loading…</p>}

      {!loading && dispatches.length === 0 && (
        <p className="text-muted text-sm">No incoming assets yet.</p>
      )}

      {!loading && dispatches.length > 0 && (
        <div className="flex flex-col gap-2">
          {dispatches.map(d => {
            const data      = d.payload_data?.data ?? {}
            const name      = data['Name'] || data['name'] || '—'
            const itemType  = fieldDisplayString(data['Item Type'] || data['item_type'] || '')
            const priority  = d.payload_data?.priority
            const studio    = d.payload_data?.sender_studio_name || 'Unknown Studio'
            const date      = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'

            return (
              <div
                key={d.id}
                onClick={() => openDispatch(d)}
                className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface hover:bg-surface-2 transition-colors cursor-pointer"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-foreground text-sm font-medium truncate">{name}</span>
                  <div className="flex items-center gap-2 flex-wrap">
                    {itemType && (
                      <span className="px-2 py-0.5 rounded-full bg-surface-2 text-muted text-xs">{itemType}</span>
                    )}
                    {priority != null && (
                      <span className="px-2 py-0.5 rounded-full bg-surface-3 text-muted text-xs">P{priority}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0 text-xs text-muted">
                  <span>{studio}</span>
                  <span>{date}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {activeModal && (
        <DetailModal {...activeModal} onClose={() => setActiveModal(null)} />
      )}
    </main>
  )
}
