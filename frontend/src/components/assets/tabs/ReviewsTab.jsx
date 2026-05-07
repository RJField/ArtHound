import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Paperclip, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch, apiUpload, assetAttachmentUrl, reviewAttachmentUrl } from '../../../lib/api'
import { fmtDate, formatRawFields } from '../../../lib/fields'
import { cn } from '../../../lib/utils'
import AttachmentGallery from '../../media/AttachmentGallery'

const STATUS_STYLES = {
  pending:            'bg-surface-2 text-muted',
  approved:           'bg-success/10 text-success',
  rejected:           'bg-error/10 text-error',
  in_review:          'bg-accent/10 text-accent',
  'In Review':        'bg-accent/10 text-accent',
  'Approved':         'bg-success/10 text-success',
  'Changes Requested':'bg-error/10 text-error',
}

// ── Per-review attachment list ─────────────────────────────────────────────────

function ReviewAttachments({ reviewId }) {
  const [attachments, setAttachments] = useState(null)
  const [uploading, setUploading]     = useState(false)
  const inputRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/reviews/${reviewId}/attachments`)
      setAttachments(data ?? [])
    } catch {
      setAttachments([])
    }
  }, [reviewId])

  useEffect(() => { load() }, [load])

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
                className="text-muted hover:text-red-400 ml-2 shrink-0 cursor-pointer"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input ref={inputRef} type="file" multiple className="hidden" onChange={e => handleFiles(e.target.files)} />
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1 text-xs text-muted hover:text-foreground disabled:opacity-50 cursor-pointer"
        >
          <Paperclip size={11} />
          {uploading ? 'Uploading…' : 'Attach file'}
        </button>
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
    <div className="rounded-lg border border-border/60 bg-surface-2/40 p-3 flex flex-col gap-2">
      <input
        autoFocus
        type="text"
        value={form.title}
        onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
        placeholder="Review title…"
        className="bg-surface border border-border/60 rounded-md px-2.5 py-1.5 text-foreground text-xs outline-none focus:border-accent"
      />
      <textarea
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        rows={2}
        placeholder="Description…"
        className="bg-surface border border-border/60 rounded-md px-2.5 py-1.5 text-foreground text-xs outline-none focus:border-accent resize-none"
      />
      <select
        value={form.status}
        onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
        className="bg-surface border border-border/60 rounded-md px-2.5 py-1.5 text-foreground text-xs outline-none focus:border-accent cursor-pointer"
      >
        <option value="">No status</option>
        {STATUS_OPTS.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="text-muted text-xs hover:text-foreground cursor-pointer">Cancel</button>
        <button
          onClick={submit}
          disabled={submitting}
          className="px-2.5 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
        >
          {submitting ? 'Creating…' : 'Create'}
        </button>
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
    <div className="rounded-lg border border-border/60 bg-surface-2/40 overflow-hidden">
      <button
        onClick={() => setExpanded(o => !o)}
        className="w-full flex items-start gap-2 p-3 text-left hover:bg-surface-2/60 transition-colors"
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
              <span className={cn(
                'text-xs px-1.5 py-0.5 rounded-full capitalize',
                STATUS_STYLES[review.status] ?? 'bg-surface-2 text-muted'
              )}>
                {review.status.replace(/_/g, ' ')}
              </span>
            )}
            <span className="text-muted text-xs">
              {review.created_by_email} · {fmtDate(review.created_at?.slice(0, 10))}
            </span>
          </div>
        </div>
        <button
          onClick={handleDelete}
          className="text-muted hover:text-red-400 ml-1 shrink-0 cursor-pointer"
        >
          <Trash2 size={12} />
        </button>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border/40 flex flex-col gap-2 pt-2">
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

  const load = useCallback(async () => {
    if (!asset?.canonicalId) { setReviews([]); return }
    setLoading(true)
    apiFetch(`/api/reviews?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`)
      .then(setReviews)
      .catch(err => { toast.error(err.message); setReviews([]) })
      .finally(() => setLoading(false))
  }, [asset?.canonicalId])

  useEffect(() => { load() }, [load])

  function handleCreated(review) {
    setShowForm(false)
    setReviews(prev => [review, ...(prev ?? [])])
  }

  function handleDeleted(reviewId) {
    setReviews(prev => prev.filter(r => r.id !== reviewId))
  }

  if (loading) return <p className="text-muted text-xs p-3">Loading…</p>

  return (
    <div className="h-full overflow-y-auto p-3 flex flex-col gap-2">

      {/* Asset-level attachments from source tool */}
      {attachmentCount > 0 && (
        <div className="rounded-lg border border-border/40 overflow-hidden">
          <button
            onClick={() => setAttachmentsOpen(o => !o)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs text-muted hover:text-foreground hover:bg-surface-2/40 transition-colors"
          >
            <span>Asset Attachments ({attachmentCount})</span>
            {attachmentsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {attachmentsOpen && (
            <div className="px-3 pb-3 flex flex-col gap-3 border-t border-border/40">
              {attachmentGroups.map((group, i) => (
                <AttachmentGallery key={i} label={group.label} attachments={group.items} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reviews header + new button */}
      <div className="flex items-center justify-between px-0.5">
        <span className="text-muted text-xs font-medium uppercase tracking-wide">
          Reviews {reviews?.length ? `(${reviews.length})` : ''}
        </span>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs text-accent hover:text-accent-hover cursor-pointer"
          >
            + New
          </button>
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
        !showForm && <p className="text-muted text-xs px-0.5">No reviews yet.</p>
      ) : (
        reviews.map(r => (
          <ReviewCard key={r.id} review={r} onDeleted={handleDeleted} />
        ))
      )}
    </div>
  )
}
