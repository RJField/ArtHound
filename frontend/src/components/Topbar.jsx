import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import UserModal from './UserModal'
import FieldMappingModal from './FieldMappingModal'
import NumbersBotModal from './NumbersBotModal'
import { cn } from '../lib/utils'

const STUDIO_NAV = [
  { label: 'Home',       to: '/home' },
  { label: 'Assets',     to: '/assets' },
  { label: 'Shares',     to: '/shares' },
  { label: 'Estimates',  to: '/estimates' },
  { label: 'Workflows',  to: '/workflows' },
  { label: 'Reviews',    to: '/reviews' },
]

const VENDOR_NAV = [
  { label: 'Home',  to: '/vendor-home' },
  { label: 'Inbox', to: '/inbox' },
]

export default function Topbar() {
  const { role, signOut } = useAuth()
  const [userOpen, setUserOpen]         = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [botOpen, setBotOpen]           = useState(false)

  const nav = role === 'vendor' ? VENDOR_NAV : STUDIO_NAV

  return (
    <>
      <header className="h-12 flex items-center px-4 gap-4 border-b border-border bg-surface shrink-0">
        {/* Logo */}
        <span className="text-foreground font-semibold text-sm tracking-wide mr-2">ArtHound</span>

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
          <button
            onClick={() => setBotOpen(true)}
            className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground hover:bg-surface-2 transition-colors cursor-pointer"
          >
            NumberBot
          </button>
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

      {userOpen     && <UserModal          onClose={() => setUserOpen(false)} />}
      {settingsOpen && <FieldMappingModal  onClose={() => setSettingsOpen(false)} />}
      {botOpen      && <NumbersBotModal    onClose={() => setBotOpen(false)} />}
    </>
  )
}
