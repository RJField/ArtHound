import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/
const HANDLE_HINT = 'Lowercase letters, numbers, hyphens and underscores only. 3–32 characters.'

function errMsg(detail) {
  if (detail === 'HANDLE_TAKEN')        return 'That handle is already taken — try a different one.'
  if (detail === 'HANDLE_INVALID')      return HANDLE_HINT
  if (detail === 'INVITE_CODE_INVALID') return 'Invite code not found. Check the code and try again.'
  if (detail === 'ROLE_ORG_MISMATCH')   return 'This invite code is for a different account type.'
  if (detail === 'ALREADY_MEMBER')      return 'You already belong to an organisation.'
  return detail || 'Something went wrong. Please try again.'
}

const inputCls   = 'bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent'
const btnPrimary = 'px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50'
const btnBack    = 'text-muted hover:text-foreground cursor-pointer text-sm'

/**
 * Post-login onboarding for an authenticated user who has no org yet (RLS migration §0c, Option C).
 * The signup form stashed the chosen intent in the JWT user_metadata; we read it from the session
 * (onboardingIntent) and pre-fill the relevant form. Create → become owner of a new org; join →
 * request access to an existing one. The account role (studio/vendor) is fixed by the JWT.
 */
export default function Onboarding() {
  const { role, onboardingIntent, profile, pendingOrg, refreshProfile, signOut } = useAuth()
  const navigate = useNavigate()

  const intent = onboardingIntent
  const initialMode = intent?.intent === 'join' ? 'join'
                    : intent?.intent === 'create' ? 'create'
                    : 'choice'

  const [mode, setMode]             = useState(initialMode)
  const [orgName, setOrgName]       = useState(intent?.org_name || '')
  const [handle, setHandle]         = useState(intent?.handle || '')
  const [inviteCode, setInviteCode] = useState(intent?.invite_code || '')
  const [handleError, setHandleError] = useState(null)
  const [error, setError]           = useState(null)
  const [busy, setBusy]             = useState(false)

  // Onboarding already resolved (e.g. completed in another tab) → leave this screen.
  if (profile)    return <Navigate to="/" replace />
  if (pendingOrg) return <Navigate to="/pending" replace />

  const roleLabel = role === 'vendor' ? 'Vendor' : 'Studio'

  async function submitCreate(e) {
    e.preventDefault()
    const name = orgName.trim()
    if (!name) return
    if (role === 'vendor' && !HANDLE_RE.test(handle.trim().toLowerCase())) {
      setHandleError(HANDLE_HINT); return
    }
    setError(null); setHandleError(null); setBusy(true)
    try {
      const body = { org_name: name }
      if (role === 'vendor') body.handle = handle.trim().toLowerCase()
      await apiFetch('/api/onboarding/create', { method: 'POST', body: JSON.stringify(body) })
      await refreshProfile()
      navigate('/', { replace: true })
    } catch (err) {
      if (err.message === 'ALREADY_MEMBER') { await refreshProfile(); navigate('/', { replace: true }); return }
      if (err.message === 'HANDLE_TAKEN' || err.message === 'HANDLE_INVALID') setHandleError(errMsg(err.message))
      else setError(errMsg(err.message))
    } finally {
      setBusy(false)
    }
  }

  async function submitJoin(e) {
    e.preventDefault()
    const code = inviteCode.trim().toUpperCase()
    if (!code) return
    setError(null); setBusy(true)
    try {
      await apiFetch('/api/onboarding/join', { method: 'POST', body: JSON.stringify({ invite_code: code }) })
      await refreshProfile()           // → pending; InitGuard then routes to /pending
      navigate('/', { replace: true })
    } catch (err) {
      if (err.message === 'ALREADY_MEMBER') { await refreshProfile(); navigate('/', { replace: true }); return }
      setError(errMsg(err.message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-screen px-4 py-12">
      <div className="bg-surface border border-border rounded-xl p-8 w-full max-w-sm flex flex-col gap-5">

        {/* CHOICE — no stashed intent (legacy / stranded account) */}
        {mode === 'choice' && (
          <>
            <div className="flex flex-col gap-1">
              <h1 className="text-foreground text-lg font-semibold">Set up your account</h1>
              <p className="text-muted text-sm">You're signed in but not part of an organisation yet.</p>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => { setError(null); setMode('create') }}
                className="px-4 py-3 rounded-lg border border-border text-left text-foreground text-sm hover:border-accent hover:bg-surface-2 transition-colors cursor-pointer"
              >
                <div className="font-medium">Create a new organisation</div>
                <div className="text-muted text-xs mt-0.5">Set up a new {roleLabel.toLowerCase()} account</div>
              </button>
              <button
                onClick={() => { setError(null); setMode('join') }}
                className="px-4 py-3 rounded-lg border border-border text-left text-foreground text-sm hover:border-accent hover:bg-surface-2 transition-colors cursor-pointer"
              >
                <div className="font-medium">Join with an invite code</div>
                <div className="text-muted text-xs mt-0.5">Request access to an existing organisation</div>
              </button>
            </div>
          </>
        )}

        {/* CREATE — org name (+ vendor handle); role is fixed by the account */}
        {mode === 'create' && (
          <form onSubmit={submitCreate} className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              {initialMode === 'choice' && (
                <button type="button" onClick={() => { setError(null); setMode('choice') }} className={btnBack}>←</button>
              )}
              <h1 className="text-foreground text-lg font-semibold">Create your organisation</h1>
              <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-surface-2 text-muted">{roleLabel}</span>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">{role === 'vendor' ? 'Vendor / company name' : 'Studio name'}</label>
              <input
                type="text" value={orgName} onChange={e => setOrgName(e.target.value)}
                required autoFocus placeholder={role === 'vendor' ? 'Acme VFX' : 'Acme Studio'}
                className={inputCls}
              />
            </div>
            {role === 'vendor' && (
              <div className="flex flex-col gap-1">
                <label className="text-muted text-xs">Handle</label>
                <div className="flex items-center bg-surface-2 border border-border rounded-lg px-3 py-2 focus-within:border-accent">
                  <span className="text-muted text-sm select-none mr-0.5">@</span>
                  <input
                    type="text" value={handle}
                    onChange={e => { setHandle(e.target.value.toLowerCase()); setHandleError(null) }}
                    required placeholder="acme-vfx"
                    className="bg-transparent text-foreground text-sm outline-none flex-1 min-w-0"
                  />
                </div>
                {handleError
                  ? <p className="text-error text-xs mt-0.5">{handleError}</p>
                  : <p className="text-muted text-xs mt-0.5">{HANDLE_HINT}</p>}
              </div>
            )}
            {error && <p className="text-error text-xs">{error}</p>}
            <button type="submit" disabled={busy || !orgName.trim()} className={btnPrimary}>
              {busy ? 'Creating…' : 'Create organisation'}
            </button>
          </form>
        )}

        {/* JOIN — invite code */}
        {mode === 'join' && (
          <form onSubmit={submitJoin} className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              {initialMode === 'choice' && (
                <button type="button" onClick={() => { setError(null); setMode('choice') }} className={btnBack}>←</button>
              )}
              <h1 className="text-foreground text-lg font-semibold">Join an organisation</h1>
            </div>
            <p className="text-muted text-sm">
              Ask an admin at the organisation you're joining for their invite code.
            </p>
            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">Invite code</label>
              <input
                type="text" value={inviteCode}
                onChange={e => { setInviteCode(e.target.value.toUpperCase()); setError(null) }}
                required autoFocus placeholder="ABCD1234" maxLength={8}
                className={`${inputCls} tracking-widest font-mono uppercase`}
              />
            </div>
            {error && <p className="text-error text-xs">{error}</p>}
            <button type="submit" disabled={busy || !inviteCode.trim()} className={btnPrimary}>
              {busy ? 'Submitting…' : 'Request access'}
            </button>
          </form>
        )}

        <button
          onClick={signOut}
          className="text-muted text-xs text-center hover:text-foreground cursor-pointer"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
