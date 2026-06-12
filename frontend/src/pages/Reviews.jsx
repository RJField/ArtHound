import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ClipboardList, Paperclip, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, apiUpload, reviewAttachmentUrl } from '../lib/api'
import { cn } from '../lib/utils'
import { useAuth } from '../contexts/AuthContext'
import {
  Button, Dropdown, EmptyState, Field, Input, KV, Modal, Pill,
  SectionLabel, Select, Spinner, StatusDot, Tabs, Textarea,
} from '../components/ui'
import CommentThread from '../components/reviews/CommentThread'
import PromoteModal from '../components/reviews/PromoteModal'
import ImageViewer from '../components/media/ImageViewer'
import VideoViewer from '../components/media/VideoViewer'
import PdfViewer from '../components/media/PdfViewer'
import DocumentCard from '../components/media/DocumentCard'
import { viewerType } from '../components/media/mediaUtils'

// ── Constants ──────────────────────────────────────────────────────────────────

const STATUS_OPTS = ['Pending', 'In Review', 'Approved', 'Changes Requested']

// ── Shared sub-components ──────────────────────────────────────────────────────

function FilterDropdown({ label, options, active, onChange }) {
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
    <Dropdown
      align="left"
      width="min-w-40"
      trigger={({ toggle: toggleOpen }) => (
        <Button
          onClick={toggleOpen}
          className={cn(isFiltered && 'border-accent text-accent bg-accent-tint hover:bg-accent-tint')}
        >
          <span className="font-medium">{label}</span>
          <span className="text-muted">{summary}</span>
          <span className="text-muted">▾</span>
        </Button>
      )}
    >
      <div className="flex gap-2 px-3 py-1.5 border-b border-border-soft">
        <button onClick={() => onChange(new Set(options))} className="text-xs text-muted hover:text-foreground cursor-pointer">All</button>
        <button onClick={() => onChange(new Set())}        className="text-xs text-muted hover:text-foreground cursor-pointer">None</button>
      </div>
      {options.map(v => (
        <label key={v} className="flex items-center gap-2 px-3 py-1.5 hover:bg-surface-2 cursor-pointer">
          <input type="checkbox" checked={active.has(v)} onChange={() => toggle(v)} className="accent-accent" />
          <span className="text-foreground text-xs">{v}</span>
        </label>
      ))}
    </Dropdown>
  )
}

