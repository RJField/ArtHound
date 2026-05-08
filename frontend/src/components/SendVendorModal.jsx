import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

// Props:
//   selectedAssets: [{ id, name, itemType, priority, canonicalId, rawFields }]
//   onClose: fn()
//   onSent: fn()  — called after successful dispatch

const STEPS = ['Vendor', 'Review', 'Send']

function StepBar({ active }) {
  return (
    <div className="flex items-center gap-0 mb-5">
      {STEPS.map((label, i) => {
        const n    = i + 1
        const done = n < active
        const cur  = n === active
        return (
          <div key={label} className="flex items-center">
            <div className={cn(
              'flex items-center gap-1.5 text-xs font-medium',
              done ? 'text-success' : cur ? 'text-foreground' : 'text-muted'
            )}>
              <span className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-xs',
                done ? 'bg-success text-white' : cur ? 'bg-accent text-white' : 'bg-surface-2 text-muted'
              )}>
                {done ? '✓' : n}
              </span>
              {label}
            </div>
            {i < STEPS.length - 1 && <div className="w-8 h-px bg-border mx-2" />}
          </div>
        )
      })}
    </div>
  )
}

export default function SendVendorModal({ selectedAssets, onClose, onSent }) {
  const [step, setStep]           = useState(1)
  const [vendors, setVendors]     = useState([])
  const [templates, setTemplates] = useState([])
  const [existingShares, setExisting] = useState([])
  const [vendorId, setVendorId]   = useState('')
  const [vendorName, setVendorName] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [loading, setLoading]     = useState(true)
  const [sending, setSending]     = useState(false)
  const [dispatched, setDispatched] = useState(0)
  const [revoking, setRevoking]   = useState(null)

  const canonicalIds = new Set(selectedAssets.filter(a => a.canonicalId).map(a => a.canonicalId))

  useEffect(() => {
    async function init() {
      try {
        const [vs, outbox, tmpl] = await Promise.all([
          apiFetch('/api/payloads/vendors'),
          apiFetch('/api/payloads/outbox'),
          apiFetch('/api/payloads/templates'),
        ])
        setVendors(vs)
        setExisting(outbox.filter(d => canonicalIds.has(d.asset_id) && !d.revoked_at))
        setTemplates(tmpl)
      } catch (err) {
        toast.error(err.message)
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  async function revoke(id) {
    setRevoking(id)
    try {
      await apiFetch(`/api/payloads/dispatch/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setExisting(prev => prev.filter(d => d.id !== id))
      toast.success('Share revoked')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRevoking(null)
    }
  }

  async function send() {
    const assets = selectedAssets
      .filter(a => a.canonicalId)
      .map(a => ({ asset_id: a.canonicalId, asset_data: { name: a.name, ...(a.rawFields ?? {}) } }))

    if (!assets.length) {
      toast.error('No assets with canonical IDs — load the Asset Manager first')
      return
    }

    setSending(true)
    try {
      const result = await apiFetch('/api/payloads/dispatch-bulk', {
        method: 'POST',
        body: JSON.stringify({ vendor_id: vendorId, assets, ...(templateId ? { template_id: templateId } : {}) }),
      })
      setDispatched(result.dispatched)
      setStep(3)
      toast.success(`${result.dispatched} assets sent to ${vendorName}`)
      onSent?.()
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
          <h2 className="text-foreground text-base font-semibold">Send to Vendor</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        <div className="px-5 pt-4 pb-5 flex flex-col gap-4">
          <StepBar active={step} />

          {/* Step 1 — Vendor select */}
          {step === 1 && (
            <>
              {loading ? (
                <p className="text-muted text-sm">Loading…</p>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    <label className="text-muted text-xs">Send to</label>
                    <select
                      value={vendorId}
                      onChange={e => {
                        const v = vendors.find(v => v.id === e.target.value)
                        setVendorId(v?.id ?? '')
                        setVendorName(v?.name ?? '')
                      }}
                      className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
                    >
                      <option value="">— Choose a vendor —</option>
                      {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                  </div>

                  {templates.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <label className="text-muted text-xs">Payload template <span className="opacity-60">(optional)</span></label>
                      <select
                        value={templateId}
                        onChange={e => setTemplateId(e.target.value)}
                        className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
                      >
                        <option value="">— Send all fields —</option>
                        {templates.map(t => (
                          <option key={t.id} value={t.id}>
                            {t.name} ({t.field_schema?.length ?? 0} fields)
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <p className="text-muted text-xs">
                    {selectedAssets.length} asset{selectedAssets.length !== 1 ? 's' : ''} selected
                  </p>

                  {existingShares.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <p className="text-muted text-xs">Currently shared with</p>
                      {existingShares.map(d => {
                        const vName  = vendors.find(v => v.id === d.recipient_vendor_id)?.name ?? 'Unknown'
                        const views  = d.view_count ?? 0
                        return (
                          <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-surface-2 border border-border">
                            <div className="text-xs">
                              <span className="text-foreground">{vName}</span>
                              <span className="text-muted ml-2">{views === 0 ? 'Not viewed' : `Viewed ${views}×`}</span>
                            </div>
                            <button
                              onClick={() => revoke(d.id)}
                              disabled={revoking === d.id}
                              className="text-xs text-error hover:text-error/80 cursor-pointer disabled:opacity-40"
                            >
                              {revoking === d.id ? 'Revoking…' : 'Revoke'}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button onClick={onClose} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer">Cancel</button>
                <button
                  onClick={() => setStep(2)}
                  disabled={!vendorId}
                  className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </>
          )}

          {/* Step 2 — Review */}
          {step === 2 && (
            <>
              <div className="flex flex-col gap-0.5">
                <p className="text-muted text-sm">
                  Sending to <span className="text-foreground font-medium">{vendorName}</span>
                </p>
                {templateId ? (
                  <p className="text-muted text-xs">
                    Template: <span className="text-foreground">{templates.find(t => t.id === templateId)?.name}</span>
                  </p>
                ) : (
                  <p className="text-muted text-xs">All fields included</p>
                )}
              </div>
              <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                {selectedAssets.map(a => (
                  <div key={a.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-2">
                    <span className="text-foreground text-sm flex-1 truncate">{a.name || '—'}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {a.itemType && <span className="text-xs text-muted">{a.itemType}</span>}
                      {a.priority != null && <span className="text-xs text-muted">P{a.priority}</span>}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setStep(1)} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer">Back</button>
                <button
                  onClick={send}
                  disabled={sending}
                  className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
                >
                  {sending ? 'Sending…' : `Send ${selectedAssets.length} Asset${selectedAssets.length !== 1 ? 's' : ''}`}
                </button>
              </div>
            </>
          )}

          {/* Step 3 — Done */}
          {step === 3 && (
            <>
              <div className="flex flex-col items-center gap-2 py-6">
                <span className="text-success text-3xl">✓</span>
                <p className="text-foreground text-sm font-semibold">
                  {dispatched} asset{dispatched !== 1 ? 's' : ''} sent
                </p>
                <p className="text-muted text-xs">Delivered to {vendorName}</p>
              </div>
              <div className="flex justify-end">
                <button onClick={onClose} className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer">Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
