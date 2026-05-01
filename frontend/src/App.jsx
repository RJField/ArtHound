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
            <Route element={<AuthGuard />}>
              <Route index element={<RoleRedirect />} />
              <Route path="/home"        element={<StudioHome />} />
              <Route path="/vendor-home" element={<VendorHome />} />
              <Route path="/assets"      element={<Assets />} />
              <Route path="/shares"      element={<Shares />} />
              <Route path="/estimates"   element={<Estimates />} />
              <Route path="/workflows"   element={<Workflows />} />
              <Route path="/reviews"     element={<Reviews />} />
              <Route path="/inbox"       element={<VendorInbox />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </AuthProvider>
  )
}
