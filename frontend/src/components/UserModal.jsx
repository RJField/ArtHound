import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'

export default function UserModal({ onClose }) {
  const { profile, role, isAdmin, refreshProfile, signOut } = useAuth()
  const navigate = useNavigate()
  const [orgs, setOrgs]           = useState(null)
  const [selectedOrg, setSelected] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [error, setError]         = useState(null)

  // Delete account state
  const [showDeleteZone, setShowDeleteZone] = useState(false)
  const [deleteConfirm, setDeleteConfirm]   = useState('')
  const [deleting, setDeleting]             = useState(false)
  const [deleteError, setDeleteError]       = useState(null)

  useEffect(() => {
    if (profile?.org) return
    apiFetch('/api/user/orgs').then(setOrgs).catch(console.warn)
  }, [profile])

  async function handleAssign(e) {
    e.preventDefault()
    if (!selectedOrg) return
    setError(null)
    setAssigning(true)
    try {
      await apiFetch('/api/user/assign', {
        method: 'POST',
        body: JSON.stringify({ org_id: selectedOrg }),
      })
      await refreshProfile()
    } catch (err) {
      setError(err.message)
    } finally {
      setAssigning(false)
    }
  }

  async function handleReconcile() {
    try {
      await apiFetch('/api/schedule/reconcile-tasks', { method: 'POST' })
    } catch (err) {
      console.warn('Reconcile error:', err)
    }
  }

  async function handleDeleteAccount() {
    if (deleteConfirm !== 'DELETE') return
    setDeleting(true)
    setDeleteError(null)
    try {
      await apiFetch('/api/user/account', { method: 'DELETE' })
      await signOut()
      navigate('/login', { replace: true })
    } catch (err) {
      setDeleteError(err.message)
      setDeleting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl p-8 w-full max-w-sm flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="text-foreground text-lg font-semibold">Account</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        <div className="flex flex-col gap-3">
          <Row label="Email">{profile?.email ?? '—'}</Row>
          <Row label="Role">
            <span className="capitalize px-2 py-0.5 rounded-full bg-surface-2 text-xs text-muted">
              {role ?? '—'}
            </span>
          </Row>
          <Row label="Org">
            {profile?.org ? profile.org.name : <span className="text-muted text-xs italic">Not assigned</span>}
          </Row>
        </div>

        {/* Self-assign (only when no org set) */}
        {!profile?.org && orgs && (
          <form onSubmit={handleAssign} className="flex flex-col gap-3 pt-2 border-t border-border">
            <p className="text-muted text-xs">Assign yourself to a {role}:</p>
            <select
              value={selectedOrg}
              onChange={e => setSelected(e.target.value)}
              className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
            >
              <option value="">Select…</option>
              {orgs.map(o => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
            {error && <p className="text-error text-xs">{error}</p>}
            <button
              type="submit"
              disabled={assigning || !selectedOrg}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              {assigning ? 'Saving…' : 'Assign'}
            </button>
          </form>
        )}

        {/* Admin tools */}
        {isAdmin && (
          <div className="pt-2 border-t border-border flex flex-col gap-2">
            <p className="text-muted text-xs">Admin</p>
            <button
              onClick={handleReconcile}
              className="px-4 py-2 rounded-lg bg-surface-2 text-foreground text-sm hover:bg-surface-3 transition-colors cursor-pointer text-left"
            >
              Reconcile tasks
            </button>
          </div>
        )}

        {/* Danger zone */}
        <div className="pt-2 border-t border-border">
          {!showDeleteZone ? (
            <button
              onClick={() => setShowDeleteZone(true)}
              className="text-xs text-error/70 hover:text-error transition-colors cursor-pointer"
            >
              Delete account…
            </button>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-error text-xs font-medium">Delete account</p>
              <p className="text-muted text-xs">
                This permanently deletes all your integration data, tasks, and settings.
                Canonical asset IDs are preserved. This cannot be undone.
              </p>
              <p className="text-muted text-xs">
                Type <span className="text-foreground font-mono">DELETE</span> to confirm:
              </p>
              <input
                type="text"
                value={deleteConfirm}
                onChange={e => setDeleteConfirm(e.target.value)}
                placeholder="DELETE"
                className="bg-surface-2 border border-error/40 rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-error font-mono"
              />
              {deleteError && <p className="text-error text-xs">{deleteError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={handleDeleteAccount}
                  disabled={deleting || deleteConfirm !== 'DELETE'}
                  className="flex-1 px-3 py-2 rounded-lg bg-error text-white text-sm font-medium hover:bg-error/80 transition-colors cursor-pointer disabled:opacity-40"
                >
                  {deleting ? 'Deleting…' : 'Delete everything'}
                </button>
                <button
                  onClick={() => { setShowDeleteZone(false); setDeleteConfirm(''); setDeleteError(null) }}
                  disabled={deleting}
                  className="px-3 py-2 rounded-lg bg-surface-2 text-foreground text-sm hover:bg-surface-3 transition-colors cursor-pointer disabled:opacity-40"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted text-xs w-16 shrink-0">{label}</span>
      <span className="text-foreground text-sm">{children}</span>
    </div>
  )
}
