import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import { Modal, Button, Field, Select, Spinner, SectionLabel } from './ui'

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
    const controller = new AbortController()
    const { signal } = controller
    async function init() {
      try {
        const [vs, outbox, tmpl] = await Promise.all([
          apiFetch('/api/payloads/vendors', { signal }),
          apiFetch('/api/payloads/outbox', { signal }),
          apiFetch('/api/payloads/templates', { signal }),
        ])
        setVendors(vs)
        setExisting(outbox.filter(d => canonicalIds.has(d.asset_id) && !d.revoked_at))
        setTemplates(tmpl)
      } catch (err) {
        if (err.name !== 'AbortError') toast.error(err.message)
      } finally {
        setLoading(false)
      }
    }
    init()
    return () => controller.abort()
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

  const footer = step === 1 ? (
    <>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" size="lg" onClick={() => setStep(2)} disabled={!vendorId}>
        Next
      </Button>
    </>
  ) : step === 2 ? (
    <>
      <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
      <Button variant="primary" size="lg" onClick={send} disabled={sending}>
        {sending ? 'Sending…' : `Send ${selectedAssets.length} Asset${selectedAssets.length !== 1 ? 's' : ''}`}
      </Button>
    </>
  ) : (
    <Button variant="primary" size="lg" onClick={onClose}>Done</Button>
  )

  return (
    <Modal title="Send to Vendor" onClose={onClose} width="max-w-md" footer={footer}>
      <div className="flex flex-col gap-4">
        <StepBar active={step} />

        {/* Step 1 — Vendor select */}
        {step === 1 && (
          <>
            {loading ? (
              <div className="flex items-center gap-2 text-muted text-sm">
                <Spinner size={14} /> Loading…
              </div>
            ) : (
              <>
                <Field label="Send to">
                  <Select
                    size="lg"
                    value={vendorId}
                    onChange={e => {
                      const v = vendors.find(v => v.id === e.target.value)
                      setVendorId(v?.id ?? '')
                      setVendorName(v?.name ?? '')
                    }}
                  >
                    <option value="">— Choose a vendor —</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </Select>
                </Field>

                {templates.length > 0 && (
                  <Field label={<>Payload template <span className="text-faint">(optional)</span></>}>
                    <Select
                      size="lg"
                      value={templateId}
                      onChange={e => setTemplateId(e.target.value)}
                    >
                      <option value="">— Send all fields —</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.field_schema?.length ?? 0} fields)
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}

                <p className="text-muted text-xs">
                  {selectedAssets.length} asset{selectedAssets.length !== 1 ? 's' : ''} selected
                </p>

                {existingShares.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <SectionLabel>Currently shared with</SectionLabel>
                    {existingShares.map(d => {
                      const vName  = vendors.find(v => v.id === d.recipient_vendor_id)?.name ?? 'Unknown'
                      const views  = d.view_count ?? 0
                      return (
                        <div key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-surface-2 border border-border">
                          <div className="text-xs">
                            <span className="text-foreground">{vName}</span>
                            <span className="text-muted ml-2">{views === 0 ? 'Not viewed' : `Viewed ${views}×`}</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => revoke(d.id)}
                            disabled={revoking === d.id}
                            className="text-error hover:text-error hover:bg-error-tint"
                          >
                            {revoking === d.id ? 'Revoking…' : 'Revoke'}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
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
          </>
        )}

        {/* Step 3 — Done */}
        {step === 3 && (
          <div className="flex flex-col items-center gap-2 py-6">
            <span className="text-success text-3xl">✓</span>
            <p className="text-foreground text-sm font-semibold">
              {dispatched} asset{dispatched !== 1 ? 's' : ''} sent
            </p>
            <p className="text-muted text-xs">Delivered to {vendorName}</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
