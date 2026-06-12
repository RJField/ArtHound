import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../../lib/api'
import { Button, Field, Input, Modal, Select, Spinner } from '../ui'

const FIELD_LABELS = { title: 'Title', description: 'Description', status: 'Status' }

// Promote an internal review to a cross-org review on a studio link.
// Trim selection mirrors the payload-template mental model: choose which fields,
// comments, and attachments cross the org wall. Everything unchecked stays private.
export default function PromoteModal({ review, onClose, onPromoted }) {
  const [links, setLinks]             = useState(null)
  const [comments, setComments]       = useState(null)
  const [attachments, setAttachments] = useState(null)
  const [templates, setTemplates]     = useState([])
  const [linkId, setLinkId]           = useState('')
  const [fields, setFields]           = useState({ title: true, description: true, status: true })
  const [selComments, setSelComments]       = useState(new Set())
  const [selAttachments, setSelAttachments] = useState(new Set())
  const [templateName, setTemplateName]     = useState('')
  const [submitting, setSubmitting]         = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const opts = { signal: controller.signal }
    apiFetch('/api/handshake/links', opts)
      .then(data => {
        setLinks(data ?? [])
        if (data?.length === 1) setLinkId(data[0].id)
      })
      .catch(err => { if (err.name !== 'AbortError') { toast.error(err.message); setLinks([]) } })
    apiFetch(`/api/reviews/${review.id}/comments`, opts)
      .then(data => setComments(data ?? []))
      .catch(err => { if (err.name !== 'AbortError') setComments([]) })
    apiFetch(`/api/reviews/${review.id}/attachments`, opts)
      .then(data => setAttachments(data ?? []))
      .catch(err => { if (err.name !== 'AbortError') setAttachments([]) })
    apiFetch('/api/reviews/trim-templates', opts)
      .then(data => setTemplates(data ?? []))
      .catch(() => {})
    return () => controller.abort()
  }, [review.id])

  function applyTemplate(templateId) {
    const t = templates.find(x => x.id === templateId)
    if (!t) return
    const cfg = t.config || {}
    setFields({ title: true, description: true, status: true, ...(cfg.fields || {}) })
    setSelComments(cfg.include_comments === 'all' ? new Set((comments ?? []).map(c => c.id)) : new Set())
    setSelAttachments(cfg.include_attachments === 'all' ? new Set((attachments ?? []).map(a => a.id)) : new Set())
  }

  async function saveTemplate() {
    const name = templateName.trim()
    if (!name) return
    try {
      const t = await apiFetch('/api/reviews/trim-templates', {
        method: 'POST',
        body: JSON.stringify({
          name,
          link_id: linkId || null,
          config: {
            fields,
            include_comments: comments?.length && selComments.size === comments.length ? 'all' : 'none',
            include_attachments: attachments?.length && selAttachments.size === attachments.length ? 'all' : 'none',
          },
        }),
      })
      setTemplates(prev => [t, ...prev])
      setTemplateName('')
      toast.success('Template saved')
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function promote() {
    if (!linkId) { toast.error('Select a studio link'); return }
    setSubmitting(true)
    try {
      const created = await apiFetch(`/api/reviews/${review.id}/promote`, {
        method: 'POST',
        body: JSON.stringify({
          link_id: linkId,
          trim: {
            fields,
            comment_ids: [...selComments],
            attachment_ids: [...selAttachments],
          },
        }),
      })
      toast.success('Review promoted to cross-org')
      onPromoted(created)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  function toggleSet(setter) {
    return id => setter(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }
  const toggleComment    = toggleSet(setSelComments)
  const toggleAttachment = toggleSet(setSelAttachments)

  const loading = links === null || comments === null || attachments === null

  return (
    <Modal
      title="Promote to Cross-Org Review"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={promote} disabled={submitting || !linkId}>
            {submitting ? 'Promoting…' : 'Promote'}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-muted text-xs">
            Creates a copy of this review shared with the studio. Only the items you select
            cross the org wall — everything else stays private to your org.
          </p>

          <Field label="Studio link *">
            <Select size="lg" value={linkId} onChange={e => setLinkId(e.target.value)}>
              <option value="">Select a link…</option>
              {links.map(l => (
                <option key={l.id} value={l.id}>{l.studio?.name || l.studio_id}</option>
              ))}
            </Select>
          </Field>

          {templates.length > 0 && (
            <Field label="Apply template">
              <Select onChange={e => { if (e.target.value) applyTemplate(e.target.value) }} defaultValue="">
                <option value="">—</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </Field>
          )}

          <Field label="Fields to share">
            <div className="flex gap-4">
              {Object.keys(FIELD_LABELS).map(k => (
                <label key={k} className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!fields[k]}
                    onChange={() => setFields(f => ({ ...f, [k]: !f[k] }))}
                    className="accent-accent"
                  />
                  {FIELD_LABELS[k]}
                </label>
              ))}
            </div>
          </Field>

          <Field label={`Comments to share (${selComments.size}/${comments.length})`}>
            {comments.length === 0 ? (
              <p className="text-faint text-xs">No comments on this review.</p>
            ) : (
              <div className="flex flex-col gap-1 max-h-36 overflow-y-auto rounded-md border border-border-soft p-2">
                {comments.map(c => (
                  <label key={c.id} className="flex items-start gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selComments.has(c.id)}
                      onChange={() => toggleComment(c.id)}
                      className="accent-accent mt-0.5"
                    />
                    <span className="text-foreground min-w-0">
                      <span className="text-muted">{c.author_email}: </span>
                      <span className="break-words">{c.body.length > 120 ? `${c.body.slice(0, 120)}…` : c.body}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Field>

          <Field label={`Attachments to share (${selAttachments.size}/${attachments.length})`}>
            {attachments.length === 0 ? (
              <p className="text-faint text-xs">No attachments on this review.</p>
            ) : (
              <div className="flex flex-col gap-1 max-h-28 overflow-y-auto rounded-md border border-border-soft p-2">
                {attachments.map(a => (
                  <label key={a.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selAttachments.has(a.id)}
                      onChange={() => toggleAttachment(a.id)}
                      className="accent-accent"
                    />
                    <span className="text-foreground truncate">{a.filename}</span>
                  </label>
                ))}
              </div>
            )}
          </Field>

          <Field label="Save selection as template">
            <div className="flex gap-2">
              <Input
                type="text"
                value={templateName}
                onChange={e => setTemplateName(e.target.value)}
                placeholder="Template name…"
                className="flex-1"
              />
              <Button size="sm" onClick={saveTemplate} disabled={!templateName.trim()}>Save</Button>
            </div>
          </Field>
        </div>
      )}
    </Modal>
  )
}
