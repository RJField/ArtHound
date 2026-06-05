import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import UserModal from './UserModal'
import { cn } from '../lib/utils'

const STUDIO_NAV = [
  { label: 'Home',     to: '/home' },
  { label: 'Assets',   to: '/assets' },
  { label: 'Reviews',  to: '/reviews' },
  { label: 'Vendors',  to: '/vendors' },
  { label: 'Org',      to: '/org' },
  { label: 'Scenario', to: '/scenario-planner' },
]

const VENDOR_NAV = [
  { label: 'Home',    to: '/vendor-home' },
  { label: 'Assets',  to: '/assets' },
  { label: 'Inbox',   to: '/inbox' },
  { label: 'Studios', to: '/studios' },
  { label: 'Org',     to: '/org' },
]

export default function Topbar() {
  const { role, isPlatformAdmin, signOut } = useAuth()
  const navigate = useNavigate()
  const [userOpen, setUserOpen]           = useState(false)
  const [syncing, setSyncing]             = useState(false)
  const [syncMsg, setSyncMsg]             = useState(null)

  const nav = role === 'vendor' ? VENDOR_NAV : STUDIO_NAV

  // The trigger route is fire-and-forget — a 200 only means the sync was queued,
  // not that it succeeded. Poll the returned log_id until it reaches a terminal
  // status so the badge reflects the real outcome instead of "queued".
  async function pollSyncStatus(logId, { intervalMs = 2000, timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs))
      try {
        const run = await apiFetch(`/api/sync/status/${logId}`)
        if (run.status === 'success' || run.status === 'error') return run.status
      } catch {
        // transient poll error — keep retrying until the deadline
      }
    }
    return 'timeout'
  }

  async function handleSync() {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const { log_id } = await apiFetch('/api/sync/run', { method: 'POST', body: JSON.stringify({ full: true }) })
      const status = log_id ? await pollSyncStatus(log_id) : 'error'
      setSyncMsg(status === 'success' ? 'ok' : status === 'error' ? 'err' : null)
    } catch {
      setSyncMsg('err')
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 4000)
    }
  }

  return (
    <>
      <header className="h-12 flex items-center px-4 gap-4 border-b border-border bg-surface shrink-0">
        {/* Logo */}
        <div className="flex items-center gap-2 mr-2">
          <img src="/ArtHound_logo.png" alt="ArtHound" className="w-6 h-6 rounded object-cover" />
          <span className="text-foreground font-semibold text-sm tracking-wide">ArtHound</span>
        </div>

        {/* Nav */}
        <nav className="flex items-center gap-1 flex-1">
          {nav.map(({ label, to }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                isActive
                  ? 'bg-surface-2 text-foreground'
                  : 'text-muted hover:text-foreground hover:bg-surface-2'
              )}
            >
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          {(role === 'studio' || role === 'vendor') && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
                syncMsg === 'ok'  ? 'text-success' :
                syncMsg === 'err' ? 'text-error' :
                'text-muted hover:text-foreground hover:bg-surface-2'
              )}
            >
              {syncing ? 'Syncing…' : syncMsg === 'ok' ? 'Synced ✓' : syncMsg === 'err' ? 'Failed' : 'Sync'}
            </button>
          )}
          {isPlatformAdmin && (
            <button
              onClick={() => navigate('/admin')}
              className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
            >
              Platform Admin
            </button>
          )}
          <button
            onClick={() => setUserOpen(true)}
            className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
          >
            Account
          </button>
          <button
            onClick={signOut}
            className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-error transition-colors cursor-pointer"
          >
            Sign out
          </button>
        </div>
      </header>

      {userOpen && <UserModal onClose={() => setUserOpen(false)} />}
    </>
  )
}
