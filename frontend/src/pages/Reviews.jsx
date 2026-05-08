import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Paperclip, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, apiUpload, reviewAttachmentUrl } from '../lib/api'
import { cn } from '../lib/utils'
import ImageViewer from '../components/media/ImageViewer'
import VideoViewer from '../components/media/VideoViewer'
import PdfViewer from '../components/media/PdfViewer'
import DocumentCard from '../components/media/DocumentCard'
import { viewerType } from '../components/media/mediaUtils'

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_OPTS = ['Pending', 'In Review', 'Approved', 'Changes Requested']

const STATUS_STYLE = {
  'Pending':            { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  'In Review':          { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  'Approved':           { color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  'Changes Requested':  { color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
}

// ── Shared sub-components ──────────────────────────────────────────────────────

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

// ── Asset meta panel ───────────────────────────────────────────────────────────

// Keys already shown as core fields — skip in meta section to avoid duplication.
const CORE_META_KEYS = new Set([
  'name', 'summary', 'title',
  'item_type', 'issuetype', 'issue_type',
  'priority',
  'product',
  'status',
  'source_type', 'source_record_id',
])

// Try to extract a clean display string from any meta value.
// Returns null if the value should be hidden entirely.
function extractMetaDisplay(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number') return value === -1 ? null : String(value)
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return null
  if (typeof value === 'object') {
    if (Object.keys(value).length === 0) return null
    // Prefer human-readable label fields used by Jira, Airtable, etc.
    const label =
      value.label ?? value.name ?? value.display_name ?? value.displayName ??
      value.summary ?? value.key ?? value.value
    if (label != null && typeof label !== 'object') return String(label).trim() || null
    // Count containers like {total: 3, ...} or {votes: 0} or {watchCount: 2}
    if (typeof value.total    === 'number') return String(value.total)
    if (typeof value.votes    === 'number') return String(value.votes)
    if (typeof value.watchCount === 'number') return String(value.watchCount)
    // Can't reduce to a scalar — hide it
    return null
  }
  return null
}

function fmtMetaKey(key) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .trim()
    .replace(/^\w/, c => c.toUpperCase())
}

function AssetMeta({ asset }) {
  if (!asset) return (
    <div className="rounded-lg bg-surface-2 border border-border px-4 py-3">
      <p className="text-muted text-xs py-1">Asset metadata unavailable</p>
    </div>
  )

  const coreFields = [
    ['Name',        asset.name],
    ['Item Type',   asset.item_type],
    ['Priority',    asset.priority],
    ['Product',     asset.product],
    ['Status',      asset.status],
    ['Source Type', asset.source_type],
    ['Source ID',   asset.source_record_id],
  ].filter(([, v]) => v != null && v !== '')

  const metaEntries = Object.entries(asset.meta || {})
    .filter(([k]) => !k.startsWith('_') && !CORE_META_KEYS.has(k.toLowerCase()))
    .map(([k, v]) => [fmtMetaKey(k), extractMetaDisplay(v)])
    .filter(([, v]) => v !== null)
    .slice(0, 40)

  return (
    <div className="rounded-lg bg-surface-2 border border-border px-4 py-3">
      <p className="text-foreground text-xs font-semibold uppercase tracking-wide mb-1">Asset</p>
      <div className="flex flex-col">
        {coreFields.map(([label, value]) => (
          <FieldRow key={label} label={label} value={value} />
        ))}
        {metaEntries.map(([label, value]) => (
          <FieldRow key={label} label={label} value={value} />
        ))}
      </div>
    </div>
  )
}

// ── Inline attachment viewer ───────────────────────────────────────────────────

function AttachmentPanel({ reviewId }) {
  const [attachments, setAttachments] = useState([])
  const [activeIdx, setActiveIdx]     = useState(0)
  const [uploading, setUploading]     = useState(false)
  const [dropActive, setDropActive]   = useState(false)
  const inputRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/reviews/${reviewId}/attachments`)
      setAttachments(data ?? [])
    } catch {
      // non-fatal
    }
  }, [reviewId])

  useEffect(() => { load() }, [load])

  // Keep activeIdx in bounds when attachments change
  useEffect(() => {
    setActiveIdx(i => Math.min(i, Math.max(0, attachments.length - 1)))
  }, [attachments.length])

  async function handleFiles(files) {
    if (!files?.length) return
    setUploading(true)
    const prevLen = attachments.length
    for (const file of Array.from(files)) {
      const fd = new FormData()
      fd.append('file', file)
      try {
        await apiUpload(`/api/reviews/${reviewId}/attachments`, fd)
      } catch (err) {
        toast.error(`Upload failed: ${err.message}`)
      }
    }
    await load()
    // Jump to first newly uploaded file
    setActiveIdx(prevLen)
    setUploading(false)
  }

  async function handleDelete(attId) {
    if (!window.confirm('Delete this attachment?')) return
    try {
      await apiFetch(`/api/reviews/${reviewId}/attachments/${attId}`, { method: 'DELETE' })
      setAttachments(prev => prev.filter(a => a.id !== attId))
    } catch (err) {
      toast.error(err.message)
    }
  }

  const active   = attachments[activeIdx] ?? null
  const hasFiles = attachments.length > 0
  const proxyUrl = active ? reviewAttachmentUrl(reviewId, active.id) : null
  const type     = active ? viewerType(active.content_type, active.filename) : null

  return (
    <div
      className={cn(
        'rounded-lg border overflow-hidden transition-colors',
        dropActive ? 'border-accent' : 'border-border'
      )}
      onDragOver={e => { e.preventDefault(); setDropActive(true) }}
      onDragLeave={() => setDropActive(false)}
      onDrop={e => { e.preventDefault(); setDropActive(false); handleFiles(e.dataTransfer.files) }}
    >
      <input ref={inputRef} type="file" multiple className="hidden" onChange={e => handleFiles(e.target.files)} />

      {/* ── Header bar ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 bg-surface-2/30">
        <Paperclip size={12} className="text-muted shrink-0" />

        {hasFiles ? (
          <span className="text-foreground text-xs font-medium truncate flex-1 min-w-0">
            {active?.filename}
          </span>
        ) : (
          <span className="text-foreground text-xs font-semibold uppercase tracking-wide flex-1">
            Attachments
          </span>
        )}

        {/* Prev / counter / next */}
        {attachments.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setActiveIdx(i => Math.max(0, i - 1))}
              disabled={activeIdx === 0}
              className="p-0.5 rounded hover:bg-surface-2 text-muted disabled:opacity-30 cursor-pointer"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-muted text-xs tabular-nums w-10 text-center">
              {activeIdx + 1} / {attachments.length}
            </span>
            <button
              onClick={() => setActiveIdx(i => Math.min(attachments.length - 1, i + 1))}
              disabled={activeIdx >= attachments.length - 1}
              className="p-0.5 rounded hover:bg-surface-2 text-muted disabled:opacity-30 cursor-pointer"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}

        {/* Delete current */}
        {active && (
          <button
            onClick={() => handleDelete(active.id)}
            className="text-muted hover:text-red-400 cursor-pointer shrink-0"
          >
            <Trash2 size={13} />
          </button>
        )}

        {/* Upload */}
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50 cursor-pointer shrink-0"
        >
          <Upload size={12} />
          {uploading ? 'Uploading…' : hasFiles ? 'Add' : 'Upload'}
        </button>
      </div>

      {/* ── Content area ── */}
      {hasFiles ? (
        <div className="h-[520px]">
          {type === 'image'    && <ImageViewer    proxyUrl={proxyUrl} filename={active.filename} />}
          {type === 'video'    && <VideoViewer    proxyUrl={proxyUrl} filename={active.filename} />}
          {type === 'pdf'      && <PdfViewer      proxyUrl={proxyUrl} fitWidth />}
          {type === 'document' && (
            <div className="flex items-center justify-center h-full p-8">
              <DocumentCard filename={active.filename} mimetype={active.content_type} proxyUrl={proxyUrl} compact={false} />
            </div>
          )}
        </div>
      ) : (
        <div
          onClick={() => inputRef.current?.click()}
          className={cn(
            'py-8 flex items-center justify-center text-xs transition-colors cursor-pointer',
            dropActive
              ? 'text-accent bg-accent/5'
              : 'text-muted hover:text-foreground'
          )}
        >
          Drop files here or click to browse
        </div>
      )}
    </div>
  )
}

// ── New Review Modal ───────────────────────────────────────────────────────────

function NewReviewModal({ onClose, onCreated }) {
  const [assets, setAssets]         = useState([])
  const [loadingAssets, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    canonical_asset_id: '',
    title: '',
    description: '',
    status: '',
  })

  useEffect(() => {
    apiFetch('/api/reviews/assets')
      .then(data => {
        setAssets(data)
        if (data.length === 1) setForm(f => ({ ...f, canonical_asset_id: data[0].id }))
      })
      .catch(err => toast.error(err.message))
      .finally(() => setLoading(false))
  }, [])

  async function submit() {
    if (!form.canonical_asset_id) { toast.error('Please select an asset'); return }
    setSubmitting(true)
    try {
      const review = await apiFetch('/api/reviews', {
        method: 'POST',
        body: JSON.stringify({
          canonical_asset_id: form.canonical_asset_id,
          title:       form.title       || null,
          description: form.description || null,
          status:      form.status      || null,
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
          <button onClick={onClose} className="text-muted hover:text-foreground cursor-pointer"><X size={16} /></button>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">Asset *</label>
          {loadingAssets ? (
            <p className="text-muted text-xs py-1">Loading…</p>
          ) : (
            <select
              value={form.canonical_asset_id}
              onChange={e => setForm(f => ({ ...f, canonical_asset_id: e.target.value }))}
              className="bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent cursor-pointer"
            >
              <option value="">Select an asset…</option>
              {assets.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </select>
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">Title</label>
          <input
            type="text"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Short summary…"
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
          <button onClick={onClose} className="px-4 py-2 rounded-md border border-border text-muted text-sm hover:text-foreground cursor-pointer">Cancel</button>
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

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Reviews() {
  const [reviews, setReviews]       = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [filters, setFilters]       = useState({ status: new Set() })
  const [showNew, setShowNew]       = useState(false)
  const [editing, setEditing]       = useState(false)
  const [editForm, setEditForm]     = useState({})

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

  function openEdit(review) {
    setEditForm({ title: review.title || '', description: review.description || '', status: review.status || '' })
    setEditing(true)
  }

  async function saveEdit(review) {
    try {
      await apiFetch(`/api/reviews/${review.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title:       editForm.title       || null,
          description: editForm.description || null,
          status:      editForm.status      || null,
        }),
      })
      setReviews(prev => prev.map(r =>
        r.id === review.id
          ? { ...r, title: editForm.title || null, description: editForm.description || null, status: editForm.status || null }
          : r
      ))
      setEditing(false)
      toast.success('Review updated')
    } catch (err) {
      toast.error(err.message)
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
        <div className="flex items-center justify-between p-3 border-b border-border shrink-0">
          <button onClick={load} className="text-muted text-xs hover:text-foreground cursor-pointer">Refresh</button>
          <button
            onClick={() => setShowNew(true)}
            className="px-2.5 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer"
          >
            + New Review
          </button>
        </div>

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
            const isActive = selectedId === r.id
            return (
              <div
                key={r.id}
                onClick={() => { setSelectedId(r.id); setEditing(false) }}
                className={cn(
                  'px-3 py-3 border-b border-border cursor-pointer transition-colors',
                  isActive ? 'bg-surface-2' : 'hover:bg-surface-2'
                )}
              >
                <p className="text-foreground text-sm font-medium truncate mb-0.5">
                  {r.title || r.asset?.name || '—'}
                </p>
                {r.asset?.name && r.title && (
                  <p className="text-muted text-xs truncate mb-0.5">{r.asset.name}</p>
                )}
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
                    <span className="px-2 py-0.5 rounded-full text-xs text-muted border border-border/50">No status</span>
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
        {!selected ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted text-sm">Select a review to see details.</p>
          </div>
        ) : (
          <div className="p-6 flex flex-col gap-5">

            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                {editing ? (
                  <input
                    autoFocus
                    value={editForm.title}
                    onChange={e => setEditForm(f => ({ ...f, title: e.target.value }))}
                    placeholder="Review title…"
                    className="w-full bg-transparent border-b border-accent text-foreground text-lg font-semibold outline-none pb-0.5"
                  />
                ) : (
                  <h2 className="text-foreground text-lg font-semibold truncate">
                    {selected.title || selected.asset?.name || 'Review'}
                  </h2>
                )}
                <p className="text-muted text-xs mt-0.5">
                  {selected.created_by_email} · {new Date(selected.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {editing ? (
                  <>
                    <button
                      onClick={() => setEditing(false)}
                      className="text-muted text-xs hover:text-foreground cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEdit(selected)}
                      className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer"
                    >
                      Save
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => openEdit(selected)}
                      className="text-muted text-xs hover:text-foreground cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteReview(selected)}
                      className="text-muted hover:text-red-400 transition-colors cursor-pointer"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Attachments — top of detail for quick access */}
            <AttachmentPanel reviewId={selected.id} />

            {/* Asset metadata */}
            <AssetMeta asset={selected.asset} />

            {/* Review fields */}
            <div className="rounded-lg border border-border px-4 py-3">
              <p className="text-foreground text-xs font-semibold uppercase tracking-wide mb-1">Review</p>
              <div className="flex flex-col">
                {editing ? (
                  <>
                    <div className="py-2 border-b border-border/50">
                      <label className="text-muted text-xs block mb-1">Description</label>
                      <textarea
                        value={editForm.description}
                        onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                        rows={4}
                        className="w-full bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent resize-none"
                      />
                    </div>
                    <div className="flex items-center gap-3 py-2">
                      <span className="text-muted text-xs w-28 shrink-0">Status</span>
                      <select
                        value={editForm.status}
                        onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}
                        className="bg-surface-2 border border-border rounded-md px-2 py-1 text-foreground text-sm outline-none focus:border-accent cursor-pointer"
                      >
                        <option value="">None</option>
                        {STATUS_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
                        {selected.status && !STATUS_OPTS.includes(selected.status) && (
                          <option value={selected.status}>{selected.status}</option>
                        )}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <FieldRow label="Description" value={selected.description} span="full" />
                    <div className="flex items-center gap-3 py-2">
                      <span className="text-muted text-xs w-28 shrink-0">Status</span>
                      {selected.status ? (
                        (() => {
                          const s = STATUS_STYLE[selected.status]
                          return s
                            ? <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: s.color, background: s.bg }}>{selected.status}</span>
                            : <span className="text-foreground text-sm">{selected.status}</span>
                        })()
                      ) : (
                        <span className="text-border text-sm">—</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>


          </div>
        )}
      </div>

      {showNew && (
        <NewReviewModal onClose={() => setShowNew(false)} onCreated={handleCreated} />
      )}
    </main>
  )
}
