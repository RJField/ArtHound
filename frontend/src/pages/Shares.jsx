import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

function getStatus(d) {
  if (d.revoked_at)              return { label: 'Revoked',  cls: 'text-error   bg-error/10   border-error/20' }
  if (new Date() > new Date(d.expires_at)) return { label: 'Expired',  cls: 'text-muted   bg-surface-2  border-border' }
  return                                          { label: 'Active',   cls: 'text-success bg-success/10 border-success/20' }
}

function assetName(d) {
  return d.payload_data?.data?.['Name'] ?? d.payload_data?.data?.['name'] ?? '—'
}

export default function Shares() {
  const [dispatches, setDispatches] = useState([])
  const [vendorMap, setVendorMap]   = useState({})
  const [loading, setLoading]       = useState(true)
  const [revoking, setRevoking]     = useState(null) // id being revoked

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [outbox, vendors] = await Promise.all([
        apiFetch('/api/payloads/outbox'),
        apiFetch('/api/payloads/vendors'),
      ])
      setDispatches(outbox)
      setVendorMap(Object.fromEntries(vendors.map(v => [v.id, v.name])))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function revoke(id) {
    setRevoking(id)
    try {
      await apiFetch(`/api/payloads/dispatch/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast.success('Access revoked')
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRevoking(null)
    }
  }

  const now = new Date()

  return (
    <main className="flex-1 flex flex-col p-6 gap-4">
      <h1 className="text-foreground text-lg font-semibold">Shared Assets</h1>

      {loading && <p className="text-muted text-sm">Loading…</p>}

      {!loading && dispatches.length === 0 && (
        <p className="text-muted text-sm">No assets have been shared yet.</p>
      )}

      {!loading && dispatches.length > 0 && (
        <div className="flex flex-col gap-2">
          {dispatches.map(d => {
            const status     = getStatus(d)
            const isRevokable = !d.revoked_at && now <= new Date(d.expires_at)
            const viewCount  = d.view_count ?? 0
            const viewLabel  = viewCount === 0 ? 'Not viewed' : `Viewed ${viewCount}×`

            return (
              <div
                key={d.id}
                className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface"
              >
                {/* Left */}
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-foreground text-sm font-medium truncate">
                    {assetName(d)}
                  </span>
                  <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
                    <span>{vendorMap[d.recipient_vendor_id] ?? 'Unknown vendor'}</span>
                    <Dot />
                    <span>Sent {d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}</span>
                    <Dot />
                    <span className={cn(viewCount > 0 ? 'text-p2' : 'text-muted')}>
                      {viewLabel}
                    </span>
                  </div>
                </div>

                {/* Right */}
                <div className="flex items-center gap-3 shrink-0">
                  <span className={cn('px-2 py-0.5 rounded-full border text-xs font-medium', status.cls)}>
                    {status.label}
                  </span>
                  {isRevokable && (
                    <button
                      onClick={() => revoke(d.id)}
                      disabled={revoking === d.id}
                      className="px-3 py-1 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-40"
                    >
                      {revoking === d.id ? 'Revoking…' : 'Revoke'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </main>
  )
}

function Dot() {
  return <span className="text-border">·</span>
}
