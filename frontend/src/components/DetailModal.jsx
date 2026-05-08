import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { cn } from '../lib/utils'
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start gap-3 px-5 pt-5 pb-3 shrink-0">
          {canGoBack && (
            <button onClick={goBack} className="text-muted hover:text-foreground text-sm mt-0.5 cursor-pointer shrink-0">←</button>
          )}
          <div className="flex-1 min-w-0">
            <h2 className="text-foreground font-semibold text-base truncate">{current.title}</h2>
            {current.badge && (
              <span className="mt-1 inline-block text-xs text-muted bg-surface-2 px-2 py-0.5 rounded-full">
                {current.badge}
              </span>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none shrink-0">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 pb-4">
          {current.image && (
            <img src={current.image} alt="Preview" className="w-full rounded-lg mb-4 object-cover max-h-48" />
          )}

          {current.fields.length > 0 && (
            <div className="flex flex-col divide-y divide-border/50">
              {current.fields.map((f, i) => {
                if (f.type === 'attachments') {
                  return (
                    <div key={i} className="py-3">
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
            <p className="text-muted text-sm">Loading…</p>
          )}

          {!current.loading && current.fields.length === 0 && !current.image && (
            <p className="text-muted text-sm">No fields to display.</p>
          )}
        </div>

        {/* Footer actions */}
        {current.actions?.length > 0 && (
          <div className="flex gap-2 px-5 py-4 border-t border-border shrink-0">
            {current.actions.map((a, i) => (
              <button
                key={i}
                onClick={() => a.onClick(onClose)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors',
                  a.style === 'primary'
                    ? 'bg-accent text-white hover:bg-accent-hover'
                    : a.style === 'danger'
                    ? 'bg-error/10 text-error hover:bg-error/20'
                    : 'bg-surface-2 text-foreground hover:bg-surface-3'
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
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
        'flex items-start gap-4 py-2.5',
        (isLinked || isCopyable) && 'cursor-pointer group'
      )}
    >
      <span className="text-muted text-xs w-32 shrink-0 pt-0.5">{field.label}</span>
      <span className={cn(
        'text-sm flex-1',
        isEmpty    ? 'text-border'     : 'text-foreground',
        isLinked   ? 'text-p2 group-hover:underline' : '',
        copied     ? 'text-success'    : '',
      )}>
        {isLink ? (
          <a href={field.href} target="_blank" rel="noopener" className="text-p2 hover:underline" onClick={e => e.stopPropagation()}>
            {display}
          </a>
        ) : field.type === 'badge' ? (
          <span className="px-2 py-0.5 rounded-full bg-surface-2 text-xs">{display}</span>
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
