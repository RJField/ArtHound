import { useState } from 'react'
import { apiFetch } from '../lib/api'

const STEP = { ROLE: 1, CREDENTIALS: 2, HANDLE: 3, SUCCESS: 4 }

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/
const HANDLE_HINT = 'Lowercase letters, numbers, hyphens and underscores only. 3–32 characters, must start with a letter or number.'

function handleErrorMessage(detail) {
  if (detail === 'HANDLE_TAKEN')    return 'That handle is already taken — try a different one.'
  if (detail === 'HANDLE_INVALID')  return HANDLE_HINT
  return detail
}

export default function SignupModal({ onClose }) {
  const [step, setStep]         = useState(STEP.ROLE)
  const [role, setRole]         = useState(null)
  const [orgName, setOrgName]   = useState('')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [handle, setHandle]     = useState('')
  const [handleError, setHandleError] = useState(null)
  const [error, setError]       = useState(null)
  const [busy, setBusy]         = useState(false)
  const [emailConfirmRequired, setEmailConfirmRequired] = useState(false)

  function advanceFromCredentials(e) {
    e.preventDefault()
    if (role === 'vendor') {
      setStep(STEP.HANDLE)
    } else {
      submitSignup()
    }
  }

  async function submitSignup(e) {
    if (e) e.preventDefault()

    if (role === 'vendor') {
      if (!HANDLE_RE.test(handle)) {
        setHandleError(HANDLE_HINT)
        return
      }
      setHandleError(null)
    }

    setError(null)
    setBusy(true)
    try {
      const body = { email, password, role, org_name: orgName }
      if (role === 'vendor') body.handle = handle

      const data = await apiFetch('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      setEmailConfirmRequired(data.email_confirmation_required)
      setStep(STEP.SUCCESS)
    } catch (err) {
      const msg = handleErrorMessage(err.message)
      // If the error is handle-related, drop back to handle step with inline error
      if (err.message === 'HANDLE_TAKEN' || err.message === 'HANDLE_INVALID') {
        setHandleError(msg)
        setStep(STEP.HANDLE)
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const orgLabel = role === 'studio' ? 'Studio name' : 'Vendor / company name'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl p-8 w-full max-w-sm flex flex-col gap-5">

        {/* Step 1 — Role */}
        {step === STEP.ROLE && (
          <>
            <h2 className="text-foreground text-lg font-semibold">Create account</h2>
            <p className="text-muted text-sm">What best describes you?</p>
            <div className="flex flex-col gap-3">
              {['studio', 'vendor'].map(r => (
                <button
                  key={r}
                  onClick={() => { setRole(r); setStep(STEP.CREDENTIALS) }}
                  className="px-4 py-3 rounded-lg border border-border text-left text-foreground text-sm hover:border-accent hover:bg-surface-2 transition-colors cursor-pointer capitalize"
                >
                  {r === 'studio' ? '🎬 Studio — I manage productions' : '🎨 Vendor — I deliver creative work'}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="text-muted text-xs text-center hover:text-foreground cursor-pointer">
              Cancel
            </button>
          </>
        )}

        {/* Step 2 — Org name + credentials */}
        {step === STEP.CREDENTIALS && (
          <form onSubmit={advanceFromCredentials} className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setStep(STEP.ROLE)} className="text-muted hover:text-foreground cursor-pointer text-sm">←</button>
              <h2 className="text-foreground text-lg font-semibold">Create account</h2>
              <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-surface-2 text-muted capitalize">{role}</span>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">{orgLabel}</label>
              <input
                type="text"
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                required
                autoFocus
                placeholder={role === 'studio' ? 'Acme Studio' : 'Acme VFX'}
                className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">Email</label>
              <input
                type="text"
                inputMode="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={8}
                className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
              />
            </div>

            {error && <p className="text-error text-xs">{error}</p>}

            <button
              type="submit"
              disabled={busy || !orgName.trim()}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              {role === 'vendor' ? 'Next →' : (busy ? 'Creating…' : 'Create account')}
            </button>
          </form>
        )}

        {/* Step 3 — Handle (vendor only) */}
        {step === STEP.HANDLE && (
          <form onSubmit={submitSignup} className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setStep(STEP.CREDENTIALS)} className="text-muted hover:text-foreground cursor-pointer text-sm">←</button>
              <h2 className="text-foreground text-lg font-semibold">Choose a handle</h2>
            </div>

            <p className="text-muted text-sm">
              Studios use your handle to find and invite you. You can't change it later without contacting support.
            </p>

            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">Handle</label>
              <div className="flex items-center bg-surface-2 border border-border rounded-lg px-3 py-2 focus-within:border-accent">
                <span className="text-muted text-sm select-none mr-0.5">@</span>
                <input
                  type="text"
                  value={handle}
                  onChange={e => {
                    setHandle(e.target.value.toLowerCase())
                    setHandleError(null)
                  }}
                  required
                  autoFocus
                  placeholder="acme-vfx"
                  className="bg-transparent text-foreground text-sm outline-none flex-1 min-w-0"
                />
              </div>
              {handleError
                ? <p className="text-error text-xs mt-0.5">{handleError}</p>
                : <p className="text-muted text-xs mt-0.5">{HANDLE_HINT}</p>
              }
            </div>

            <button
              type="submit"
              disabled={busy || !handle.trim()}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>
        )}

        {/* Step 4 — Success */}
        {step === STEP.SUCCESS && (
          <>
            <h2 className="text-foreground text-lg font-semibold">
              {emailConfirmRequired ? 'Check your email' : 'Account created'}
            </h2>
            <p className="text-muted text-sm">
              {emailConfirmRequired
                ? <>We sent a confirmation link to <span className="text-foreground">{email}</span>. Click the link to activate your account, then come back to sign in.</>
                : <>Your account is ready. Sign in with <span className="text-foreground">{email}</span> to get started.</>
              }
            </p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer"
            >
              {emailConfirmRequired ? 'Back to sign in' : 'Sign in now'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
