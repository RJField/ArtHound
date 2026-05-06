import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_OPTS = ['Pending', 'In Progress', 'Approved', 'Changes Requested']

const STATUS_STYLE = {
  'Pending':           { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  'In Progress':       { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  'Approved':          { color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  'Changes Requested': { color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
}

// ── Filter dropdown ────────────────────────────────────────────────────────────

function FilterDropdown({ label, options, active, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const isFiltered = active.size > 0 && active.size < options.length
  const summary = active.size === 0 || active.size === options.length
    ? 'All'
    : active.size === 1 ? [...active][0] : `${active.size} selected`

  function toggle(v) {
    const next = new Set(active)
    next.has(v) ? next.delete(v) : next.add(v)
    onChange(next)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs transition-colors cursor-pointer',
          isFiltered
            ? 'border-accent text-accent bg-accent/10'
            : 'border-border text-muted hover:text-foreground hover:border-border'
        )}
      >
        <span className="font-medium">{label}</span>
        <span className="text-muted">{summary}</span>
        <span className="text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 z-30 bg-surface border border-border rounded-lg shadow-lg min-w-40 py-1">
          <div className="flex gap-2 px-3 py-1.5 border-b border-border">
            <button onClick={() => onChange(new Set(options))} className="text-xs text-muted hover:text-foreground cursor-pointer">All</button>
            <button onClick={() => onChange(new Set())}        className="text-xs text-muted hover:text-foreground cursor-pointer">None</button>
          </div>
          {options.length === 0 && <p className="text-muted text-xs px-3 py-2">No values</p>}
          {options.map(v => (
            <label key={v} className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer">
              <input type="checkbox" checked={active.has(v)} onChange={() => toggle(v)} className="accent-accent" />
              <span className="text-foreground text-xs">{v}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Field row ──────────────────────────────────────────────────────────────────

function FieldRow({ label, value, span }) {
  const display = value != null && value !== '' ? String(value) : '—'
  return (
    <div className="flex items-start gap-4 py-2 border-b border-border/50 last:border-0">
      <span className="text-muted text-xs w-28 shrink-0 pt-0.5">{label}</span>
      <span className={cn(
        'text-sm flex-1',
        display === '—' ? 'text-border' : 'text-foreground',
        span === 'full' && 'whitespace-pre-wrap'
      )}>
        {display}
      </span>
    </div>
  )
}

// ── New Review Modal ───────────────────────────────────────────────────────────

function NewReviewModal({ onClose, onCreated }) {
  const [assets, setAssets]       = useState([])
  const [loadingAssets, setLoadingAssets] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    canonical_asset_id: '',
    source_record_id: '',
    source_type: 'airtable',
    description: '',
    status: '',
  })

  useEffect(() => {
    apiFetch('/api/reviews/assets')
      .then(data => {
        setAssets(data)
        const studioSourceType = data[0]?.source_type || 'airtable'
        if (data.length === 1) {
          setForm(f => ({
            ...f,
            canonical_asset_id: data[0].id,
            source_record_id: data[0].source_key || data[0].source_record_id || '',
            source_type: studioSourceType,
          }))
        } else {
          setForm(f => ({ ...f, source_type: studioSourceType }))
        }
      })
      .catch(err => toast.error(err.message))
      .finally(() => setLoadingAssets(false))
  }, [])

  function handleAssetChange(id) {
    const asset = assets.find(a => a.id === id)
    setForm(f => ({
      ...f,
      canonical_asset_id: id,
      source_record_id: asset?.source_key || asset?.source_record_id || '',
      source_type: asset?.source_type || 'airtable',
    }))
  }

  async function submit() {
    if (!form.canonical_asset_id) { toast.error('Please select an asset'); return }
    setSubmitting(true)
    try {
      const review = await apiFetch('/api/reviews', {
        method: 'POST',
        body: JSON.stringify({
          canonical_asset_id: form.canonical_asset_id,
          source_record_id:   form.source_record_id  || null,
          description:        form.description        || null,
          status:             form.status             || null,
        }),
      })
      toast.success('Review created')
      onCreated(review)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground font-semibold">New Review</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl leading-none cursor-pointer">×</button>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">Asset (ArtHound) *</label>
          {loadingAssets ? (
            <p className="text-muted text-xs py-1">Loading assets…</p>
          ) : (
            <select
              value={form.canonical_asset_id}
              onChange={e => handleAssetChange(e.target.value)}
              className="bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent cursor-pointer"
            >
              <option value="">Select an asset…</option>
              {assets.map(a => (
                <option key={a.id} value={a.id}>{a.name || a.id}</option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">
            Source ID {form.source_type === 'jira' ? '(Jira Key)' : '(Airtable)'}
          </label>
          <input
            type="text"
            value={form.source_record_id}
            onChange={e => setForm(f => ({ ...f, source_record_id: e.target.value }))}
            placeholder="Auto-filled from asset selection"
            className="bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">Description</label>
          <textarea
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={3}
            placeholder="Describe the review…"
            className="bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent resize-none"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">Status</label>
          <select
            value={form.status}
            onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
            className="bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent cursor-pointer"
          >
            <option value="">None</option>
            {STATUS_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md border border-border text-muted text-sm hover:text-foreground cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !form.canonical_asset_id}
            className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
          >
            {submitting ? 'Creating…' : 'Create Review'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Asset metadata card ────────────────────────────────────────────────────────

function AssetMeta({ asset }) {
  return (
    <div className="rounded-lg bg-surface-2 border border-border px-4 py-3">
      <p className="text-foreground text-xs font-semibold uppercase tracking-wide mb-1">Asset</p>
      {!asset ? (
        <p className="text-muted text-xs py-1">Metadata unavailable</p>
      ) : (
        <div className="flex flex-col">
          <FieldRow label="Name"      value={asset.name} />
          <FieldRow label="Item Type" value={asset.item_type} />
          <FieldRow label="Priority"  value={asset.priority} />
          <FieldRow label="Product"   value={asset.product} />
          <FieldRow label="Status"    value={asset.status} />
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Reviews() {
  const [reviews, setReviews]       = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [filters, setFilters]       = useState({ status: new Set() })
  const [showNew, setShowNew]       = useState(false)
  const [updating, setUpdating]     = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setSelectedId(null)
    try {
      const data = await apiFetch('/api/reviews')
      setReviews(data)
      setFilters({ status: new Set() })
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function updateStatus(review, newStatus) {
    setUpdating(true)
    try {
      await apiFetch(`/api/reviews/${review.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus || null }),
      })
      setReviews(prev => prev.map(r =>
        r.id === review.id ? { ...r, status: newStatus || null } : r
      ))
      toast.success('Status updated')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setUpdating(false)
    }
  }

  async function deleteReview(review) {
    if (!window.confirm('Delete this review? This cannot be undone.')) return
    try {
      await apiFetch(`/api/reviews/${review.id}`, { method: 'DELETE' })
      setReviews(prev => prev.filter(r => r.id !== review.id))
      if (selectedId === review.id) setSelectedId(null)
      toast.success('Review deleted')
    } catch (err) {
      toast.error(err.message)
    }
  }

  function handleCreated(review) {
    setShowNew(false)
    setReviews(prev => [review, ...prev])
    setSelectedId(review.id)
  }

  const allStatuses = [...new Set(reviews.map(r => r.status).filter(Boolean))].sort()
  const filtered = reviews.filter(r => {
    if (filters.status.size && !filters.status.has(r.status)) return false
    return true
  })
  const selected = reviews.find(r => r.id === selectedId) ?? null

  return (
    <main className="flex flex-1 overflow-hidden">

      {/* ── Left panel ── */}
      <div className="w-72 flex flex-col border-r border-border shrink-0">

        {/* Toolbar */}
        <div className="flex items-center justify-between p-3 border-b border-border shrink-0">
          <button onClick={load} className="text-muted text-xs hover:text-foreground cursor-pointer">
            Refresh
          </button>
          <button
            onClick={() => setShowNew(true)}
            className="px-2.5 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer"
          >
            + New Review
          </button>
        </div>

        {/* Filters */}
        {allStatuses.length > 0 && (
          <div className="flex gap-2 px-3 py-2 border-b border-border flex-wrap shrink-0">
            <FilterDropdown
              label="Status"
              options={allStatuses}
              active={filters.status}
              onChange={v => setFilters(f => ({ ...f, status: v }))}
            />
          </div>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="text-muted text-xs p-4">Loading…</p>}
          {!loading && filtered.length === 0 && (
            <p className="text-muted text-xs p-4">
              {reviews.length ? 'No reviews match filters.' : 'No reviews yet.'}
            </p>
          )}
          {filtered.map(r => {
            const style    = STATUS_STYLE[r.status] || { color: '#6b748a', bg: 'rgba(107,116,138,0.12)' }
            const date     = r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'
            const assetName = r.asset?.name || '—'
            const isActive  = selectedId === r.id
            return (
              <div
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={cn(
                  'px-3 py-3 border-b border-border cursor-pointer transition-colors',
                  isActive ? 'bg-surface-2' : 'hover:bg-surface-2'
                )}
              >
                <p className="text-foreground text-sm font-medium truncate mb-0.5">{assetName}</p>
                {r.description && (
                  <p className="text-muted text-xs truncate mb-1">{r.description}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  {r.status ? (
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-medium"
                      style={{ color: style.color, background: style.bg }}
                    >
                      {r.status}
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-xs text-muted border border-border/50">
                      No status
                    </span>
                  )}
                  <span className="text-muted text-xs">{date}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Right panel ── */}
      <div className="flex-1 overflow-y-auto">
        {!selected && (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted text-sm">Select a review to see details.</p>
          </div>
        )}

        {selected && (
          <div className="p-6 flex flex-col gap-5 max-w-2xl">

            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-foreground text-lg font-semibold">
                  {selected.asset?.name || 'Review'}
                </h2>
                <p className="text-muted text-xs mt-0.5">
                  {selected.created_by_email} · {new Date(selected.created_at).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => deleteReview(selected)}
                className="text-muted text-xs hover:text-red-400 transition-colors cursor-pointer shrink-0"
              >
                Delete
              </button>
            </div>

            {/* Asset metadata */}
            <AssetMeta asset={selected.asset} />

            {/* Review fields */}
            <div className="rounded-lg border border-border px-4 py-3">
              <p className="text-foreground text-xs font-semibold uppercase tracking-wide mb-1">Review</p>
              <div className="flex flex-col">
                <FieldRow label="Description"     value={selected.description} span="full" />
                <FieldRow label="Source ID" value={selected.source_record_id} />
              </div>

              {/* Status — inline editor */}
              <div className="flex items-center gap-3 py-2 mt-1">
                <span className="text-muted text-xs w-28 shrink-0">Status</span>
                <select
                  value={selected.status || ''}
                  onChange={e => updateStatus(selected, e.target.value)}
                  disabled={updating}
                  className="bg-surface-2 border border-border rounded-md px-2 py-1 text-foreground text-sm outline-none focus:border-accent cursor-pointer disabled:opacity-60"
                >
                  <option value="">None</option>
                  {STATUS_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
                  {/* Preserve any non-standard status value already set */}
                  {selected.status && !STATUS_OPTS.includes(selected.status) && (
                    <option value={selected.status}>{selected.status}</option>
                  )}
                </select>
                {selected.status && STATUS_STYLE[selected.status] && (() => {
                  const s = STATUS_STYLE[selected.status]
                  return <span className="text-xs font-medium" style={{ color: s.color }}>● {selected.status}</span>
                })()}
              </div>
            </div>

          </div>
        )}
      </div>

      {/* New review modal */}
      {showNew && (
        <NewReviewModal
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
        />
      )}

    </main>
  )
}
