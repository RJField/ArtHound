import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '../../lib/api'
import { useAuth } from '../../contexts/AuthContext'
import { Button, Pill, SectionLabel, Spinner, Textarea } from '../ui'

// Threaded comments on a review. P0: internal lane only — the visibility pill and
// lane controls become meaningful when cross-org reviews land (P1).
// Render with key={reviewId} when the same instance can switch reviews — state
// resets via remount, not in-effect setState.
export default function CommentThread({ reviewId }) {
  const { session } = useAuth()
  const myUserId = session?.user?.id ?? null

  const [comments, setComments]   = useState(null)
  const [draft, setDraft]         = useState('')
  const [posting, setPosting]     = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [editDraft, setEditDraft] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    apiFetch(`/api/reviews/${reviewId}/comments`, { signal: controller.signal })
      .then(data => setComments(data ?? []))
      .catch(err => { if (err.name !== 'AbortError') setComments([]) })
    return () => controller.abort()
  }, [reviewId])

  async function post() {
    const body = draft.trim()
    if (!body) return
    setPosting(true)
    try {
      const comment = await apiFetch(`/api/reviews/${reviewId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      })
      setComments(prev => [...(prev ?? []), comment])
      setDraft('')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setPosting(false)
    }
  }

  async function saveEdit(commentId) {
    const body = editDraft.trim()
    if (!body) return
    try {
      const updated = await apiFetch(`/api/reviews/${reviewId}/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      })
      setComments(prev => prev.map(c => (c.id === commentId ? updated : c)))
      setEditingId(null)
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function remove(commentId) {
    if (!window.confirm('Delete this comment?')) return
    try {
      await apiFetch(`/api/reviews/${reviewId}/comments/${commentId}`, { method: 'DELETE' })
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <div className="rounded-lg border border-border px-4 py-3">
      <SectionLabel className="mb-2">
        Comments{comments?.length ? ` (${comments.length})` : ''}
      </SectionLabel>

      {comments === null && (
        <div className="flex justify-center py-4"><Spinner size={16} /></div>
      )}

      {comments?.length === 0 && (
        <p className="text-faint text-xs py-1">No comments yet.</p>
      )}

      <div className="flex flex-col">
        {comments?.map(c => {
          const mine    = myUserId != null && c.author_user_id === myUserId
          const date    = c.created_at ? new Date(c.created_at).toLocaleString() : ''
          const editing = editingId === c.id
          return (
            <div key={c.id} className="group py-2 border-b border-border-soft last:border-b-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-foreground text-xs font-medium truncate">
                  {c.author_email || 'Unknown'}
                </span>
                <span className="text-faint text-xs shrink-0">{date}</span>
                {c.edited_at && <span className="text-faint text-xs shrink-0">(edited)</span>}
                {c.visibility === 'shared' && <Pill tone="accent">Shared</Pill>}
                {mine && !editing && (
                  <div className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-1 text-xs"
                      onClick={() => { setEditingId(c.id); setEditDraft(c.body) }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="px-1 hover:text-error"
                      onClick={() => remove(c.id)}
                      aria-label="Delete comment"
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                )}
              </div>
              {editing ? (
                <div className="flex flex-col gap-2">
                  <Textarea
                    value={editDraft}
                    onChange={e => setEditDraft(e.target.value)}
                    rows={2}
                    className="resize-none"
                    autoFocus
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setEditingId(null)}>Cancel</Button>
                    <Button variant="primary" size="sm" onClick={() => saveEdit(c.id)} disabled={!editDraft.trim()}>
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-foreground text-sm whitespace-pre-wrap">{c.body}</p>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-border-soft">
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={2}
          placeholder="Write a comment…"
          className="resize-none"
        />
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={post} disabled={posting || !draft.trim()}>
            {posting ? 'Posting…' : 'Comment'}
          </Button>
        </div>
      </div>
    </div>
  )
}
