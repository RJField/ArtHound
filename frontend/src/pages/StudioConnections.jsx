import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Building2 } from 'lucide-react'
import { apiFetch } from '../lib/api'
import ShareEstimatesModal from '../components/ShareEstimatesModal'
import EstimateSnapshotView, { GRANULARITY_LABELS } from '../components/EstimateSnapshotView'
import RequirementsChecklist from '../components/reviews/RequirementsChecklist'
import PageContainer from '../components/PageContainer'
import {
  Button, Select, Modal, Pill, Card, PageHeader, SectionLabel, EmptyState, Spinner,
} from '../components/ui'

const REVIEW_MODE_LABELS = {
  none:          'Simple delivery',
  isolated:      'Independent reviews',
  collaborative: 'Collaborative sign-off',
}

function Dot() {
  return <span className="text-faint">·</span>
}

function SectionHeader({ title, count }) {
  return (
    <SectionLabel>
      {title}
      {count != null && <span className="text-faint tabular-nums"> ({count})</span>}
    </SectionLabel>
  )
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

  const title =
    step === 'preview' ? 'Connection invite'
    : step === 'mapping' ? 'Set up field mapping'
    : 'Connected'

  let footer = null
  if (step === 'preview' && !loadingPreview && preview) {
    footer = (
      <>
        <Button variant="ghost" onClick={reject} disabled={!!acting}>
          {acting === 'reject' ? 'Declining…' : 'Decline'}
        </Button>
        <Button variant="primary" size="lg" onClick={accept} disabled={!!acting}>
          {acting === 'accept' ? 'Connecting…' : 'Accept & Connect'}
        </Button>
      </>
    )
  } else if (step === 'mapping' && !loadingMapping) {
    footer = noSourceSetup ? (
      <Button variant="primary" size="lg" onClick={skipMapping}>Continue</Button>
    ) : (
      <>
        <Button variant="ghost" onClick={skipMapping} disabled={savingMapping}>
          Skip for now
        </Button>
        <Button variant="primary" size="lg" onClick={saveMapping} disabled={savingMapping}>
          {savingMapping ? 'Saving…' : 'Save mapping'}
        </Button>
      </>
    )
  } else if (step === 'done') {
    footer = (
      <Button variant="primary" size="lg" onClick={() => { onAccepted() }}>
        Done
      </Button>
    )
  }

  return (
    <Modal
      title={title}
      onClose={step !== 'mapping' ? onClose : undefined}
      width="max-w-md"
      footer={footer}
    >
      <div className="flex flex-col gap-4">

        {/* ── Step 1: Preview ── */}
        {step === 'preview' && (
          loadingPreview ? (
            <div className="flex items-center gap-2 text-muted text-sm">
              <Spinner size={14} /> Loading invite details…
            </div>
          ) : preview ? (
            <>
              <div className="px-3 py-2.5 rounded-lg bg-surface-2 border border-border-soft">
                <div className="text-foreground text-sm font-medium">{preview.studio_name}</div>
                <div className="text-muted text-xs mt-0.5">
                  {REVIEW_MODE_LABELS[preview.review_collaboration_mode] ?? preview.review_collaboration_mode}
                </div>
              </div>

              {preview.payload_templates?.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <p className="text-faint text-xs">Payload templates you'll receive:</p>
                  <div className="flex flex-col gap-1">
                    {preview.payload_templates.map(t => (
                      <div key={t.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-2 border border-border-soft">
                        <span className="text-foreground text-xs font-medium">{t.name}</span>
                        <span className="text-muted text-xs">{t.field_schema?.length ?? 0} fields</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-faint text-xs mt-1">
                    After accepting you'll map these fields to your source tool.
                  </p>
                </div>
              ) : (
                <p className="text-muted text-xs">This studio hasn't defined payload templates yet.</p>
              )}
            </>
          ) : (
            <p className="text-muted text-sm">Could not load invite details.</p>
          )
        )}

        {/* ── Step 2: Mapping ── */}
        {step === 'mapping' && (
          loadingMapping ? (
            <div className="flex items-center gap-2 text-muted text-sm">
              <Spinner size={14} /> Loading your source schema…
            </div>
          ) : noSourceSetup ? (
            <p className="text-muted text-sm">
              Your source tool isn't connected yet. You can set up your field mapping later from the Studios page once your source is configured.
            </p>
          ) : (
            <>
              <p className="text-muted text-xs">
                Map each payload field from <span className="text-foreground">{preview?.studio_name}</span> to a field in your source tool. You can update this at any time.
              </p>

              {mappingData?.payload_fields?.length > 0 ? (
                <div className="flex flex-col gap-0 border border-border rounded-lg overflow-hidden">
                  <div className="grid px-3 py-2 bg-surface-2 border-b border-border-soft" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <span className="text-faint text-xs">Payload field</span>
                    <span className="text-faint text-xs">Your source field</span>
                  </div>
                  <div className="flex flex-col divide-y divide-border-soft max-h-64 overflow-y-auto">
                    {mappingData.payload_fields.map(pf => (
                      <div key={pf.key} className="grid items-center gap-3 px-3 py-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                        <span className="text-foreground text-xs font-medium truncate">{pf.label}</span>
                        <Select
                          value={fieldMappings[pf.key] ?? ''}
                          onChange={e => setFieldMappings(prev => ({ ...prev, [pf.key]: e.target.value }))}
                          className="w-full"
                        >
                          <option value="">— skip —</option>
                          {sourceFields.map(sf => (
                            <option key={sf.id} value={sf.id}>{sf.name}</option>
                          ))}
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-muted text-xs">No fields to map yet.</p>
              )}
            </>
          )
        )}

        {/* ── Step 3: Done ── */}
        {step === 'done' && (
          <p className="text-muted text-sm">
            You're now connected to <span className="text-foreground font-medium">{preview?.studio_name}</span>.
            Dispatches from this studio will appear in your inbox.
          </p>
        )}

      </div>
    </Modal>
  )
}

// ── Cancel confirmation ───────────────────────────────────────────────────────

function CancelLinkModal({ studioName, onConfirm, onClose }) {
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
    <Modal
      title="Cancel connection?"
      onClose={onClose}
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Keep connection</Button>
          <Button variant="danger" size="lg" onClick={confirm} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel connection'}
          </Button>
        </>
      }
    >
      <p className="text-muted text-sm">
        This will disconnect you from{' '}
        <span className="text-foreground font-medium">{studioName}</span>. All active dispatches
        from this studio will be revoked. A new invite will be required to reconnect.
      </p>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StudioConnections() {
  const [links, setLinks]         = useState([])
  const [invites, setInvites]     = useState([])
  const [templates, setTemplates] = useState({})   // studio_id → template row | null
  const [outbox, setOutbox]       = useState([])    // current estimate shares (one live per channel)
  const [loading, setLoading]     = useState(true)

  const [previewInvite, setPreviewInvite] = useState(null)
  const [cancelTarget, setCancelTarget]   = useState(null)  // { link, studioName }
  const [shareTarget, setShareTarget]     = useState(null)  // { link_id, studio_name }
  const [expandedShare, setExpandedShare] = useState(null)  // dispatch_id
  const [expandedRequirements, setExpandedRequirements] = useState(null)  // link_id
  const [revoking, setRevoking]           = useState(null)  // dispatch_id

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [l, inv, ob] = await Promise.all([
        apiFetch('/api/handshake/links'),
        apiFetch('/api/handshake/invites/incoming'),
        apiFetch('/api/estimate-shares/outbox').catch(() => []),
      ])
      setLinks(l)
      setInvites(inv)
      setOutbox(ob)

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

  useEffect(() => { load() }, [load]) // eslint-disable-line react-hooks/set-state-in-effect

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

  async function revokeShare(dispatchId) {
    setRevoking(dispatchId)
    try {
      await apiFetch(`/api/estimate-shares/${dispatchId}/revoke`, { method: 'POST' })
      toast.success('Estimate share revoked')
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRevoking(null)
    }
  }

  return (
    <PageContainer width="lg" className="p-6 gap-6">
      <PageHeader
        title="Studio Connections"
        subtitle="Studios you work with — incoming invites, active links, and shared estimates."
      />

      {loading && (
        <div className="flex items-center gap-2 text-muted text-sm">
          <Spinner /> Loading…
        </div>
      )}

      {/* Pending invites */}
      {!loading && invites.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Pending invites" count={invites.length} />
          <div className="flex flex-col gap-2">
            {invites.map(inv => (
              <Card
                key={inv.id}
                pad={false}
                className="flex items-center justify-between gap-4 px-4 py-3 border-accent/30 bg-accent-tint"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-foreground text-sm font-medium truncate">{inv.studio_name}</span>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span>{REVIEW_MODE_LABELS[inv.review_collaboration_mode] ?? inv.review_collaboration_mode}</span>
                    <Dot />
                    <span>Expires {new Date(inv.expires_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <Button
                  variant="primary"
                  className="shrink-0"
                  onClick={() => setPreviewInvite(inv)}
                >
                  Review invite
                </Button>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* Active connections */}
      {!loading && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Active connections" count={links.length} />

          {links.length === 0 && invites.length === 0 && (
            <EmptyState
              icon={Building2}
              title="No studio connections yet"
              hint="Ask a studio to invite you by your handle."
              className="py-6"
            />
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
                const hasProtocol = !!link.review_protocol_def_id
                const reqsOpen    = expandedRequirements === link.id
                return (
                  <Card key={link.id} pad={false} className="flex flex-col">
                    <div className="flex items-center justify-between gap-4 px-4 py-3">
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
                                ? <Pill tone="accent">Template saved</Pill>
                                : <Pill tone="neutral">No mapping yet</Pill>
                              }
                            </>
                          )}
                          {hasProtocol && (
                            <>
                              <Dot />
                              <Pill tone="info">Review protocol</Pill>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {hasProtocol && (
                          <Button
                            size="sm"
                            onClick={() => setExpandedRequirements(reqsOpen ? null : link.id)}
                          >
                            {reqsOpen ? 'Hide requirements' : 'Requirements'}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => setShareTarget({ link_id: link.id, studio_name: studioName })}
                        >
                          Share estimates
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => setCancelTarget({ link, studioName })}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                    {reqsOpen && (
                      <div className="px-4 pb-3 border-t border-border-soft pt-3">
                        <RequirementsChecklist linkId={link.id} />
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* Shared estimates (outbox) */}
      {!loading && outbox.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionHeader title="Shared estimates" count={outbox.length} />
          <div className="flex flex-col gap-2">
            {outbox.map(share => {
              const expanded = expandedShare === share.dispatch_id
              const revoked  = !!share.revoked_at
              return (
                <Card key={share.dispatch_id} pad={false} className="flex flex-col">
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground text-sm font-medium truncate">
                          {share.studio_name ?? 'Unknown Studio'}
                        </span>
                        {share.label && <span className="text-muted text-xs truncate">{share.label}</span>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span>{GRANULARITY_LABELS[share.granularity] ?? share.granularity}</span>
                        <Dot />
                        <span>Shared {new Date(share.created_at).toLocaleDateString()}</span>
                        <Dot />
                        {revoked
                          ? <Pill tone="error">Revoked</Pill>
                          : share.expires_at
                            ? <span>Expires {new Date(share.expires_at).toLocaleDateString()}</span>
                            : <span>No expiry</span>
                        }
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button size="sm" onClick={() => setExpandedShare(expanded ? null : share.dispatch_id)}>
                        {expanded ? 'Hide' : 'View'}
                      </Button>
                      {!revoked && (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => revokeShare(share.dispatch_id)}
                          disabled={revoking === share.dispatch_id}
                        >
                          {revoking === share.dispatch_id ? '…' : 'Revoke'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {expanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-border-soft">
                      <EstimateSnapshotView snapshot={share.snapshot} />
                    </div>
                  )}
                </Card>
              )
            })}
          </div>
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
          studioName={cancelTarget.studioName}
          onConfirm={cancelLink}
          onClose={() => setCancelTarget(null)}
        />
      )}

      {shareTarget && (
        <ShareEstimatesModal
          target={shareTarget}
          onClose={() => setShareTarget(null)}
          onShared={() => { setShareTarget(null); load() }}
        />
      )}
    </PageContainer>
  )
}
