import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { ArrowLeft } from 'lucide-react'
import { cn } from '../lib/utils'
import { Modal, Button, Pill, Spinner, EmptyState } from './ui'
import AttachmentGallery from './media/AttachmentGallery'

// DetailModal({ title, badge?, fields?, image?, actions?, loading?, onClose })
//
// fields: [{ label, value, type?, href?, resolve?, items? }]
//   type: 'text' (default) | 'link' | 'badge' | 'linked-record' | 'attachments'
//   resolve: async fn() → { title, badge?, fields? }  — navigates to linked record
//   items: [{ filename, mimetype, size_bytes, proxyUrl }]  — when type === 'attachments'
// actions: [{ label, style?, onClick(closeFn) }]

export default function DetailModal({ title, badge, fields = [], image, actions = [], loading, onClose }) {
  // History stack for linked-record drill-down
  const [history, setHistory] = useState([{ title, badge, fields, image, actions, loading }])
  const current = history[history.length - 1]
  const canGoBack = history.length > 1

  // Sync the base entry when the parent updates props (e.g. loading → loaded).
  // Preserves any drill-down entries the user has navigated into.
  useEffect(() => {
    setHistory(prev => {
      const next = [...prev]
      next[0] = { title, badge, fields, image, actions, loading }
      return next
    })
  }, [title, fields, loading])

  async function drillInto(field) {
    setHistory(prev => [...prev, { title: 'Loading…', fields: [], loading: true }])
    try {
      const resolved = await field.resolve()
      setHistory(prev => [...prev.slice(0, -1), resolved])
    } catch (err) {
      setHistory(prev => prev.slice(0, -1))
      toast.error(err.message)
    }
  }

  function goBack() {
    setHistory(prev => prev.slice(0, -1))
  }

  return (
    <Modal
      title={
        <span className="flex items-center gap-2 min-w-0">
          {canGoBack && (
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              className="text-muted hover:text-foreground cursor-pointer shrink-0"
            >
              <ArrowLeft size={14} />
            </button>
          )}
          <span className="truncate">{current.title}</span>
        </span>
      }
      onClose={onClose}
      footer={
        current.actions?.length > 0 ? (
          current.actions.map((a, i) => (
            <Button
              key={i}
              variant={a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger' : 'secondary'}
              size="lg"
              onClick={() => a.onClick(onClose)}
            >
              {a.label}
            </Button>
          ))
        ) : undefined
      }
    >
      {current.badge && (
        <Pill tone="neutral" className="mb-3">{current.badge}</Pill>
      )}

      {current.image && (
        <img src={current.image} alt="Preview" className="w-full rounded-lg mb-4 object-cover max-h-48" />
      )}

      {current.fields.length > 0 && (
        <div className="flex flex-col">
          {current.fields.map((f, i) => {
            if (f.type === 'attachments') {
              return (
                <div key={i} className="py-3 border-b border-border-faint last:border-b-0">
                  <AttachmentGallery label={f.label} attachments={f.items ?? []} />
                </div>
              )
            }
            const display = f.value != null && f.value !== '' ? String(f.value) : '—'
            const isEmpty = display === '—'
            return (
              <FieldRow
                key={i}
                field={f}
                display={display}
                isEmpty={isEmpty}
                onDrillIn={drillInto}
              />
            )
          })}
        </div>
      )}

      {current.loading && (
        <div className="flex items-center gap-2 text-muted text-sm">
          <Spinner size={14} /> Loading…
        </div>
      )}

      {!current.loading && current.fields.length === 0 && !current.image && (
        <EmptyState title="No fields to display." />
      )}
    </Modal>
  )
}

function FieldRow({ field, display, isEmpty, onDrillIn }) {
  const [copied, setCopied] = useState(false)

  const isLinked  = field.type === 'linked-record' && field.resolve
  const isLink    = field.type === 'link' && field.href
  const isCopyable = !isEmpty && !isLink && !isLinked

  function handleClick() {
    if (isLinked) { onDrillIn(field); return }
    if (isCopyable) {
      navigator.clipboard.writeText(String(field.value)).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
    }
  }

  return (
    <div
      onClick={handleClick}
      className={cn(
        'flex gap-3 py-2.5 border-b border-border-faint last:border-b-0 text-xs',
        (isLinked || isCopyable) && 'cursor-pointer group'
      )}
    >
      <span className="shrink-0 text-faint w-32 pt-0.5">{field.label}</span>
      <span className={cn(
        'min-w-0 flex-1 text-sm',
        isEmpty    ? 'text-faint'      : 'text-foreground',
        isLinked   ? 'text-link group-hover:underline' : '',
        copied     ? 'text-success'    : '',
      )}>
        {isLink ? (
          <a href={field.href} target="_blank" rel="noopener" className="text-link hover:underline" onClick={e => e.stopPropagation()}>
            {display}
          </a>
        ) : field.type === 'badge' ? (
          <Pill tone="neutral">{display}</Pill>
        ) : (
          <>
            {copied ? 'Copied!' : display}
            {isLinked && !isEmpty && <span className="ml-1 text-muted text-xs">↗</span>}
          </>
        )}
      </span>
    </div>
  )
}
