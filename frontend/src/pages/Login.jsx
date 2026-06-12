import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { getSupabase } from '../lib/supabase'
import SignupModal from '../components/SignupModal'
import { Button, Field, Input } from '../components/ui'

export default function Login() {
  const { session, loading } = useAuth()
  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [error, setError]         = useState(null)
  const [busy, setBusy]           = useState(false)
  const [signupOpen, setSignupOpen] = useState(false)

  // Already logged in — let InitGuard decide final destination once profile loads
  if (!loading && session) {
    return <Navigate to="/" replace />
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
    <div className="flex items-center justify-center min-h-screen p-8 relative overflow-hidden">
      <div
        className="absolute inset-0 bg-cover bg-center pointer-events-none -z-10"
        style={{ backgroundImage: 'url(/login_background.png)' }}
      />
      <form
        onSubmit={handleLogin}
        className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm flex flex-col gap-4"
      >
        <h1 className="text-foreground text-xl font-semibold">ArtHound</h1>

        <Field label="Email">
          <Input
            size="lg"
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Field>

        <Field label="Password" error={error}>
          <Input
            size="lg"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>

        <button
          type="button"
          onClick={() => setSignupOpen(true)}
          className="text-muted text-xs text-center hover:text-foreground cursor-pointer"
        >
          Create account
        </button>

        <p className="text-faint text-xs text-center mt-2">© 2026 FieldTech. All rights reserved.</p>
      </form>

      {signupOpen && <SignupModal onClose={() => setSignupOpen(false)} />}
    </div>
  )
}
