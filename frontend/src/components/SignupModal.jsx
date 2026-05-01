import { useState } from 'react'
import { getSupabase } from '../lib/supabase'

const STEP = { ROLE: 1, CREDENTIALS: 2, SUCCESS: 3 }

export default function SignupModal({ onClose }) {
  const [step, setStep]         = useState(STEP.ROLE)
  const [role, setRole]         = useState(null)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState(null)
  const [busy, setBusy]         = useState(false)

  async function handleSignup(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const sb = await getSupabase()
      const { error: err } = await sb.auth.signUp({
        email,
        password,
        options: { data: { role } },
      })
      if (err) throw err
      setStep(STEP.SUCCESS)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

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

        {/* Step 2 — Credentials */}
        {step === STEP.CREDENTIALS && (
          <form onSubmit={handleSignup} className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setStep(STEP.ROLE)} className="text-muted hover:text-foreground cursor-pointer text-sm">←</button>
              <h2 className="text-foreground text-lg font-semibold">Create account</h2>
              <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-surface-2 text-muted capitalize">{role}</span>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">Email</label>
              <input
                type="email"
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
              disabled={busy}
              className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </form>
        )}

        {/* Step 3 — Success */}
        {step === STEP.SUCCESS && (
          <>
            <h2 className="text-foreground text-lg font-semibold">Check your email</h2>
            <p className="text-muted text-sm">
              We sent a confirmation link to <span className="text-foreground">{email}</span>.
              Click the link to activate your account, then come back to sign in.
            </p>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-surface-2 text-foreground text-sm hover:bg-surface-3 transition-colors cursor-pointer"
            >
              Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  )
}
