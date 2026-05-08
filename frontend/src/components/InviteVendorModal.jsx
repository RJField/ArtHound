import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

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
    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      setSearching(true)
      try {
        const data = await apiFetch(`/api/handshake/vendors/search?q=${encodeURIComponent(q)}`)
        setResults(data)
      } catch (err) {
        toast.error(err.message)
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(debounce.current)
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-md flex flex-col">
        <div className="flex items-center justify-between px-5 pt-5 pb-0 shrink-0">
          <h2 className="text-foreground text-base font-semibold">Connect a Vendor</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        <div className="px-5 pt-4 pb-5 flex flex-col gap-4">

          {/* Step 1 — handle search */}
          {step === 1 && (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-muted text-xs">Search by vendor handle</label>
                <input
                  autoFocus
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="e.g. pixel-forge"
                  className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent placeholder:text-muted"
                />
              </div>

              {searching && <p className="text-muted text-xs">Searching…</p>}

              {!searching && query.length >= 2 && results.length === 0 && (
                <p className="text-muted text-xs">No vendors found for "{query}"</p>
              )}

              {results.length > 0 && (
                <div className="flex flex-col gap-1">
                  {results.map(v => (
                    <button
                      key={v.id}
                      onClick={() => { setSelected(v); setStep(2) }}
                      className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-surface-2 border border-border hover:border-accent/50 transition-colors cursor-pointer text-left"
                    >
                      <div>
                        <div className="text-foreground text-sm font-medium">{v.name}</div>
                        {v.handle && <div className="text-muted text-xs">@{v.handle}</div>}
                      </div>
                      <span className="text-accent text-xs">Select →</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex justify-end">
                <button onClick={onClose} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer">
                  Cancel
                </button>
              </div>
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
                <label className="text-muted text-xs">Collaboration mode</label>
                {REVIEW_MODES.map(m => (
                  <label
                    key={m.value}
                    className={cn(
                      'flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-colors',
                      m.disabled
                        ? 'opacity-50 cursor-not-allowed border-border'
                        : reviewMode === m.value
                          ? 'border-accent bg-accent/5 cursor-pointer'
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
                        {m.disabled && <span className="text-muted font-normal">· Coming soon</span>}
                      </div>
                      <div className="text-muted text-xs">{m.desc}</div>
                    </div>
                  </label>
                ))}
              </div>

              <p className="text-muted text-xs">
                This invite expires in 7 days. The vendor will see it in their dashboard.
              </p>

              <div className="flex justify-end gap-2">
                <button onClick={() => setStep(1)} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer">
                  Back
                </button>
                <button
                  onClick={send}
                  disabled={sending}
                  className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
                >
                  {sending ? 'Sending…' : 'Send invite'}
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
