import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch, makeRecordResolver } from '../lib/api'
import { fieldDisplayString } from '../lib/fields'
import DetailModal from '../components/DetailModal'
import { cn } from '../lib/utils'

// ── Constants ──────────────────────────────────────────────────────────────

const STATUS_STYLE = {
  'Pending':           { color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
  'Approved':          { color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  'Changes Requested': { color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
}

const RV_SKIP = new Set(['Status', 'Attachments', 'Assets', 'Notes'])

// ── Filter dropdown ────────────────────────────────────────────────────────

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

// ── Media preview ──────────────────────────────────────────────────────────

function MediaPreview({ src, type }) {
  if (!src) {
    return <div className="flex items-center justify-center h-32 bg-surface-2 rounded-lg text-muted text-xs">No attachment</div>
  }
  const ext = src.split('?')[0].split('.').pop().toLowerCase()
  const isVideo = (type || '').startsWith('video/') || ['mp4', 'webm', 'mov', 'ogg', 'm4v'].includes(ext)
  if (isVideo) {
    return <video src={src} controls playsInline preload="metadata" className="w-full rounded-lg max-h-64 bg-black" />
  }
  return <img src={src} alt="Attachment" className="w-full rounded-lg max-h-64 object-contain bg-surface-2" />
}

// ── Inline field list (reuses DetailModal's row pattern without the overlay) ──

function FieldList({ fields, onDrillIn }) {
  return (
    <div className="flex flex-col divide-y divide-border/50">
      {fields.map((f, i) => {
        const display = f.value != null && f.value !== '' ? String(f.value) : '—'
        const isLinked = f.type === 'linked-record' && f.resolve
        return (
          <div
            key={i}
            onClick={isLinked ? () => onDrillIn(f) : undefined}
            className={cn(
              'flex items-start gap-4 py-2',
              isLinked && 'cursor-pointer group'
            )}
          >
            <span className="text-muted text-xs w-24 shrink-0 pt-0.5">{f.label}</span>
            <span className={cn(
              'text-sm flex-1',
              display === '—' ? 'text-border' : 'text-foreground',
              isLinked && display !== '—' ? 'text-p2 group-hover:underline' : '',
              f.span === 'full' ? 'whitespace-pre-wrap' : ''
            )}>
              {display}
              {isLinked && display !== '—' && <span className="ml-1 text-muted text-xs">↗</span>}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Comments ───────────────────────────────────────────────────────────────

function CommentsSection({ reviewId }) {
  const [comments, setComments] = useState(null)
  const [text, setText]         = useState('')
  const [posting, setPosting]   = useState(false)

  useEffect(() => {
    load()
  }, [reviewId])

  async function load() {
    setComments(null)
    try {
      const data = await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/comments`)
      setComments(data)
    } catch (err) {
      toast.error(err.message)
      setComments([])
    }
  }

  async function post() {
    const trimmed = text.trim()
    if (!trimmed) return
    setPosting(true)
    try {
      await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text: trimmed }),
      })
      setText('')
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setPosting(false)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post() }
  }

  return (
    <div className="flex flex-col gap-3 pt-4 border-t border-border mt-4">
      <p className="text-foreground text-xs font-semibold uppercase tracking-wide">Comments</p>

      {comments === null && <p className="text-muted text-xs">Loading…</p>}

      {comments?.length === 0 && <p className="text-muted text-xs">No comments yet.</p>}

      {comments?.map(c => (
        <div key={c.id ?? c.createdTime} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-foreground text-xs font-medium">
              {c.author?.name || c.author?.email || 'Unknown'}
            </span>
            <span className="text-muted text-xs">{new Date(c.createdTime).toLocaleString()}</span>
          </div>
          <p className="text-foreground text-sm whitespace-pre-wrap">{c.text}</p>
        </div>
      ))}

      <div className="flex flex-col gap-2 mt-1">
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          placeholder="Add a comment… (Ctrl+Enter to post)"
          className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent resize-none"
        />
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs">Ctrl+Enter to post</span>
          <button
            onClick={post}
            disabled={posting || !text.trim()}
            className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
          >
            {posting ? 'Posting…' : 'Post comment'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function Reviews() {
  const [reviews, setReviews]         = useState([])
  const [statusOptions, setStatusOpts] = useState([])
  const [selectedId, setSelectedId]   = useState(null)
  const [loading, setLoading]         = useState(true)
  const [filters, setFilters]         = useState({ status: new Set(), artist: new Set() })
  const [linkedModal, setLinkedModal] = useState(null) // {title, badge, fields}

  const load = useCallback(async () => {
    setLoading(true)
    setSelectedId(null)
    try {
      const [rvs, statusData] = await Promise.all([
        apiFetch('/api/reviews'),
        apiFetch('/api/reviews/status-options').catch(() => ({ options: [] })),
      ])
      setReviews(rvs)
      setStatusOpts(statusData.options)
      setFilters({ status: new Set(), artist: new Set() })
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function updateStatus(review, newStatus) {
    try {
      await apiFetch(`/api/reviews/${review.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      setReviews(prev => prev.map(r => r.id === review.id ? { ...r, status: newStatus } : r))
      toast.success('Status updated')
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function drillIntoLinked(field) {
    setLinkedModal({ title: 'Loading…', fields: [] })
    try {
      const resolved = await field.resolve()
      setLinkedModal(resolved)
    } catch (err) {
      setLinkedModal(null)
      toast.error(err.message)
    }
  }

  // Derive filter options from data
  const allStatuses = [...new Set(reviews.map(r => r.status).filter(Boolean))].sort()
  const allArtists  = [...new Set(reviews.map(r => r.artist).filter(Boolean))].sort()

  const filtered = reviews.filter(r => {
    if (filters.status.size && !filters.status.has(r.status)) return false
    if (filters.artist.size && !filters.artist.has(r.artist)) return false
    return true
  })

  const selected = reviews.find(r => r.id === selectedId) ?? null

  // Build fields for selected review detail panel
  const detailFields = selected ? (() => {
    const fields = []
    if (selected.assetIds?.length === 1) {
      fields.push({
        label: 'Asset',
        value: selected.assetName || selected.assetIds[0],
        type: 'linked-record',
        resolve: makeRecordResolver('assets', selected.assetIds[0], selected.assetName || selected.assetIds[0]),
      })
    } else if (selected.assetName) {
      fields.push({ label: 'Asset', value: selected.assetName })
    }
    Object.entries(selected.fields || {})
      .filter(([k, v]) => !RV_SKIP.has(k) && v !== '' && v != null)
      .forEach(([k, v]) => fields.push({ label: k, value: fieldDisplayString(v) }))
    if (selected.notes) fields.push({ label: 'Notes', value: selected.notes, span: 'full' })
    return fields
  })() : []

  const statusOpts = statusOptions.length
    ? statusOptions
    : ['Pending', 'Approved', 'Changes Requested']

  return (
    <main className="flex flex-1 overflow-hidden">
      {/* ── Left panel — list ── */}
      <div className="w-72 flex flex-col border-r border-border shrink-0">
        {/* Toolbar */}
        <div className="flex items-center gap-2 p-3 border-b border-border shrink-0">
          <button onClick={load} className="text-muted text-xs hover:text-foreground cursor-pointer">Refresh</button>
        </div>

        {/* Filters */}
        <div className="flex gap-2 px-3 py-2 border-b border-border flex-wrap shrink-0">
          <FilterDropdown
            label="Status"
            options={allStatuses}
            active={filters.status}
            onChange={v => setFilters(f => ({ ...f, status: v }))}
          />
          <FilterDropdown
            label="Artist"
            options={allArtists}
            active={filters.artist}
            onChange={v => setFilters(f => ({ ...f, artist: v }))}
          />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {loading && <p className="text-muted text-xs p-4">Loading…</p>}
          {!loading && filtered.length === 0 && (
            <p className="text-muted text-xs p-4">
              {reviews.length ? 'No reviews match filters.' : 'No reviews yet.'}
            </p>
          )}
          {filtered.map(r => {
            const style  = STATUS_STYLE[r.status] || { color: '#6b748a', bg: 'rgba(107,116,138,0.12)' }
            const date   = r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : '—'
            const active = selectedId === r.id
            return (
              <div
                key={r.id}
                onClick={() => setSelectedId(r.id)}
                className={cn(
                  'px-3 py-3 border-b border-border cursor-pointer transition-colors',
                  active ? 'bg-surface-2' : 'hover:bg-surface-2'
                )}
              >
                <p className="text-foreground text-sm font-medium truncate mb-1">{r.assetName || '—'}</p>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="px-2 py-0.5 rounded-full text-xs font-medium"
                    style={{ color: style.color, background: style.bg }}
                  >
                    {r.status}
                  </span>
                  <span className="text-muted text-xs">{r.artist || '—'}</span>
                  <span className="text-muted text-xs">·</span>
                  <span className="text-muted text-xs">{date}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Right panel — detail ── */}
      <div className="flex-1 overflow-y-auto">
        {!selected && (
          <div className="flex items-center justify-center h-full">
            <p className="text-muted text-sm">Select a review to see details.</p>
          </div>
        )}

        {selected && (
          <div className="p-6 flex flex-col gap-5 max-w-2xl">
            {/* Header */}
            <div>
              <h2 className="text-foreground text-lg font-semibold">{selected.assetName || '—'}</h2>
              {selected.artist && <p className="text-muted text-sm">{selected.artist}</p>}
            </div>

            {/* Media */}
            <MediaPreview src={selected.screenshot} type={selected.screenshotType} />

            {/* Status */}
            <div className="flex items-center gap-3">
              <span className="text-muted text-xs">Status</span>
              <select
                value={selected.status || ''}
                onChange={e => updateStatus(selected, e.target.value)}
                className="bg-surface-2 border border-border rounded-md px-2 py-1 text-foreground text-sm outline-none focus:border-accent cursor-pointer"
              >
                {statusOpts.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              {selected.status && (() => {
                const style = STATUS_STYLE[selected.status] || { color: '#6b748a' }
                return <span className="text-xs font-medium" style={{ color: style.color }}>● {selected.status}</span>
              })()}
            </div>

            {/* Fields */}
            {detailFields.length > 0 && (
              <FieldList fields={detailFields} onDrillIn={drillIntoLinked} />
            )}

            {/* Comments */}
            <CommentsSection reviewId={selected.id} />
          </div>
        )}
      </div>

      {/* Linked record overlay */}
      {linkedModal && (
        <DetailModal {...linkedModal} onClose={() => setLinkedModal(null)} />
      )}
    </main>
  )
}
