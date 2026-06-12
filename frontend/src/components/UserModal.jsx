import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import { Button, Field, Modal, Pill } from './ui'

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
    <Modal title="Account" onClose={onClose} width="max-w-sm" bodyClassName="flex flex-col gap-5 px-5 py-5">
      <div className="flex flex-col gap-3">
        <Row label="Email">{email}</Row>
        <Row label="Role">
          <Pill tone="neutral" className="capitalize">{role ?? '—'}</Pill>
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
            <form onSubmit={saveHandle} className="pt-1">
              <Field label="Handle" error={handleError} hint={HANDLE_HINT}>
                <div className="flex items-center gap-2">
                  <div className="flex items-center flex-1 h-7 bg-surface-2 border border-border rounded-md px-2.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 transition-colors">
                    <span className="text-muted text-sm select-none mr-0.5">@</span>
                    <input
                      type="text"
                      value={handleDraft}
                      onChange={e => { setHandleDraft(e.target.value.toLowerCase()); setHandleError(null) }}
                      autoFocus
                      className="bg-transparent text-foreground text-sm outline-none flex-1 min-w-0 placeholder:text-faint"
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={savingHandle || !handleDraft.trim()}
                    className="shrink-0"
                  >
                    {savingHandle ? 'Saving…' : 'Save'}
                  </Button>
                  <Button
                    onClick={() => setEditingHandle(false)}
                    disabled={savingHandle}
                    className="shrink-0"
                  >
                    Cancel
                  </Button>
                </div>
              </Field>
            </form>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <span className="text-faint text-xs w-16 shrink-0">Handle</span>
              <div className="flex items-center gap-2 flex-1 justify-end">
                <span className="text-foreground text-sm">
                  {profile?.org?.handle
                    ? <span className="font-mono text-xs">@{profile.org.handle}</span>
                    : <span className="text-muted text-xs italic">Not set</span>
                  }
                </span>
                <Button variant="ghost" size="sm" onClick={startHandleEdit}>
                  {profile?.org?.handle ? 'Edit' : 'Set'}
                </Button>
              </div>
            </div>
          )
        )}
      </div>

      {/* Danger zone */}
      <div className="pt-2 border-t border-border-soft">
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
              className="h-8 bg-surface-2 border border-error/40 rounded-md px-3 text-foreground text-sm outline-none focus:border-error font-mono placeholder:text-faint"
            />
            {deleteError && <p className="text-error text-xs">{deleteError}</p>}
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="lg"
                onClick={handleDeleteAccount}
                disabled={deleting || deleteConfirm !== 'DELETE'}
                className="flex-1"
              >
                {deleting ? 'Deleting…' : 'Delete everything'}
              </Button>
              <Button
                size="lg"
                onClick={() => { setShowDeleteZone(false); setDeleteConfirm(''); setDeleteError(null) }}
                disabled={deleting}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function Row({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-faint text-xs w-16 shrink-0">{label}</span>
      <span className="text-foreground text-sm">{children}</span>
    </div>
  )
}
