import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { AppProvider } from './contexts/AppContext'
import Topbar from './components/Topbar'
import Login from './pages/Login'
import StudioHome from './pages/StudioHome'
import VendorHome from './pages/VendorHome'
import Workflows from './pages/Workflows'
import Shares from './pages/Shares'
import VendorInbox from './pages/VendorInbox'
import Reviews from './pages/Reviews'
import Assets from './pages/Assets'
import Estimates from './pages/Estimates'
import ProjectInit from './pages/ProjectInit'
import VendorConnections from './pages/VendorConnections'
import StudioConnections from './pages/StudioConnections'
import AuthCallback from './pages/AuthCallback'
import PendingApproval from './pages/PendingApproval'
import OrgHub from './pages/OrgHub'

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
// Also intercepts pending users (awaiting org approval) and sends them to /pending.
function InitGuard() {
  const { session, loading, profile, pendingOrg, profileLoading, initialized } = useAuth()

  if (loading || !session) return null

  if (pendingOrg) return <Navigate to="/pending" replace />

  if (!profile) {
    return (
      <div className="flex items-center justify-center flex-1 py-24">
        <p className="text-muted text-sm">{profileLoading ? 'Loading…' : 'Unable to load profile — please refresh.'}</p>
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
              {/* Init wizard — shown to studio users before first sync */}
              <Route path="/init" element={<ProjectInit />} />
              {/* App routes — gated behind InitGuard for studio users */}
              <Route element={<InitGuard />}>
                <Route index element={<RoleRedirect />} />
                <Route path="/home"        element={<StudioHome />} />
                <Route path="/vendor-home" element={<VendorHome />} />
                <Route path="/assets"      element={<Assets />} />
                <Route path="/shares"      element={<Shares />} />
                <Route path="/estimates"   element={<Estimates />} />
                <Route path="/workflows"   element={<Workflows />} />
                <Route path="/reviews"     element={<Reviews />} />
                <Route path="/inbox"       element={<VendorInbox />} />
                <Route path="/vendors"     element={<VendorConnections />} />
                <Route path="/studios"     element={<StudioConnections />} />
                <Route path="/org"         element={<OrgHub />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </AuthProvider>
  )
}