function FieldRow({ label, value, span }) {
  const display = value != null && value !== '' ? String(value) : '—'
  return (
    <KV label={label}>
      <span className={cn(
        display === '—' && 'text-faint',
        span === 'full' && 'whitespace-pre-wrap'
      )}>
        {display}
      </span>
    </KV>
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
      <SectionLabel className="mb-1">Asset</SectionLabel>
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-soft bg-surface-2/30">
        <Paperclip size={12} className="text-muted shrink-0" />

        {hasFiles ? (
          <span className="text-foreground text-xs font-medium truncate flex-1 min-w-0">
            {active?.filename}
          </span>
        ) : (
          <SectionLabel className="flex-1">Attachments</SectionLabel>
        )}

        {/* Prev / counter / next */}
        {attachments.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveIdx(i => Math.max(0, i - 1))}
              disabled={activeIdx === 0}
              aria-label="Previous attachment"
              className="px-1"
            >
              <ChevronLeft size={14} />
            </Button>
            <span className="text-muted text-xs tabular-nums w-10 text-center">
              {activeIdx + 1} / {attachments.length}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveIdx(i => Math.min(attachments.length - 1, i + 1))}
              disabled={activeIdx >= attachments.length - 1}
              aria-label="Next attachment"
              className="px-1"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        )}

        {/* Delete current */}
        {active && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleDelete(active.id)}
            aria-label="Delete attachment"
            className="shrink-0 px-1 hover:text-error"
          >
            <Trash2 size={13} />
          </Button>
        )}

        {/* Upload */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="shrink-0"
        >
          <Upload size={12} />
          {uploading ? 'Uploading…' : hasFiles ? 'Add' : 'Upload'}
        </Button>
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
              ? 'text-accent bg-accent-tint'
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

function NewReviewModal({ onClose, onCreated, isVendor }) {
  const [assets, setAssets]         = useState([])
  const [links, setLinks]           = useState([])
  const [loadingAssets, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    canonical_asset_id: '',
    title: '',
    description: '',
    status: '',
    link_id: '',
  })

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/reviews/assets', { signal: controller.signal })
      .then(data => {
        setAssets(data)
        if (data.length === 1) setForm(f => ({ ...f, canonical_asset_id: data[0].id }))
      })
      .catch(err => { if (err.name !== 'AbortError') toast.error(err.message) })
      .finally(() => setLoading(false))
    if (isVendor) {
      apiFetch('/api/handshake/links', { signal: controller.signal })
        .then(data => setLinks(data ?? []))
        .catch(() => {})
    }
    return () => controller.abort()
  }, [isVendor])

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
          link_id:     form.link_id     || null,
        }),
      })
      toast.success(form.link_id ? 'Cross-org review created' : 'Review created')
      onCreated(review)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      title="New Review"
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            size="lg"
            onClick={submit}
            disabled={submitting || !form.canonical_asset_id}
          >
            {submitting ? 'Creating…' : 'Create Review'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Asset *">
          {loadingAssets ? (
            <div className="flex items-center gap-2 py-1">
              <Spinner size={14} />
              <span className="text-muted text-xs">Loading…</span>
            </div>
          ) : (
            <Select
              size="lg"
              value={form.canonical_asset_id}
              onChange={e => setForm(f => ({ ...f, canonical_asset_id: e.target.value }))}
            >
              <option value="">Select an asset…</option>
              {assets.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
            </Select>
          )}
        </Field>

        <Field label="Title">
          <Input
            size="lg"
            type="text"
            value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="Short summary…"
          />
        </Field>

        <Field label="Description">
          <Textarea
            value={form.description}
            onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
            rows={3}
            placeholder="Describe the review…"
            className="resize-none"
          />
        </Field>

        <Field label="Status">
          <Select
            size="lg"
            value={form.status}
            onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
          >
            <option value="">None</option>
            {STATUS_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>

        {isVendor && links.length > 0 && (
          <Field label="Send to studio (optional)">
            <Select
              size="lg"
              value={form.link_id}
              onChange={e => setForm(f => ({ ...f, link_id: e.target.value }))}
            >
              <option value="">No — internal review</option>
              {links.map(l => (
                <option key={l.id} value={l.id}>{l.studio?.name || l.studio_id}</option>
              ))}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function Reviews() {
  const { role } = useAuth()
  const [scopeTab, setScopeTab]     = useState('internal')
  const [reviews, setReviews]       = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [filters, setFilters]       = useState({ status: new Set() })
  const [showNew, setShowNew]       = useState(false)
  const [showPromote, setShowPromote] = useState(false)
  const [editing, setEditing]       = useState(false)
  const [editForm, setEditForm]     = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    setSelectedId(null)
    try {
      const data = await apiFetch(`/api/reviews?scope=${scopeTab}`)
      setReviews(data)
      setFilters({ status: new Set() })
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [scopeTab])

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
    if ((review.scope === 'cross_org') !== (scopeTab === 'cross_org')) {
      setScopeTab(review.scope === 'cross_org' ? 'cross_org' : 'internal')
      return // tab switch triggers a reload
    }
    setReviews(prev => [review, ...prev])
    setSelectedId(review.id)
  }

  function handlePromoted() {
    setShowPromote(false)
    setScopeTab('cross_org') // reload via the tab effect; the promoted copy lives there
  }

  async function setStatus(review, status) {
    if (!status || status === review.status) return
    try {
      await apiFetch(`/api/reviews/${review.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      })
      setReviews(prev => prev.map(r => (r.id === review.id ? { ...r, status } : r)))
      toast.success('Status updated')
    } catch (err) {
      toast.error(err.message)
    }
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
        <Tabs
          className="shrink-0 px-1"
          tabs={[
            { id: 'internal',  label: 'Internal' },
            { id: 'cross_org', label: 'Cross-org' },
          ]}
          active={scopeTab}
          onChange={setScopeTab}
        />
        <div className="flex items-center justify-between p-3 border-b border-border shrink-0">
          <Button variant="ghost" size="sm" onClick={load}>Refresh</Button>
          <Button variant="primary" onClick={() => setShowNew(true)}>+ New Review</Button>
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
          {loading && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <EmptyState
              icon={ClipboardList}
              title={reviews.length ? 'No reviews match filters.' : 'No reviews yet.'}
            />
          )}
          {filtered.map(r => {
            const date     = r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'
            const isActive = selectedId === r.id
            return (
              <div
                key={r.id}
                onClick={() => { setSelectedId(r.id); setEditing(false) }}
                className={cn(
                  'px-3 py-3 border-b border-border-soft cursor-pointer transition-colors',
                  isActive
                    ? 'bg-accent-tint text-foreground shadow-[inset_2px_0_0_var(--color-accent)]'
                    : 'hover:bg-surface-2'
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
                    <StatusDot label={r.status} className="text-xs text-foreground" />
                  ) : (
                    <span className="text-xs text-faint">No status</span>
                  )}
                  {r.scope === 'cross_org' && (
                    <Pill tone={r.is_author ? 'neutral' : 'accent'}>
                      {r.is_author ? 'Sent' : 'Received'}
                    </Pill>
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
            <EmptyState icon={ClipboardList} title="Select a review to see details." />
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
                    className="w-full bg-transparent border-b border-accent text-foreground text-lg font-semibold outline-none pb-0.5 placeholder:text-faint"
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
                    <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => saveEdit(selected)}>
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    {role === 'vendor' && selected.scope === 'internal' && (
                      <Button variant="ghost" size="sm" onClick={() => setShowPromote(true)}>
                        Promote
                      </Button>
                    )}
                    {selected.is_author !== false && (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(selected)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteReview(selected)}
                          aria-label="Delete review"
                          className="px-1 hover:text-error"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </>
                    )}
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
              <SectionLabel className="mb-1">Review</SectionLabel>
              <div className="flex flex-col">
                {editing ? (
                  <>
                    <Field label="Description" className="py-2 border-b border-border-soft">
                      <Textarea
                        value={editForm.description}
                        onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))}
                        rows={4}
                        className="w-full resize-none"
                      />
                    </Field>
                    <div className="flex items-center gap-3 py-2">
                      <span className="text-faint text-xs w-28 shrink-0">Status</span>
                      <Select
                        value={editForm.status}
                        onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}
                      >
                        <option value="">None</option>
                        {STATUS_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
                        {selected.status && !STATUS_OPTS.includes(selected.status) && (
                          <option value={selected.status}>{selected.status}</option>
                        )}
                      </Select>
                    </div>
                  </>
                ) : (
                  <>
                    <FieldRow label="Description" value={selected.description} span="full" />
                    <div className="flex items-center gap-3 py-2">
                      <span className="text-faint text-xs w-28 shrink-0">Status</span>
                      {selected.scope === 'cross_org' ? (
                        // Either link party may transition a cross-org review (review_set_status RPC).
                        <Select
                          value={selected.status || ''}
                          onChange={e => setStatus(selected, e.target.value)}
                        >
                          <option value="" disabled>Set status…</option>
                          {STATUS_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
                          {selected.status && !STATUS_OPTS.includes(selected.status) && (
                            <option value={selected.status}>{selected.status}</option>
                          )}
                        </Select>
                      ) : selected.status ? (
                        <StatusDot label={selected.status} className="text-xs text-foreground" />
                      ) : (
                        <span className="text-faint text-sm">—</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Comments */}
            <CommentThread key={selected.id} reviewId={selected.id} scope={selected.scope} />

          </div>
        )}
      </div>

      {showNew && (
        <NewReviewModal
          onClose={() => setShowNew(false)}
          onCreated={handleCreated}
          isVendor={role === 'vendor'}
        />
      )}
      {showPromote && selected && (
        <PromoteModal
          review={selected}
          onClose={() => setShowPromote(false)}
          onPromoted={handlePromoted}
        />
      )}
    </main>
  )
}
