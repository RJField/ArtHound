import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import UserModal from './UserModal'
import FieldMappingModal from './FieldMappingModal'
import SyntheticDataModal from './SyntheticDataModal'
import { cn } from '../lib/utils'

const STUDIO_NAV = [
  { label: 'Home',    to: '/home' },
  { label: 'Assets',  to: '/assets' },
  { label: 'Shares',  to: '/shares' },
  { label: 'Reviews', to: '/reviews' },
  { label: 'Vendors', to: '/vendors' },
]

const VENDOR_NAV = [
  { label: 'Home',    to: '/vendor-home' },
  { label: 'Assets',  to: '/assets' },
  { label: 'Inbox',   to: '/inbox' },
  { label: 'Studios', to: '/studios' },
]

export default function Topbar() {
  const { role, isAdmin, signOut } = useAuth()
  const [userOpen, setUserOpen]           = useState(false)
  const [settingsOpen, setSettingsOpen]   = useState(false)
  const [syntheticOpen, setSyntheticOpen] = useState(false)

  const nav = role === 'vendor' ? VENDOR_NAV : STUDIO_NAV

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
          {isAdmin && (
            <button
              onClick={() => setSyntheticOpen(true)}
              className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
            >
              Synthetic Data
            </button>
          )}
          <button
            onClick={() => setSettingsOpen(true)}
            className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
          >
            Settings
          </button>
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

      {userOpen      && <UserModal          onClose={() => setUserOpen(false)} />}
      {settingsOpen  && <FieldMappingModal  onClose={() => setSettingsOpen(false)} />}
      {syntheticOpen && <SyntheticDataModal onClose={() => setSyntheticOpen(false)} />}
    </>
  )
}
