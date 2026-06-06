import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import InviteVendorModal from '../components/InviteVendorModal'
import PayloadTemplateModal from '../components/PayloadTemplateModal'
import EstimateSnapshotView, { GRANULARITY_LABELS } from '../components/EstimateSnapshotView'
import PageContainer from '../components/PageContainer'

const MAX_RESENDS = 2

const REVIEW_MODE_LABELS = {
  none:          'Simple delivery',
  isolated:      'Independent reviews',
  collaborative: 'Collaborative sign-off',
}

function daysUntil(isoString) {
  const diff = new Date(isoString) - Date.now()
  const days = Math.ceil(diff / 86400000)
  if (days <= 0) return 'Expired'
  if (days === 1) return 'Expires tomorrow'
  return `Expires in ${days}d`
}

function Dot() {
  return <span className="text-border">·</span>
}

function SectionHeader({ title, count, action }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-muted text-xs font-medium uppercase tracking-wider">
        {title}{count != null && ` (${count})`}
      </h2>
      {action}
    </div>
  )
}

// ── Shared-asset (payload dispatch) helpers ────────────────────────────────────

function shareStatus(d) {
  if (d.revoked_at)                          return { label: 'Revoked', cls: 'text-error   bg-error/10   border-error/20' }
  if (new Date() > new Date(d.expires_at))   return { label: 'Expired', cls: 'text-muted   bg-surface-2  border-border'   }
  return                                            { label: 'Active',  cls: 'text-success bg-success/10 border-success/20' }
}

function assetName(d) {
  return d.payload_data?.data?.['Name'] ?? d.payload_data?.data?.['name'] ?? '—'
}

// ── Cancel confirmation modal ─────────────────────────────────────────────────

