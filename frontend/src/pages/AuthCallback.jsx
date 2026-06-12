import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { getSupabase } from '../lib/supabase'
import { Spinner } from '../components/ui'

export default function AuthCallback() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    const code = searchParams.get('code')
    if (!code) {
      navigate('/', { replace: true })
      return
    }

    getSupabase()
      .then(sb => sb.auth.exchangeCodeForSession(code))
      .then(({ error: err }) => {
        if (err) setError(err.message)
        else navigate('/', { replace: true })
      })
      .catch(err => setError(err.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen p-8">
        <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm flex flex-col gap-4">
          <h1 className="text-foreground text-lg font-semibold">Confirmation failed</h1>
          <p className="text-muted text-sm">{error}</p>
          <a href="/login" className="text-link text-sm hover:underline">Back to login</a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="flex items-center gap-2 text-muted text-sm">
        <Spinner size={14} />
        Confirming your account…
      </div>
    </div>
  )
}
