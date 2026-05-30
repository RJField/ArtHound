import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import EstimateSnapshotView, { GRANULARITY_LABELS, GRANULARITY_HINTS } from './EstimateSnapshotView'

// Vendor "Share estimates" modal (vendor-estimate-share plan §4.5, M3).
// Pick granularity + optional expiry, preview the projection (the IP-exposure boundary — what the
// studio will see), then share. Re-sharing to the same studio replaces the prior share (§2.6), so
// the granularity choice genuinely answers "how much to show this time".

const GRANULARITIES = ['asset_total', 'craft_bucket', 'workflow_step']

export default function ShareEstimatesModal({ target, onClose, onShared }) {
  const [granularity, setGranularity] = useState('asset_total')
  const [expiryDays, setExpiryDays]   = useState('')   // '' = never expires
  const [label, setLabel]             = useState('')

  const [preview, setPreview]   = useState(null)
  const [loading, setLoading]   = useState(false)
  const [sharing, setSharing]   = useState(false)

  // Re-preview whenever the granularity changes.
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setPreview(null)
    const qs = new URLSearchParams({ link_id: target.link_id, granularity }).toString()
    apiFetch(`/api/estimate-shares/preview?${qs}`, { signal: controller.signal })
      .then(setPreview)
      .catch(err => { if (err.name !== 'AbortError') toast.error(err.message) })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [target.link_id, granularity])

  async function share() {
    setSharing(true)
    try {
      const days = expiryDays.trim() === '' ? null : Math.max(1, parseInt(expiryDays, 10) || 0)
      await apiFetch('/api/estimate-shares', {
        method: 'POST',
        body: JSON.stringify({
          link_id:         target.link_id,
          granularity,
          expires_in_days: days,
          label:           label.trim() || null,
        }),
      })
      toast.success(`Estimates shared with ${target.studio_name ?? 'studio'}`)
      onShared?.()
    } catch (err) {
      toast.error(err.message)
      setSharing(false)
    }
  }

  const unset = preview?.unset_cells ?? 0

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 pt-5 pb-0 shrink-0">
          <h2 className="text-foreground text-base font-semibold">
            Share estimates with {target.studio_name ?? 'studio'}
          </h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        <div className="px-5 pt-4 pb-5 flex flex-col gap-4 overflow-y-auto">
          {/* Granularity */}
          <div className="flex flex-col gap-1.5">
            <span className="text-muted text-xs">Level of detail to share</span>
            <div className="flex flex-col gap-1.5">
              {GRANULARITIES.map(g => (
                <label
                  key={g}
                  className={
                    'flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer ' +
                    (granularity === g ? 'border-accent bg-accent/5' : 'border-border bg-surface hover:bg-surface-2')
                  }
                >
                  <input
                    type="radio"
                    name="granularity"
                    value={g}
                    checked={granularity === g}
                    onChange={() => setGranularity(g)}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-foreground text-xs font-medium">{GRANULARITY_LABELS[g]}</span>
                    <span className="text-muted text-xs">{GRANULARITY_HINTS[g]}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Expiry + label */}
          <div className="flex gap-3">
            <div className="flex flex-col gap-1.5 flex-1">
              <span className="text-muted text-xs">Expires after (days)</span>
              <input
                type="number"
                min="1"
                value={expiryDays}
                onChange={e => setExpiryDays(e.target.value)}
                placeholder="Never"
                className="px-2.5 py-1.5 rounded-md border border-border bg-surface text-foreground text-xs focus:outline-none focus:border-accent"
              />
            </div>
            <div className="flex flex-col gap-1.5 flex-[2]">
              <span className="text-muted text-xs">Label (optional)</span>
              <input
                type="text"
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="e.g. Q3 rate card"
                className="px-2.5 py-1.5 rounded-md border border-border bg-surface text-foreground text-xs focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          {/* Preview */}
          <div className="flex flex-col gap-1.5">
            <span className="text-muted text-xs">Preview — exactly what {target.studio_name ?? 'the studio'} will see</span>
            {loading ? (
              <p className="text-muted text-xs">Building preview…</p>
            ) : preview ? (
              <>
                {unset > 0 && (
                  <p className="text-warning text-xs">
                    {unset} cell{unset !== 1 ? 's' : ''} unset — these will be shared as 0 {preview.snapshot?.unit ?? 'days'}.
                  </p>
                )}
                <EstimateSnapshotView snapshot={preview.snapshot} />
              </>
            ) : (
              <p className="text-muted text-xs">No preview available.</p>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 pb-5 pt-0 shrink-0">
          <button onClick={onClose} disabled={sharing} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer disabled:opacity-40">
            Cancel
          </button>
          <button
            onClick={share}
            disabled={sharing || loading || !preview}
            className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
          >
            {sharing ? 'Sharing…' : 'Share estimates'}
          </button>
        </div>
      </div>
    </div>
  )
}
