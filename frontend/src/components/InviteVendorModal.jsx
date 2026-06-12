import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Search } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import { Modal, Button, Field, Input, Pill, Spinner, EmptyState } from './ui'

const REVIEW_MODES = [
  {
    value: 'none',
    label: 'Simple delivery',
    desc: 'Payload dispatch only — no review integration',
  },
  {
    value: 'isolated',
    label: 'Independent reviews',
    desc: 'Studio and vendor use ArtHound reviews separately',
    disabled: true,
  },
  {
    value: 'collaborative',
    label: 'Collaborative sign-off',
    desc: 'Shared approval workflow',
    disabled: true,
  },
]

export default function InviteVendorModal({ onClose, onInvited }) {
  const [step, setStep]         = useState(1)
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState(null)
  const [reviewMode, setReviewMode] = useState('none')
  const [sending, setSending]   = useState(false)
  const debounce = useRef(null)

  useEffect(() => {
    const q = query.replace(/^@+/, '')
    if (q.length < 2) { setResults([]); return }
    const controller = new AbortController()
    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await apiFetch(`/api/handshake/vendors/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        setResults(data)
      } catch (err) {
        if (err.name !== 'AbortError') toast.error(err.message)
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => { clearTimeout(debounce.current); controller.abort() }
  }, [query])

  async function send() {
    setSending(true)
    try {
      await apiFetch('/api/handshake/invite', {
        method: 'POST',
        body: JSON.stringify({ vendor_id: selected.id, review_collaboration_mode: reviewMode }),
      })
      toast.success(`Invite sent to ${selected.name}`)
      onInvited?.()
      onClose()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSending(false)
    }
  }

  const footer = step === 1 ? (
    <Button variant="ghost" onClick={onClose}>Cancel</Button>
  ) : (
    <>
      <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
      <Button variant="primary" size="lg" onClick={send} disabled={sending}>
        {sending ? 'Sending…' : 'Send invite'}
      </Button>
    </>
  )

  return (
    <Modal title="Connect a Vendor" onClose={onClose} width="max-w-md" footer={footer}>
      <div className="flex flex-col gap-4">

        {/* Step 1 — handle search */}
        {step === 1 && (
          <>
            <Field label="Search by vendor handle">
              <Input
                size="lg"
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="e.g. pixel-forge"
              />
            </Field>

            {searching && (
              <div className="flex items-center gap-2 text-muted text-xs">
                <Spinner size={14} /> Searching…
              </div>
            )}

            {!searching && query.length >= 2 && results.length === 0 && (
              <EmptyState
                icon={Search}
                title="No vendors found"
                hint={`No vendors match "${query}"`}
              />
            )}

            {results.length > 0 && (
              <div className="flex flex-col gap-1">
                {results.map(v => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => { setSelected(v); setStep(2) }}
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-2 border border-border hover:border-accent/50 transition-colors cursor-pointer text-left"
                  >
                    <div>
                      <div className="text-foreground text-sm font-medium">{v.name}</div>
                      {v.handle && <div className="text-muted text-xs">@{v.handle}</div>}
                    </div>
                    <span className="text-link text-xs">Select →</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Step 2 — confirm + review mode */}
        {step === 2 && selected && (
          <>
            <div className="px-3 py-2.5 rounded-lg bg-surface-2 border border-border">
              <div className="text-foreground text-sm font-medium">{selected.name}</div>
              {selected.handle && <div className="text-muted text-xs">@{selected.handle}</div>}
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">Collaboration mode</span>
              {REVIEW_MODES.map(m => (
                <label
                  key={m.value}
                  className={cn(
                    'flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors',
                    m.disabled
                      ? 'opacity-50 cursor-not-allowed border-border'
                      : reviewMode === m.value
                        ? 'border-accent bg-accent-tint cursor-pointer'
                        : 'border-border hover:border-accent/40 cursor-pointer'
                  )}
                >
                  <input
                    type="radio"
                    name="reviewMode"
                    value={m.value}
                    checked={reviewMode === m.value}
                    disabled={m.disabled}
                    onChange={() => !m.disabled && setReviewMode(m.value)}
                    className="mt-0.5 accent-accent"
                  />
                  <div>
                    <div className="text-foreground text-xs font-medium flex items-center gap-2">
                      {m.label}
                      {m.disabled && <Pill tone="neutral">Coming soon</Pill>}
                    </div>
                    <div className="text-muted text-xs">{m.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            <p className="text-muted text-xs">
              This invite expires in 7 days. The vendor will see it in their dashboard.
            </p>
          </>
        )}

      </div>
    </Modal>
  )
}