function CancelLinkModal({ link, vendorName, onConfirm, onClose }) {
  const [loading, setLoading]     = useState(true)
  const [counts, setCounts]       = useState(null)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/payloads/outbox', { signal: controller.signal })
      .then(outbox => {
        const now = new Date()
        const vendorRows = outbox.filter(d => d.recipient_vendor_id === link.vendor_id)
        const outstanding = vendorRows.filter(d =>
          !d.revoked_at &&
          new Date(d.expires_at) > now &&
          !d.payload_field_mappings?.[0]?.ingested_at
        ).length
        const completed = vendorRows.filter(d =>
          d.payload_field_mappings?.[0]?.ingested_at
        ).length
        setCounts({ outstanding, completed })
      })
      .catch(e => { if (e.name !== 'AbortError') setCounts({ outstanding: '?', completed: '?' }) })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [link.vendor_id])

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
          This will permanently disconnect{' '}
          <span className="text-foreground font-medium">{vendorName}</span> and cannot be undone.
          A new invite will be required to reconnect.
        </p>

        {loading ? (
          <p className="text-muted text-xs">Checking active dispatches…</p>
        ) : (
          <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-surface-2 border border-border text-xs">
            <div className="flex justify-between">
              <span className="text-muted">Active dispatches revoked immediately</span>
              <span className={cn('font-medium', counts.outstanding > 0 ? 'text-error' : 'text-foreground')}>
                {counts.outstanding}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Completed dispatches preserved</span>
              <span className="text-foreground">{counts.completed}</span>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer"
          >
            Keep connection
          </button>
          <button
            onClick={confirm}
            disabled={loading || cancelling}
            className="px-3 py-1.5 rounded-md bg-error text-white text-xs font-medium hover:bg-error/80 cursor-pointer disabled:opacity-40"
          >
            {cancelling ? 'Cancelling…' : 'Cancel connection'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Per-vendor sections ────────────────────────────────────────────────────────

const SHARE_STATUS_OPTIONS = [
  { value: 'active',         label: 'Active' },
  { value: 'active-expired', label: 'Active & Expired' },
  { value: 'expired',        label: 'Expired' },
  { value: 'revoked',        label: 'Revoked' },
  { value: 'all',            label: 'All statuses' },
]

function SharedAssets({ shares, revoking, onRevoke }) {
  const [statusFilter, setStatusFilter] = useState('active')
  const now = new Date()

  const filtered = useMemo(() => shares.filter(d => {
    const label = shareStatus(d).label.toLowerCase()
    if (statusFilter === 'all')            return true
    if (statusFilter === 'active-expired') return label !== 'revoked'
    return label === statusFilter
  }), [shares, statusFilter])

  return (
    <section className="flex flex-col gap-3">
      <SectionHeader
        title="Shared Assets"
        count={filtered.length}
        action={
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="px-2.5 py-1 rounded-md border border-border bg-surface-2 text-foreground text-xs outline-none focus:border-accent cursor-pointer"
          >
            {SHARE_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        }
      />
      {filtered.length === 0 ? (
        <p className="text-muted text-sm">
          {shares.length === 0 ? 'No assets shared with this vendor yet.' : 'No shares match the current filter.'}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map(d => {
            const status      = shareStatus(d)
            const isRevokable = !d.revoked_at && now <= new Date(d.expires_at)
            const viewCount   = d.view_count ?? 0
            const viewLabel   = viewCount === 0 ? 'Not viewed' : `Viewed ${viewCount}×`
            const ingestedAt  = d.payload_field_mappings?.[0]?.ingested_at
            const ingestedBy  = d.payload_field_mappings?.[0]?.ingested_by_name
            return (
              <div
                key={d.id}
                className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="text-foreground text-sm font-medium truncate">{assetName(d)}</span>
                  <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
                    <span>Sent {d.created_at ? new Date(d.created_at).toLocaleDateString() : '—'}</span>
                    <Dot />
                    <span className={cn(viewCount > 0 ? 'text-p2' : 'text-muted')}>{viewLabel}</span>
                    {ingestedAt && (
                      <>
                        <Dot />
                        <span className="text-success font-medium">
                          Ingested {new Date(ingestedAt).toLocaleDateString()}
                          {ingestedBy && <span className="font-normal"> by {ingestedBy}</span>}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className={cn('px-2 py-0.5 rounded-full border text-xs font-medium', status.cls)}>
                    {status.label}
                  </span>
                  {isRevokable && (
                    <button
                      onClick={() => onRevoke(d.id)}
                      disabled={revoking === d.id}
                      className="px-3 py-1 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-40"
                    >
                      {revoking === d.id ? 'Revoking…' : 'Revoke'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function OpenReviews({ reviews }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="Open Reviews" count={reviews.length} />
      {reviews.length === 0 ? (
        <p className="text-muted text-sm">No open reviews with this vendor yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {reviews.map(r => (
            <div key={r.id} className="px-4 py-3 rounded-lg border border-border bg-surface">
              <span className="text-foreground text-sm font-medium truncate">
                {r.title || r.asset?.name || '—'}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ReceivedEstimates({ estimates, expanded, onToggle }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionHeader title="Received Estimates" count={estimates.length} />
      {estimates.length === 0 ? (
        <p className="text-muted text-sm">No estimates received from this vendor yet.</p>
      ) : (
        <>
          <p className="text-muted text-xs -mt-1">
            Rate estimates shared by this vendor. These use the vendor's own labels and are read-only.
          </p>
          <div className="flex flex-col gap-2">
            {estimates.map(share => {
              const isOpen = expanded === share.dispatch_id
              return (
                <div key={share.dispatch_id} className="flex flex-col rounded-lg border border-border bg-surface">
                  <div className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground text-sm font-medium truncate">
                          {GRANULARITY_LABELS[share.granularity] ?? share.granularity}
                        </span>
                        {share.label && <span className="text-muted text-xs truncate">· {share.label}</span>}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span>Received {new Date(share.created_at).toLocaleDateString()}</span>
                        {share.expires_at && (
                          <>
                            <Dot />
                            <span>Expires {new Date(share.expires_at).toLocaleDateString()}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => onToggle(share.dispatch_id)}
                      className="px-3 py-1 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface border border-border transition-colors cursor-pointer shrink-0"
                    >
                      {isOpen ? 'Hide' : 'View'}
                    </button>
                  </div>
                  {isOpen && (
                    <div className="px-4 pb-4 pt-1 border-t border-border">
                      <EstimateSnapshotView snapshot={share.snapshot} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function VendorConnections() {
  const [links, setLinks]         = useState([])
  const [invites, setInvites]     = useState([])
  const [templates, setTemplates] = useState([])
  const [inbox, setInbox]         = useState([])   // estimate shares received from vendors
  const [outbox, setOutbox]       = useState([])   // shared-asset dispatches
  const [loading, setLoading]     = useState(true)

  const [selectedVendorId, setSelectedVendorId] = useState(null)
  const [expandedEstimate, setExpandedEstimate] = useState(null)  // dispatch_id

  const [inviteOpen, setInviteOpen]             = useState(false)
  const [cancelTarget, setCancelTarget]         = useState(null)  // { link, vendorName }
  const [resending, setResending]               = useState(null)
  const [cancellingInvite, setCancellingInvite] = useState(null)
  const [revoking, setRevoking]                 = useState(null)  // share dispatch id
  const [templateModal, setTemplateModal]       = useState(null)  // null | template row | 'new'
  const [deletingTemplate, setDeletingTemplate] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [l, inv, tmpl, ib, ob] = await Promise.all([
        apiFetch('/api/handshake/links'),
        apiFetch('/api/handshake/invites/sent'),
        apiFetch('/api/payloads/templates'),
        apiFetch('/api/estimate-shares/inbox').catch(() => []),
        apiFetch('/api/payloads/outbox').catch(() => []),
      ])
      setLinks(l)
      setInvites(inv)
      setTemplates(tmpl)
      setInbox(ib)
      setOutbox(ob)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Keep the selected vendor valid: default to the first connection, re-pick if the
  // current selection disappears (e.g. after cancelling), clear when none remain.
  useEffect(() => {
    if (loading) return
    if (links.length === 0) { setSelectedVendorId(null); return }
    if (!links.some(l => l.vendor_id === selectedVendorId)) {
      setSelectedVendorId(links[0].vendor_id)
    }
  }, [links, loading, selectedVendorId])

  const selectedLink = useMemo(
    () => links.find(l => l.vendor_id === selectedVendorId) ?? null,
    [links, selectedVendorId]
  )

  const vendorShares = useMemo(
    () => outbox.filter(d => d.recipient_vendor_id === selectedVendorId),
    [outbox, selectedVendorId]
  )

  const vendorEstimates = useMemo(
    () => inbox.filter(e =>
      (selectedLink && e.link_id === selectedLink.id) || e.vendor?.id === selectedVendorId
    ),
    [inbox, selectedLink, selectedVendorId]
  )

  // Reviews carry no vendor association in the schema yet — always empty for now.
  const vendorReviews = []

  async function cancelLink() {
    const { link } = cancelTarget
    try {
      const res = await apiFetch(`/api/handshake/links/${link.id}`, { method: 'DELETE' })
      toast.success(
        res.dispatches_revoked > 0
          ? `Connection cancelled — ${res.dispatches_revoked} dispatch${res.dispatches_revoked !== 1 ? 'es' : ''} revoked`
          : 'Connection cancelled'
      )
      setCancelTarget(null)
      await load()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function resendInvite(id) {
    setResending(id)
    try {
      const res = await apiFetch(`/api/handshake/invites/${id}/resend`, { method: 'POST' })
      toast.success(`Invite resent (${res.resend_count}/${MAX_RESENDS} resends used)`)
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setResending(null)
    }
  }

  async function cancelInvite(id) {
    setCancellingInvite(id)
    try {
      await apiFetch(`/api/handshake/invites/${id}`, { method: 'DELETE' })
      toast.success('Invite cancelled')
      setInvites(prev => prev.filter(i => i.id !== id))
    } catch (err) {
      toast.error(err.message)
    } finally {
      setCancellingInvite(null)
    }
  }

  async function revokeShare(id) {
    setRevoking(id)
    try {
      await apiFetch(`/api/payloads/dispatch/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast.success('Access revoked')
      const ob = await apiFetch('/api/payloads/outbox').catch(() => outbox)
      setOutbox(ob)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRevoking(null)
    }
  }

  async function deleteTemplate(id) {
    setDeletingTemplate(id)
    try {
      await apiFetch(`/api/payloads/templates/${id}`, { method: 'DELETE' })
      setTemplates(prev => prev.filter(t => t.id !== id))
      toast.success('Template deleted')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setDeletingTemplate(null)
    }
  }

  function toggleEstimate(dispatchId) {
    if (expandedEstimate === dispatchId) {
      setExpandedEstimate(null)
      return
    }
    setExpandedEstimate(dispatchId)
    // Best-effort view telemetry — never blocks the UI.
    apiFetch(`/api/estimate-shares/${dispatchId}/view`, { method: 'POST' }).catch(() => {})
  }

  const selectedVendor = selectedLink?.vendor ?? {}

  return (
    <PageContainer width="sm" className="p-6 gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-lg font-semibold">Vendors</h1>
        <button
          onClick={() => setInviteOpen(true)}
          className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer transition-colors"
        >
          + Connect a Vendor
        </button>
      </div>

      {loading && <p className="text-muted text-sm">Loading…</p>}

      {/* ── Vendor selector + connection summary ── */}
      {!loading && links.length === 0 && (
        <p className="text-muted text-sm">
          No vendor connections yet.{' '}
          <button onClick={() => setInviteOpen(true)} className="text-accent hover:underline cursor-pointer">
            Invite your first vendor.
          </button>
        </p>
      )}

      {!loading && links.length > 0 && (
        <div className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface">
          <div className="flex flex-col gap-1 min-w-0">
            <select
              value={selectedVendorId ?? ''}
              onChange={e => { setSelectedVendorId(e.target.value); setExpandedEstimate(null) }}
              className="bg-surface-2 border border-border rounded-md px-3 py-1.5 text-foreground text-sm font-medium outline-none focus:border-accent cursor-pointer max-w-xs"
            >
              {links.map(l => (
                <option key={l.id} value={l.vendor_id}>
                  {l.vendor?.name ?? 'Unknown Vendor'}
                </option>
              ))}
            </select>
            {selectedLink && (
              <div className="flex items-center gap-2 text-xs text-muted pl-0.5">
                {selectedVendor.handle && <span>@{selectedVendor.handle}</span>}
                {selectedVendor.handle && <Dot />}
                <span>{REVIEW_MODE_LABELS[selectedLink.review_collaboration_mode] ?? selectedLink.review_collaboration_mode}</span>
                <Dot />
                <span>Connected {new Date(selectedLink.created_at).toLocaleDateString()}</span>
              </div>
            )}
          </div>
          {selectedLink && (
            <button
              onClick={() => setCancelTarget({ link: selectedLink, vendorName: selectedVendor.name ?? 'this vendor' })}
              className="px-3 py-1 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors cursor-pointer shrink-0"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {/* ── Per-vendor hub ── */}
      {!loading && selectedLink && (
        <>
          <SharedAssets shares={vendorShares} revoking={revoking} onRevoke={revokeShare} />
          <OpenReviews reviews={vendorReviews} />
          <ReceivedEstimates
            estimates={vendorEstimates}
            expanded={expandedEstimate}
            onToggle={toggleEstimate}
          />
        </>
      )}

      {/* ── Pending invites (connections in progress) ── */}
      {!loading && invites.length > 0 && (
        <section className="flex flex-col gap-3 pt-2 border-t border-border">
          <SectionHeader title="Pending invites" count={invites.length} />
          <div className="flex flex-col gap-2">
            {invites.map(inv => {
              const canResend = inv.resend_count < MAX_RESENDS
              return (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground text-sm font-medium truncate">{inv.vendor_name}</span>
                      {inv.vendor_handle && <span className="text-muted text-xs">@{inv.vendor_handle}</span>}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <span className={cn(new Date(inv.expires_at) - Date.now() < 86400000 ? 'text-warning' : '')}>
                        {daysUntil(inv.expires_at)}
                      </span>
                      {inv.resend_count > 0 && (
                        <>
                          <Dot />
                          <span>Resent {inv.resend_count}/{MAX_RESENDS}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => resendInvite(inv.id)}
                      disabled={!canResend || resending === inv.id}
                      title={canResend ? 'Extend expiry by 7 days' : 'Maximum resends reached'}
                      className="px-3 py-1 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface border border-border transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {resending === inv.id ? 'Sending…' : 'Resend'}
                    </button>
                    <button
                      onClick={() => cancelInvite(inv.id)}
                      disabled={cancellingInvite === inv.id}
                      className="px-3 py-1 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-40"
                    >
                      {cancellingInvite === inv.id ? '…' : 'Cancel'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* ── Payload templates (studio-wide config) ── */}
      {!loading && (
        <section className="flex flex-col gap-3 pt-2 border-t border-border">
          <SectionHeader
            title="Payload Templates"
            count={templates.length}
            action={
              <button
                onClick={() => setTemplateModal('new')}
                className="px-2.5 py-1 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface border border-border transition-colors cursor-pointer"
              >
                + New template
              </button>
            }
          />
          {templates.length === 0 ? (
            <p className="text-muted text-sm">
              No templates yet.{' '}
              <button onClick={() => setTemplateModal('new')} className="text-accent hover:underline cursor-pointer">
                Create one
              </button>{' '}
              to control which fields are sent in each dispatch.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {templates.map(t => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-foreground text-sm font-medium truncate">{t.name}</span>
                    <span className="text-muted text-xs">
                      {t.field_schema?.length ?? 0} field{t.field_schema?.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setTemplateModal(t)}
                      className="px-3 py-1 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface border border-border transition-colors cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => deleteTemplate(t.id)}
                      disabled={deletingTemplate === t.id}
                      className="px-3 py-1 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 transition-colors cursor-pointer disabled:opacity-40"
                    >
                      {deletingTemplate === t.id ? '…' : 'Delete'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {inviteOpen && (
        <InviteVendorModal
          onClose={() => setInviteOpen(false)}
          onInvited={load}
        />
      )}

      {cancelTarget && (
        <CancelLinkModal
          link={cancelTarget.link}
          vendorName={cancelTarget.vendorName}
          onConfirm={cancelLink}
          onClose={() => setCancelTarget(null)}
        />
      )}

      {templateModal && (
        <PayloadTemplateModal
          template={templateModal === 'new' ? null : templateModal}
          onClose={() => setTemplateModal(null)}
          onSaved={saved => {
            setTemplates(prev => {
              const idx = prev.findIndex(t => t.id === saved.id)
              return idx >= 0
                ? prev.map(t => t.id === saved.id ? saved : t)
                : [...prev, saved]
            })
          }}
        />
      )}
    </PageContainer>
  )
}
