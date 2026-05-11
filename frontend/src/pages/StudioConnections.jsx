import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

const REVIEW_MODE_LABELS = {
  none:          'Simple delivery',
  isolated:      'Independent reviews',
  collaborative: 'Collaborative sign-off',
}

function Dot() {
  return <span className="text-border">·</span>
}

// ── Invite preview + accept/reject + mapping setup ────────────────────────────

function AcceptInvitePanel({ invite, onAccepted, onRejected, onClose }) {
  const [step, setStep]         = useState('preview')  // 'preview' | 'mapping' | 'done'
  const [preview, setPreview]   = useState(null)
  const [loadingPreview, setLoadingPreview] = useState(true)
  const [acting, setActing]     = useState(null)        // 'accept' | 'reject'

  // mapping step state
  const [linkId, setLinkId]           = useState(null)
  const [mappingData, setMappingData] = useState(null)
  const [loadingMapping, setLoadingMapping] = useState(false)
  const [fieldMappings, setFieldMappings]   = useState({})
  const [savingMapping, setSavingMapping]   = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch(`/api/handshake/invites/${invite.id}/preview`, { signal: controller.signal })
      .then(setPreview)
      .catch(err => { if (err.name !== 'AbortError') toast.error(err.message) })
      .finally(() => setLoadingPreview(false))
    return () => controller.abort()
  }, [invite.id])

  async function accept() {
    setActing('accept')
    try {
      const res = await apiFetch(`/api/handshake/invites/${invite.id}/accept`, { method: 'POST' })
      const newLinkId = res.link_id
      setLinkId(newLinkId)

      // Only go to mapping step if studio has templates
      if (preview?.payload_templates?.length > 0) {
        setLoadingMapping(true)
        setStep('mapping')
        try {
          const data = await apiFetch(`/api/payloads/link-mapping/${newLinkId}`)
          setMappingData(data)
          // Pre-fill from existing mapping if any
          if (data.existing_mapping && Object.keys(data.existing_mapping).length > 0) {
            setFieldMappings(data.existing_mapping)
          }
        } catch (err) {
          toast.error(`Could not load mapping setup: ${err.message}`)
          setStep('done')
        } finally {
          setLoadingMapping(false)
        }
      } else {
        toast.success(`Connected to ${preview?.studio_name ?? 'studio'}`)
        setStep('done')
      }
    } catch (err) {
      toast.error(err.message)
      setActing(null)
    }
  }

  async function reject() {
    setActing('reject')
    try {
      await apiFetch(`/api/handshake/invites/${invite.id}/reject`, { method: 'POST' })
      toast.success('Invite declined')
      onRejected()
    } catch (err) {
      toast.error(err.message)
      setActing(null)
    }
  }

  async function saveMapping() {
    if (!mappingData?.studio_id || !linkId) return
    setSavingMapping(true)
    try {
      await apiFetch(`/api/handshake/template/${mappingData.studio_id}`, {
        method: 'PUT',
        body: JSON.stringify({ link_id: linkId, field_mappings: fieldMappings }),
      })
      toast.success(`Connected to ${preview?.studio_name ?? 'studio'} — mapping saved`)
    } catch (err) {
      toast.error(`Mapping save failed: ${err.message}`)
    } finally {
      setSavingMapping(false)
      setStep('done')
    }
  }

  function skipMapping() {
    toast.success(`Connected to ${preview?.studio_name ?? 'studio'}`)
    setStep('done')
  }

  // Derive source fields for the dropdown from the auto_target table
  const sourceFields = (() => {
    if (!mappingData?.source_schema || !mappingData?.auto_target) return []
    const table = mappingData.source_schema.find(t => t.id === mappingData.auto_target.table_id)
    return table?.fields ?? []
  })()

  const noSourceSetup = mappingData && !mappingData.source_type

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && step !== 'mapping' && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-md flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 pt-5 pb-0 shrink-0">
          <h2 className="text-foreground text-base font-semibold">
            {step === 'preview' && 'Connection invite'}
            {step === 'mapping' && 'Set up field mapping'}
            {step === 'done'    && 'Connected'}
          </h2>
          {step !== 'mapping' && (
            <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
          )}
        </div>

        <div className="px-5 pt-4 pb-5 flex flex-col gap-4 overflow-y-auto">

          {/* ── Step 1: Preview ── */}
          {step === 'preview' && (
            loadingPreview ? (
              <p className="text-muted text-sm">Loading invite details…</p>
            ) : preview ? (
              <>
                <div className="px-3 py-2.5 rounded-lg bg-surface-2 border border-border">
                  <div className="text-foreground text-sm font-medium">{preview.studio_name}</div>
                  <div className="text-muted text-xs mt-0.5">
                    {REVIEW_MODE_LABELS[preview.review_collaboration_mode] ?? preview.review_collaboration_mode}
                  </div>
                </div>

                {preview.payload_templates?.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-muted text-xs">Payload templates you'll receive:</p>
                    <div className="flex flex-col gap-1">
                      {preview.payload_templates.map(t => (
                        <div key={t.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-2 border border-border">
                          <span className="text-foreground text-xs font-medium">{t.name}</span>
                          <span className="text-muted text-xs">{t.field_schema?.length ?? 0} fields</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-muted text-xs mt-1">
                      After accepting you'll map these fields to your source tool.
                    </p>
                  </div>
                ) : (
                  <p className="text-muted text-xs">This studio hasn't defined payload templates yet.</p>
                )}

                <div className="flex justify-end gap-2">
                  <button onClick={reject} disabled={!!acting} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer disabled:opacity-40">
                    {acting === 'reject' ? 'Declining…' : 'Decline'}
                  </button>
                  <button onClick={accept} disabled={!!acting} className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40">
                    {acting === 'accept' ? 'Connecting…' : 'Accept & Connect'}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-muted text-sm">Could not load invite details.</p>
            )
          )}

          {/* ── Step 2: Mapping ── */}
          {step === 'mapping' && (
            loadingMapping ? (
              <p className="text-muted text-sm">Loading your source schema…</p>
            ) : noSourceSetup ? (
              <>
                <p className="text-muted text-sm">
                  Your source tool isn't connected yet. You can set up your field mapping later from the Studios page once your source is configured.
                </p>
                <div className="flex justify-end">
                  <button onClick={skipMapping} className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer">
                    Continue
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-muted text-xs">
                  Map each payload field from <span className="text-foreground">{preview?.studio_name}</span> to a field in your source tool. You can update this at any time.
                </p>

                {mappingData?.payload_fields?.length > 0 ? (
                  <div className="flex flex-col gap-0 border border-border rounded-lg overflow-hidden">
                    <div className="grid px-3 py-2 bg-surface-2 border-b border-border" style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <span className="text-muted text-xs">Payload field</span>
                      <span className="text-muted text-xs">Your source field</span>
                    </div>
                    <div className="flex flex-col divide-y divide-border max-h-64 overflow-y-auto">
                      {mappingData.payload_fields.map(pf => (
                        <div key={pf.key} className="grid items-center gap-3 px-3 py-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                          <span className="text-foreground text-xs font-medium truncate">{pf.label}</span>
                          <select
                            value={fieldMappings[pf.key] ?? ''}
                            onChange={e => setFieldMappings(prev => ({ ...prev, [pf.key]: e.target.value }))}
                            className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-foreground text-xs focus:outline-none focus:border-accent"
                          >
                            <option value="">— skip —</option>
                            {sourceFields.map(sf => (
                              <option key={sf.id} value={sf.id}>{sf.name}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-muted text-xs">No fields to map yet.</p>
                )}

                <div className="flex justify-end gap-2">
                  <button onClick={skipMapping} disabled={savingMapping} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer disabled:opacity-40">
                    Skip for now
                  </button>
                  <button onClick={saveMapping} disabled={savingMapping} className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40">
                    {savingMapping ? 'Saving…' : 'Save mapping'}
                  </button>
                </div>
              </>
            )
          )}

          {/* ── Step 3: Done ── */}
          {step === 'done' && (
            <>
              <p className="text-muted text-sm">
                You're now connected to <span className="text-foreground font-medium">{preview?.studio_name}</span>.
                Dispatches from this studio will appear in your inbox.
              </p>
              <div className="flex justify-end">
                <button
                  onClick={() => { onAccepted() }}
                  className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer"
                >
                  Done
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}

// ── Cancel confirmation ───────────────────────────────────────────────────────

function CancelLinkModal({ link, studioName, onConfirm, onClose }) {
  const [cancelling, setCancelling] = useState(false)

  async function confirm() {
    setCancelling(true)
    try {
      await onConfirm()
    } finally {
      setCancelling(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-sm flex flex-col gap-4 p-5">
        <h2 className="text-foreground text-base font-semibold">Cancel connection?</h2>
        <p className="text-muted text-sm">
          This will disconnect you from{' '}
          <span className="text-foreground font-medium">{studioName}</span>. All active dispatches
          from this studio will be revoked. A new invite will be required to reconnect.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer"
          >
            Keep connection
          </button>
          <button
            onClick={confirm}
            disabled={cancelling}
            className="px-3 py-1.5 rounded-md bg-error text-white text-xs font-medium hover:bg-error/80 cursor-pointer disabled:opacity-40"
          >
            {cancelling ? 'Cancelling…' : 'Cancel connection'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StudioConnections() {
  const [links, setLinks]         = useState([])
  const [invites, setInvites]     = useState([])
  const [templates, setTemplates] = useState({})   // studio_id → template row | null
  const [loading, setLoading]     = useState(true)

  const [previewInvite, setPreviewInvite] = useState(null)
  const [cancelTarget, setCancelTarget]   = useState(null)  // { link, studioName }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [l, inv] = await Promise.all([
        apiFetch('/api/handshake/links'),
        apiFetch('/api/handshake/invites/incoming'),
      ])
      setLinks(l)
      setInvites(inv)

      // Fetch template status for each active link (best-effort, non-blocking)
      if (l.length > 0) {
        const results = await Promise.allSettled(
          l.map(link =>
            apiFetch(`/api/handshake/template/${link.studio_id}`)
              .then(t => ({ studio_id: link.studio_id, template: t }))
          )
        )
        const map = {}
        for (const r of results) {
          if (r.status === 'fulfilled') {
            map[r.value.studio_id] = r.value.template  // null means no template yet
          }
        }
        setTemplates(map)
      }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function cancelLink() {
    const { link } = cancelTarget
    try {
      await apiFetch(`/api/handshake/links/${link.id}`, { method: 'DELETE' })
      toast.success('Connection cancelled')
      setCancelTarget(null)
      await load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  return (
    <main className="flex-1 flex flex-col p-6 gap-6 max-w-3xl">
      <h1 className="text-foreground text-lg font-semibold">Studio Connections</h1>

      {loading && <p className="text-muted text-sm">Loading…</p>}

      {/* Pending invites */}
      {!loading && invites.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted text-xs font-medium uppercase tracking-wider">
            Pending invites ({invites.length})
          </h2>
          <div className="flex flex-col gap-2">
            {invites.map(inv => (
              <div
                key={inv.id}
                className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-accent/30 bg-accent/5"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-foreground text-sm font-medium truncate">{inv.studio_name}</span>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span>{REVIEW_MODE_LABELS[inv.review_collaboration_mode] ?? inv.review_collaboration_mode}</span>
                    <Dot />
                    <span>Expires {new Date(inv.expires_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <button
                  onClick={() => setPreviewInvite(inv)}
                  className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors cursor-pointer shrink-0"
                >
                  Review invite
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Active connections */}
      {!loading && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted text-xs font-medium uppercase tracking-wider">
            Active connections ({links.length})
          </h2>

          {links.length === 0 && invites.length === 0 && (
            <p className="text-muted text-sm">No studio connections yet. Ask a studio to invite you by your handle.</p>
          )}

          {links.length === 0 && invites.length > 0 && (
            <p className="text-muted text-sm">No active connections yet.</p>
          )}

          {links.length > 0 && (
            <div className="flex flex-col gap-2">
              {links.map(link => {
                const studio     = link.studio ?? {}
                const studioName = studio.name ?? 'Unknown Studio'
                const tpl        = templates[link.studio_id]
                const tplKnown   = link.studio_id in templates
                return (
                  <div
                    key={link.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-foreground text-sm font-medium truncate">{studioName}</span>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span>{REVIEW_MODE_LABELS[link.review_collaboration_mode] ?? link.review_collaboration_mode}</span>
                        <Dot />
                        <span>Connected {new Date(link.created_at).toLocaleDateString()}</span>
                        {tplKnown && (
                          <>
                            <Dot />
                            {tpl
                              ? <span className="text-accent">Template saved</span>
                              : <span>No mapping yet</span>
                            }
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setCancelTarget({ link, studioName })}
                      className="px-3 py-1 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors cursor-pointer shrink-0"
                    >
                      Cancel
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}

      {previewInvite && (
        <AcceptInvitePanel
          invite={previewInvite}
          onAccepted={() => { setPreviewInvite(null); load() }}
          onRejected={() => { setPreviewInvite(null); load() }}
          onClose={() => setPreviewInvite(null)}
        />
      )}

      {cancelTarget && (
        <CancelLinkModal
          link={cancelTarget.link}
          studioName={cancelTarget.studioName}
          onConfirm={cancelLink}
          onClose={() => setCancelTarget(null)}
        />
      )}
    </main>
  )
}
