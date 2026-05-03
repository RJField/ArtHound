import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../../../lib/api'
import { fmtDate } from '../../../lib/fields'
import { cn } from '../../../lib/utils'

const STATUS_STYLES = {
  pending:   'bg-surface-2 text-muted',
  approved:  'bg-success/10 text-success',
  rejected:  'bg-error/10 text-error',
  in_review: 'bg-accent/10 text-accent',
}

export default function ReviewsTab({ asset }) {
  const [reviews, setReviews] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!asset?.canonicalId) { setReviews([]); return }
    setReviews(null)
    setLoading(true)
    apiFetch(`/api/reviews?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`)
      .then(setReviews)
      .catch(err => { toast.error(err.message); setReviews([]) })
      .finally(() => setLoading(false))
  }, [asset?.canonicalId])

  if (loading) return <p className="text-muted text-xs p-3">Loading…</p>
  if (!reviews) return null
  if (!reviews.length) return <p className="text-muted text-xs p-3">No reviews yet.</p>

  return (
    <div className="h-full overflow-y-auto p-3 flex flex-col gap-2">
      {reviews.map(r => (
        <div
          key={r.id}
          className="p-3 rounded-lg border border-border/60 bg-surface-2/40 flex flex-col gap-1.5"
        >
          <div className="flex items-start justify-between gap-2">
            <span className="text-foreground text-xs font-medium leading-snug">
              {r.description || 'Review'}
            </span>
            {r.status && (
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full shrink-0 capitalize',
                STATUS_STYLES[r.status] ?? 'bg-surface-2 text-muted'
              )}>
                {r.status.replace(/_/g, ' ')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-muted text-xs flex-wrap">
            {r.created_by_email && <span>{r.created_by_email}</span>}
            {r.created_at && (
              <>
                <span>·</span>
                <span>{fmtDate(r.created_at.slice(0, 10))}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
