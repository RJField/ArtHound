import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/
const HANDLE_HINT = 'Lowercase letters, numbers, hyphens and underscores. 3–32 chars, start with a letter or number.'

function handleErrorMessage(detail) {
  if (detail === 'HANDLE_TAKEN')   return 'That handle is already taken — try a different one.'
  if (detail === 'HANDLE_INVALID') return HANDLE_HINT
  return detail
}

export default function UserModal({ onClose }) {
  const { session, profile, pendingOrg, role, refreshProfile, signOut } = useAuth()
  const navigate = useNavigate()

  // Email comes from profile when fully active, from session when pending.
  const email = profile?.email ?? session?.user?.email ?? '—'

  // Handle edit state (vendor only)
  const [editingHandle, setEditingHandle] = useState(false)
  const [handleDraft, setHandleDraft]     = useState('')
  const [handleError, setHandleError]     = useState(null)
  const [savingHandle, setSavingHandle]   = useState(false)

  // Delete account state
  const [showDeleteZone, setShowDeleteZone] = useState(false)
  const [deleteConfirm, setDeleteConfirm]   = useState('')
  const [deleting, setDeleting]             = useState(false)
  const [deleteError, setDeleteError]       = useState(null)

  function startHandleEdit() {
    setHandleDraft(profile?.org?.handle ?? '')
    setHandleError(null)
    setEditingHandle(true)
  }

  async function saveHandle(e) {
    e.preventDefault()
    if (!HANDLE_RE.test(handleDraft)) {
      setHandleError(HANDLE_HINT)
      return
    }
    setSavingHandle(true)
    setHandleError(null)
    try {
      await apiFetch('/api/user/handle', {
        method: 'PATCH',
        body: JSON.stringify({ handle: handleDraft }),
      })
      await refreshProfile()
      setEditingHandle(false)
    } catch (err) {
      setHandleError(handleErrorMessage(err.message))
    } finally {
      setSavingHandle(false)
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
          <Row label="Email">{email}</Row>
          <Row label="Role">
            <span className="capitalize px-2 py-0.5 rounded-full bg-surface-2 text-xs text-muted">
              {role ?? '—'}
            </span>
          </Row>
          <Row label="Org">
            {profile?.org
              ? profile.org.name
              : pendingOrg
                ? <span className="text-muted text-xs italic">{pendingOrg.org_name} (pending approval)</span>
                : <span className="text-muted text-xs italic">Not assigned</span>
            }
          </Row>

          {role === 'vendor' && (
            editingHandle ? (
              <form onSubmit={saveHandle} className="flex flex-col gap-1.5 pt-1">
                <span className="text-muted text-xs">Handle</span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center flex-1 bg-surface-2 border border-border rounded-lg px-3 py-1.5 focus-within:border-accent">
                    <span className="text-muted text-sm select-none mr-0.5">@</span>
                    <input
                      type="text"
                      value={handleDraft}
                      onChange={e => { setHandleDraft(e.target.value.toLowerCase()); setHandleError(null) }}
                      autoFocus
                      className="bg-transparent text-foreground text-sm outline-none flex-1 min-w-0"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={savingHandle || !handleDraft.trim()}
                    className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    {savingHandle ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingHandle(false)}
                    disabled={savingHandle}
                    className="px-3 py-1.5 rounded-lg bg-surface-2 text-muted text-xs hover:text-foreground cursor-pointer disabled:opacity-50 shrink-0"
                  >
                    Cancel
                  </button>
                </div>
                {handleError
                  ? <p className="text-error text-xs">{handleError}</p>
                  : <p className="text-muted text-xs">{HANDLE_HINT}</p>
                }
              </form>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted text-xs w-16 shrink-0">Handle</span>
                <div className="flex items-center gap-2 flex-1 justify-end">
                  <span className="text-foreground text-sm">
                    {profile?.org?.handle
                      ? <span className="font-mono">@{profile.org.handle}</span>
                      : <span className="text-muted text-xs italic">Not set</span>
                    }
                  </span>
                  <button
                    onClick={startHandleEdit}
                    className="text-muted text-xs hover:text-foreground cursor-pointer transition-colors"
                  >
                    {profile?.org?.handle ? 'Edit' : 'Set'}
                  </button>
                </div>
              </div>
            )
          )}
        </div>

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
