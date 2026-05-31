import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { AppProvider } from './contexts/AppContext'
import Topbar from './components/Topbar'
import Login from './pages/Login'
import StudioHome from './pages/StudioHome'
import VendorHome from './pages/VendorHome'
import Shares from './pages/Shares'
import VendorInbox from './pages/VendorInbox'
import Reviews from './pages/Reviews'
import Assets from './pages/Assets'
import ProjectInit from './pages/ProjectInit'
import VendorConnections from './pages/VendorConnections'
import StudioConnections from './pages/StudioConnections'
import AuthCallback from './pages/AuthCallback'
import PendingApproval from './pages/PendingApproval'
import Onboarding from './pages/Onboarding'
import OrgHub from './pages/OrgHub'
import AdminPanel from './pages/AdminPanel'
import ScenarioPlanner from './pages/ScenarioPlanner'

function AuthGuard() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted text-sm">Loading…</p>
      </div>
    )
  }

  if (!session) return <Navigate to="/login" replace />

  return (
    <div className="flex flex-col min-h-screen">
      <Topbar />
      <Outlet />
    </div>
  )
}

// Redirect users who haven't completed source init to the wizard.
// Also intercepts pending users (awaiting org approval → /pending) and member-less users who still
// need to create or join an org (Option C → /onboarding).
function InitGuard() {
  const { session, loading, profile, pendingOrg, needsOnboarding, profileLoading, profileError, initialized, refreshProfile } = useAuth()

  if (loading || !session) return null

  if (pendingOrg) return <Navigate to="/pending" replace />

  if (needsOnboarding) return <Navigate to="/onboarding" replace />

  if (!profile) {
    return (
      <div className="flex items-center justify-center flex-1 py-24">
        {profileError ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-muted text-sm">Unable to reach the server. Check your connection and try again.</p>
            <button
              onClick={refreshProfile}
              className="px-4 py-2 text-sm rounded bg-surface-2 border border-border text-foreground hover:bg-surface-3 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : (
          <p className="text-muted text-sm">{profileLoading ? 'Loading…' : 'Unable to load profile — please refresh.'}</p>
        )}
      </div>
    )
  }

  if (!initialized) {
    return <Navigate to="/init" replace />
  }
  return <Outlet />
}

function RoleRedirect() {
  const { role } = useAuth()
  return <Navigate to={role === 'vendor' ? '/vendor-home' : '/home'} replace />
}

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <BrowserRouter>
          <Toaster
            theme="dark"
            toastOptions={{
              style: {
                background: 'var(--color-surface-2)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-foreground)',
              },
            }}
          />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route element={<AuthGuard />}>
              {/* Pending approval — shown to users awaiting org admin acceptance */}
              <Route path="/pending" element={<PendingApproval />} />
              {/* Onboarding — shown to authenticated users with no org yet (create or join) */}
              <Route path="/onboarding" element={<Onboarding />} />
              {/* Init wizard — shown to studio users before first sync */}
              <Route path="/init" element={<ProjectInit />} />
              {/* Platform admin settings — not gated behind InitGuard */}
              <Route path="/admin" element={<AdminPanel />} />
              {/* App routes — gated behind InitGuard for studio users */}
              <Route element={<InitGuard />}>
                <Route index element={<RoleRedirect />} />
                <Route path="/home"        element={<StudioHome />} />
                <Route path="/vendor-home" element={<VendorHome />} />
                <Route path="/assets"      element={<Assets />} />
                <Route path="/shares"      element={<Shares />} />
                <Route path="/estimates"   element={<Navigate to="/org?tab=estimates" replace />} />
                <Route path="/workflows"   element={<Navigate to="/org?tab=workflows" replace />} />
                <Route path="/reviews"     element={<Reviews />} />
                <Route path="/inbox"       element={<VendorInbox />} />
                <Route path="/vendors"     element={<VendorConnections />} />
                <Route path="/studios"     element={<StudioConnections />} />
                <Route path="/org"               element={<OrgHub />} />
                <Route path="/scenario-planner" element={<ScenarioPlanner />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </AuthProvider>
  )
}
