import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { getSupabase } from '../lib/supabase'
import SignupModal from '../components/SignupModal'

export default function Login() {
  const { session, role, loading } = useAuth()
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [error, setError]         = useState(null)
  const [busy, setBusy]           = useState(false)
  const [signupOpen, setSignupOpen] = useState(false)

  // Already logged in — redirect to appropriate home
  if (!loading && session) {
    return <Navigate to={role === 'vendor' ? '/vendor-home' : '/home'} replace />
  }

  async function handleLogin(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const sb = await getSupabase()
      const { error: err } = await sb.auth.signInWithPassword({ email, password })
      if (err) throw err
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-center min-h-screen p-8">
      <form
        onSubmit={handleLogin}
        className="bg-surface border border-border rounded-xl p-8 w-full max-w-sm flex flex-col gap-4"
      >
        <h1 className="text-foreground text-xl font-semibold">ArtHound</h1>

        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
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
            className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
          />
        </div>

        {error && <p className="text-error text-xs">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <button
          type="button"
          onClick={() => setSignupOpen(true)}
          className="text-muted text-xs text-center hover:text-foreground cursor-pointer"
        >
          Create account
        </button>
      </form>

      {signupOpen && <SignupModal onClose={() => setSignupOpen(false)} />}
    </div>
  )
}
