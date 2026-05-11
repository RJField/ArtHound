import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import InviteVendorModal from '../components/InviteVendorModal'
import PayloadTemplateModal from '../components/PayloadTemplateModal'

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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function VendorConnections() {
  const [links, setLinks]           = useState([])
  const [invites, setInvites]       = useState([])
  const [templates, setTemplates]   = useState([])
  const [loading, setLoading]       = useState(true)

  const [inviteOpen, setInviteOpen]         = useState(false)
  const [cancelTarget, setCancelTarget]     = useState(null)  // { link, vendorName }
  const [resending, setResending]           = useState(null)
  const [cancellingInvite, setCancellingInvite] = useState(null)
  const [templateModal, setTemplateModal]   = useState(null)  // null | template row | 'new'
  const [deletingTemplate, setDeletingTemplate] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [l, inv, tmpl] = await Promise.all([
        apiFetch('/api/handshake/links'),
        apiFetch('/api/handshake/invites/sent'),
        apiFetch('/api/payloads/templates'),
      ])
      setLinks(l)
      setInvites(inv)
      setTemplates(tmpl)
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

  return (
    <main className="flex-1 flex flex-col p-6 gap-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-foreground text-lg font-semibold">Vendor Connections</h1>
        <button
          onClick={() => setInviteOpen(true)}
          className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer transition-colors"
        >
          + Connect a Vendor
        </button>
      </div>

      {loading && <p className="text-muted text-sm">Loading…</p>}

      {/* Active connections */}
      {!loading && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted text-xs font-medium uppercase tracking-wider">
            Active connections ({links.length})
          </h2>

          {links.length === 0 ? (
            <p className="text-muted text-sm">
              No vendor connections yet.{' '}
              <button onClick={() => setInviteOpen(true)} className="text-accent hover:underline cursor-pointer">
                Invite your first vendor.
              </button>
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {links.map(link => {
                const vendor = link.vendor ?? {}
                const vendorName = vendor.name ?? 'Unknown Vendor'
                return (
                  <div
                    key={link.id}
                    className="flex items-center justify-between gap-4 px-4 py-3 rounded-lg border border-border bg-surface"
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground text-sm font-medium truncate">{vendorName}</span>
                        {vendor.handle && (
                          <span className="text-muted text-xs">@{vendor.handle}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted">
                        <span>{REVIEW_MODE_LABELS[link.review_collaboration_mode] ?? link.review_collaboration_mode}</span>
                        <Dot />
                        <span>Connected {new Date(link.created_at).toLocaleDateString()}</span>
                      </div>
                    </div>

                    <button
                      onClick={() => setCancelTarget({ link, vendorName })}
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

      {/* Pending invites */}
      {!loading && invites.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted text-xs font-medium uppercase tracking-wider">
            Pending invites ({invites.length})
          </h2>
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
                      {inv.vendor_handle && (
                        <span className="text-muted text-xs">@{inv.vendor_handle}</span>
                      )}
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

      {/* Payload Templates */}
      {!loading && (
        <section className="flex flex-col gap-3 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <h2 className="text-muted text-xs font-medium uppercase tracking-wider">
              Payload Templates ({templates.length})
            </h2>
            <button
              onClick={() => setTemplateModal('new')}
              className="px-2.5 py-1 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface border border-border transition-colors cursor-pointer"
            >
              + New template
            </button>
          </div>

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
    </main>
  )
}
