import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import { Modal, Button, Field, Input, Spinner, SectionLabel } from './ui'
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
    <Modal
      title={`Share estimates with ${target.studio_name ?? 'studio'}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={sharing}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={share} disabled={sharing || loading || !preview}>
            {sharing ? 'Sharing…' : 'Share estimates'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Granularity */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Level of detail to share</SectionLabel>
          <div className="flex flex-col gap-1.5">
            {GRANULARITIES.map(g => (
              <label
                key={g}
                className={cn(
                  'flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer',
                  granularity === g ? 'border-accent bg-accent-tint' : 'border-border bg-surface hover:bg-surface-2'
                )}
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
          <Field label="Expires after (days)" className="flex-1">
            <Input
              type="number"
              min="1"
              value={expiryDays}
              onChange={e => setExpiryDays(e.target.value)}
              placeholder="Never"
            />
          </Field>
          <Field label="Label (optional)" className="flex-[2]">
            <Input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Q3 rate card"
            />
          </Field>
        </div>

        {/* Preview */}
        <div className="flex flex-col gap-1.5">
          <SectionLabel>
            Preview — exactly what {target.studio_name ?? 'the studio'} will see
          </SectionLabel>
          {loading ? (
            <div className="flex items-center gap-2 text-muted text-xs">
              <Spinner size={14} /> Building preview…
            </div>
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
    </Modal>
  )
}
