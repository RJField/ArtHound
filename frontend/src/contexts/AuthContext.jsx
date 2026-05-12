import { createContext, useContext, useState, useEffect } from 'react'
import { getSupabase } from '../lib/supabase'
import { apiFetch, setAccessToken } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession]       = useState(undefined) // undefined = loading
  const [profile, setProfile]       = useState(null)      // from /api/user/me (full profile)
  const [pendingOrg, setPendingOrg] = useState(null)      // {org_name, org_type} when awaiting approval
  const [profileLoading, setProfileLoading] = useState(false)
  const [profileError, setProfileError]     = useState(false) // true after all retries exhausted

  useEffect(() => {
    getSupabase().then(sb => {
      sb.auth.getSession().then(({ data }) => {
        setAccessToken(data.session?.access_token ?? null)
        setSession(data.session)
      })
      const { data: { subscription } } = sb.auth.onAuthStateChange((_e, s) => {
        setAccessToken(s?.access_token ?? null)
        setSession(s)
      })
      return () => subscription.unsubscribe()
    }).catch(() => {
      setAccessToken(null)
      setSession(null)
    })
  }, [])

  // Fetch profile only when the logged-in user changes — not on every token refresh.
  // Token refreshes change the session object reference but keep the same user ID,
  // so depending on session?.user?.id avoids spurious profile refetches and
  // prevents InitGuard from remounting the page component unnecessarily.
  useEffect(() => {
    if (!session) {
      setProfile(null)
      setPendingOrg(null)
      setProfileLoading(false)
      setProfileError(false)
      return
    }
    const controller = new AbortController()
    let retryTimer = null
    setProfileLoading(true)
    setProfileError(false)

    function handleProfileData(data) {
      if (data?.status === 'pending') {
        setPendingOrg({ org_name: data.org_name, org_type: data.org_type })
        setProfile(null)
      } else {
        setProfile(data)
        setPendingOrg(null)
      }
      setProfileError(false)
      setProfileLoading(false)
    }

    apiFetch('/api/user/me', { signal: controller.signal })
      .then(handleProfileData)
      .catch(err => {
        if (err.name === 'AbortError') return
        console.warn('Profile fetch failed, retrying:', err)
        retryTimer = setTimeout(() => {
          apiFetch('/api/user/me', { signal: controller.signal })
            .then(handleProfileData)
            .catch(e => {
              if (e.name !== 'AbortError') {
                console.warn('Profile fetch retry failed:', e)
                setProfileError(true)
                setProfileLoading(false)
              }
            })
        }, 1500)
      })

    return () => { controller.abort(); if (retryTimer) clearTimeout(retryTimer) }
  }, [session?.user?.id]) // eslint-disable-line react-hooks/exhaustive-deps


  async function signOut() {
    const sb = await getSupabase()
    await sb.auth.signOut()
  }

  async function refreshProfile() {
    if (!session) return
    setProfileLoading(true)
    setProfileError(false)
    try {
      const data = await apiFetch('/api/user/me')
      if (data?.status === 'pending') {
        setPendingOrg({ org_name: data.org_name, org_type: data.org_type })
        setProfile(null)
      } else {
        setProfile(data)
        setPendingOrg(null)
      }
    } catch {
      setProfileError(true)
    } finally {
      setProfileLoading(false)
    }
  }

  const role            = session?.user?.app_metadata?.role ?? null
  // isAdmin derives from member_role in the profile (set by the DB), not from JWT metadata.
  const isAdmin         = profile?.member_role === 'owner' || profile?.member_role === 'admin'
  const isPlatformAdmin = profile?.is_platform_admin === true
  const loading         = session === undefined
  const initialized     = profile?.org?.initialized_at != null

  return (
    <AuthContext.Provider value={{
      session, profile, pendingOrg, profileLoading, profileError,
      role, isAdmin, isPlatformAdmin, loading, initialized,
      signOut, refreshProfile,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
