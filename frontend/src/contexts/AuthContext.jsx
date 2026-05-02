import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { getSupabase } from '../lib/supabase'
import { apiFetch } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession]   = useState(undefined) // undefined = loading
  const [profile, setProfile]   = useState(null)      // from /api/user/me
  const syncFired               = useRef(false)

  useEffect(() => {
    getSupabase().then(sb => {
      sb.auth.getSession().then(({ data }) => setSession(data.session))
      const { data: { subscription } } = sb.auth.onAuthStateChange((_e, s) => {
        setSession(s)
      })
      return () => subscription.unsubscribe()
    }).catch(() => setSession(null))
  }, [])

  // Fetch profile whenever session appears
  useEffect(() => {
    if (!session) { setProfile(null); return }
    apiFetch('/api/user/me').then(setProfile).catch(console.warn)
  }, [session])

  // Trigger background sync once per login
  useEffect(() => {
    if (!session || syncFired.current) return
    syncFired.current = true
    apiFetch('/api/sync/run', { method: 'POST', body: JSON.stringify({}) }).catch(console.warn)
  }, [session])

  async function signOut() {
    const sb = await getSupabase()
    syncFired.current = false
    await sb.auth.signOut()
  }

  async function refreshProfile() {
    if (!session) return
    const data = await apiFetch('/api/user/me')
    setProfile(data)
  }

  const role        = session?.user?.app_metadata?.role ?? null
  const isAdmin     = session?.user?.email === 'rjfield@pm.me'
  const loading     = session === undefined
  const initialized = profile?.org?.initialized_at != null

  return (
    <AuthContext.Provider value={{ session, profile, role, isAdmin, loading, initialized, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
