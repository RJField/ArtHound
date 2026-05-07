import { createContext, useContext, useState, useEffect } from 'react'
import { getSupabase } from '../lib/supabase'
import { apiFetch } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession]       = useState(undefined) // undefined = loading
  const [profile, setProfile]       = useState(null)      // from /api/user/me
  const [profileLoading, setProfileLoading] = useState(false)

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
    if (!session) { setProfile(null); setProfileLoading(false); return }
    setProfileLoading(true)
    apiFetch('/api/user/me')
      .then(data => { setProfile(data); setProfileLoading(false) })
      .catch(err => {
        console.warn('Profile fetch failed:', err)
        // Retry once after a short delay — handles transient token-propagation races
        setTimeout(() => {
          apiFetch('/api/user/me')
            .then(data => { setProfile(data); setProfileLoading(false) })
            .catch(e => { console.warn('Profile fetch retry failed:', e); setProfileLoading(false) })
        }, 1500)
      })
  }, [session])


  async function signOut() {
    const sb = await getSupabase()
    await sb.auth.signOut()
  }

  async function refreshProfile() {
    if (!session) return
    const data = await apiFetch('/api/user/me')
    setProfile(data)
  }

  const role        = session?.user?.app_metadata?.role ?? null
  const isAdmin     = session?.user?.app_metadata?.is_admin === true
  const loading     = session === undefined
  const initialized = profile?.org?.initialized_at != null

  return (
    <AuthContext.Provider value={{ session, profile, profileLoading, role, isAdmin, loading, initialized, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
