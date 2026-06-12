import { useState, useRef } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import UserModal from './UserModal'
import { Button, Pill, Dropdown } from './ui'
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
  const accountToggleRef                  = useRef(() => {})

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

  const menuItemCls = 'w-full text-left px-3 py-1.5 text-xs text-muted hover:text-foreground hover:bg-surface-2 cursor-pointer transition-colors'

  function closeAccountMenu() {
    accountToggleRef.current()
  }

  return (
    <>
      <header className="h-11 flex items-center px-4 gap-4 border-b border-border bg-surface shrink-0">
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
            <div className="flex items-center gap-1.5">
              {syncing && <Pill tone="warning">Syncing…</Pill>}
              {!syncing && syncMsg === 'ok'  && <Pill tone="success">Synced</Pill>}
              {!syncing && syncMsg === 'err' && <Pill tone="error">Failed</Pill>}
              <Button variant="ghost" size="sm" onClick={handleSync} disabled={syncing}>
                Sync
              </Button>
            </div>
          )}
          {isPlatformAdmin && (
            <Button variant="ghost" size="sm" onClick={() => navigate('/admin')}>
              Platform Admin
            </Button>
          )}
          <Dropdown
            width="w-44"
            trigger={({ toggle }) => {
              accountToggleRef.current = toggle
              return (
                <Button variant="ghost" size="sm" onClick={toggle}>
                  Account
                </Button>
              )
            }}
          >
            <button
              type="button"
              className={menuItemCls}
              onClick={() => { closeAccountMenu(); setUserOpen(true) }}
            >
              Account settings
            </button>
            <button
              type="button"
              className={cn(menuItemCls, 'hover:text-error')}
              onClick={() => { closeAccountMenu(); signOut() }}
            >
              Sign out
            </button>
          </Dropdown>
        </div>
      </header>

      {userOpen && <UserModal onClose={() => setUserOpen(false)} />}
    </>
  )
}
