import { useState } from 'react'

const STEP = { ROLE: 1, CREDENTIALS: 2, SUCCESS: 3 }

export default function SignupModal({ onClose }) {
  const [step, setStep]         = useState(STEP.ROLE)
  const [role, setRole]         = useState(null)
  const [orgName, setOrgName]   = useState('')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState(null)
  const [busy, setBusy]         = useState(false)

  const [emailConfirmRequired, setEmailConfirmRequired] = useState(false)

  async function handleSignup(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, role, org_name: orgName }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail ?? data.error ?? res.statusText)
      setEmailConfirmRequired(data.email_confirmation_required)
      setStep(STEP.SUCCESS)
    } catch (err) {
      setError(err.message)
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
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
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
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>
        )}

        {/* Step 3 — Success */}
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
