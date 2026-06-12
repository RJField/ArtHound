import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, ClipboardList, Paperclip, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, apiUpload, assetAttachmentUrl, reviewAttachmentUrl } from '../../../lib/api'
import { fmtDate, formatRawFields } from '../../../lib/fields'
import { Button, EmptyState, Input, SectionLabel, Select, Spinner, StatusDot, Textarea } from '../../ui'
import AttachmentGallery from '../../media/AttachmentGallery'

// ── Per-review attachment list ─────────────────────────────────────────────────

function ReviewAttachments({ reviewId }) {
  const [attachments, setAttachments] = useState(null)
  const [uploading, setUploading]     = useState(false)
  const inputRef = useRef(null)

  const load = useCallback(async (signal) => {
    try {
      const data = await apiFetch(`/api/reviews/${reviewId}/attachments`, signal ? { signal } : {})
      setAttachments(data ?? [])
    } catch (err) {
      if (err.name !== 'AbortError') setAttachments([])
    }
  }, [reviewId])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function handleFiles(files) {
    if (!files?.length) return
    setUploading(true)
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

  if (attachments === null) return null

  const galleryItems = attachments.map(a => ({
    filename: a.filename,
    mimetype: a.content_type,
    proxyUrl: reviewAttachmentUrl(reviewId, a.id),
  }))

  return (
    <div className="mt-2 flex flex-col gap-2">
      {galleryItems.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <AttachmentGallery attachments={galleryItems} />
          {attachments.map(a => (
            <div key={a.id} className="flex items-center justify-between text-xs">
              <span className="text-muted truncate">{a.filename}</span>
              <button
                onClick={() => handleDelete(a.id)}
                aria-label="Delete attachment"
                className="text-muted hover:text-error ml-2 shrink-0 cursor-pointer"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input ref={inputRef} type="file" multiple className="hidden" onChange={e => handleFiles(e.target.files)} />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="px-1"
        >
          <Paperclip size={11} />
          {uploading ? 'Uploading…' : 'Attach file'}
        </Button>
      </div>
    </div>
  )
}

// ── Inline new-review form ─────────────────────────────────────────────────────

const STATUS_OPTS = ['Pending', 'In Review', 'Approved', 'Changes Requested']

function NewReviewForm({ canonicalId, onCreated, onCancel }) {
  const [form, setForm] = useState({ title: '', description: '', status: '' })
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (!canonicalId) return
    setSubmitting(true)
    try {
      const review = await apiFetch('/api/reviews', {
        method: 'POST',
        body: JSON.stringify({
          canonical_asset_id: canonicalId,
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
    <div className="rounded-lg border border-border bg-surface-2/40 p-3 flex flex-col gap-2">
      <Input
        autoFocus
        type="text"
        value={form.title}
        onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
        placeholder="Review title…"
      />
      <Textarea
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        rows={2}
        placeholder="Description…"
        className="text-xs resize-none"
      />
      <Select
        value={form.status}
        onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
      >
        <option value="">No status</option>
        {STATUS_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
      </Select>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={submitting}>
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  )
}

// ── Review card ────────────────────────────────────────────────────────────────

function ReviewCard({ review, onDeleted }) {
  const [expanded, setExpanded] = useState(false)

  async function handleDelete(e) {
    e.stopPropagation()
    if (!window.confirm('Delete this review?')) return
    try {
      await apiFetch(`/api/reviews/${review.id}`, { method: 'DELETE' })
      toast.success('Review deleted')
      onDeleted(review.id)
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-surface-2/40 overflow-hidden">
      <button
        onClick={() => setExpanded(o => !o)}
        className="w-full flex items-start gap-2 p-3 text-left hover:bg-surface-2/60 transition-colors cursor-pointer"
      >
        <span className="mt-0.5 shrink-0 text-muted">
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <div className="flex-1 min-w-0">
          <span className="text-foreground text-xs font-medium leading-snug block truncate">
            {review.title || review.description || 'Review'}
          </span>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {review.status && (
              <StatusDot
                label={review.status.replace(/_/g, ' ')}
                className="text-xs text-foreground capitalize"
              />
            )}
            <span className="text-faint text-xs">
              {review.created_by_email} · {fmtDate(review.created_at?.slice(0, 10))}
            </span>
          </div>
        </div>
        <button
          onClick={handleDelete}
          aria-label="Delete review"
          className="text-muted hover:text-error ml-1 shrink-0 cursor-pointer"
        >
          <Trash2 size={12} />
        </button>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border-soft flex flex-col gap-2 pt-2">
          {review.description && review.title && (
            <p className="text-muted text-xs whitespace-pre-wrap">{review.description}</p>
          )}
          <ReviewAttachments reviewId={review.id} />
        </div>
      )}
    </div>
  )
}

// ── Tab root ───────────────────────────────────────────────────────────────────

export default function ReviewsTab({ asset }) {
  const [reviews, setReviews]       = useState(null)
  const [loading, setLoading]       = useState(false)
  const [showForm, setShowForm]     = useState(false)
  const [attachmentsOpen, setAttachmentsOpen] = useState(false)

  // Asset-level attachments (from source tool fields)
  const attachmentGroups = (() => {
    if (!asset?.rawFields || !asset?.canonicalId) return []
    const proxyUrlFn = (fieldKey, idx) => assetAttachmentUrl(asset.canonicalId, fieldKey, idx)
    return formatRawFields(asset.rawFields, proxyUrlFn).filter(f => f.type === 'attachments')
  })()
  const attachmentCount = attachmentGroups.reduce((sum, g) => sum + (g.items?.length ?? 0), 0)

  const load = useCallback(async (signal) => {
    if (!asset?.canonicalId) { setReviews([]); return }
    setLoading(true)
    apiFetch(`/api/reviews?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`, signal ? { signal } : {})
      .then(setReviews)
      .catch(err => { if (err.name !== 'AbortError') { toast.error(err.message); setReviews([]) } })
      .finally(() => setLoading(false))
  }, [asset?.canonicalId])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  function handleCreated(review) {
    setShowForm(false)
    setReviews(prev => [review, ...(prev ?? [])])
  }

  function handleDeleted(reviewId) {
    setReviews(prev => prev.filter(r => r.id !== reviewId))
  }

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-3 flex flex-col gap-2">

      {/* Asset-level attachments from source tool */}
      {attachmentCount > 0 && (
        <div className="rounded-lg border border-border-soft overflow-hidden">
          <button
            onClick={() => setAttachmentsOpen(o => !o)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <span>Asset Attachments <span className="text-faint tabular-nums">({attachmentCount})</span></span>
            {attachmentsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {attachmentsOpen && (
            <div className="px-3 pb-3 flex flex-col gap-3 border-t border-border-soft">
              {attachmentGroups.map((group, i) => (
                <AttachmentGallery key={i} label={group.label} attachments={group.items} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reviews header + new button */}
      <div className="flex items-center justify-between px-0.5">
        <SectionLabel>
          Reviews {reviews?.length ? <span className="text-faint tabular-nums">({reviews.length})</span> : ''}
        </SectionLabel>
        {!showForm && (
          <Button variant="ghost" size="sm" onClick={() => setShowForm(true)}>
            + New
          </Button>
        )}
      </div>

      {showForm && (
        <NewReviewForm
          canonicalId={asset?.canonicalId}
          onCreated={handleCreated}
          onCancel={() => setShowForm(false)}
        />
      )}

      {reviews === null || reviews.length === 0 ? (
        !showForm && <EmptyState icon={ClipboardList} title="No reviews yet." />
      ) : (
        reviews.map(r => (
          <ReviewCard key={r.id} review={r} onDeleted={handleDeleted} />
        ))
      )}
    </div>
  )
}
