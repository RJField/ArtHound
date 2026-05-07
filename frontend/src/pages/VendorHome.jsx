import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'

export default function VendorHome() {
  const { profile } = useAuth()
  const navigate    = useNavigate()

  const [inviteCount, setInviteCount]   = useState(null)
  const [studioCount, setStudioCount]   = useState(null)
  const [inboxCount, setInboxCount]     = useState(null)

  useEffect(() => {
    apiFetch('/api/handshake/invites/incoming')
      .then(inv => setInviteCount(inv.length))
      .catch(() => setInviteCount(0))
    apiFetch('/api/handshake/links')
      .then(links => setStudioCount(links.length))
      .catch(() => setStudioCount(0))
    apiFetch('/api/payloads/vendor-inbox')
      .then(items => setInboxCount(items.length))
      .catch(() => setInboxCount(0))
  }, [])

  return (
    <main className="flex-1 p-8 flex flex-col gap-8 max-w-3xl">
      <div>
        <h1 className="text-foreground text-2xl font-semibold mb-1">
          Welcome{profile?.org ? `, ${profile.org.name}` : ''}
        </h1>
        <p className="text-muted text-sm">Vendor dashboard</p>
      </div>

      {/* Pending invite banner */}
      {inviteCount > 0 && (
        <div
          onClick={() => navigate('/studios')}
          className="flex items-center justify-between px-4 py-3 rounded-lg border border-accent/40 bg-accent/5 cursor-pointer hover:border-accent/70 transition-colors"
        >
          <div>
            <p className="text-foreground text-sm font-medium">
              {inviteCount} pending studio invite{inviteCount !== 1 ? 's' : ''}
            </p>
            <p className="text-muted text-xs">Review and accept to start receiving payloads</p>
          </div>
          <span className="text-accent text-xs">Review →</span>
        </div>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard
          label="Connected studios"
          value={studioCount}
          loading={studioCount === null}
          onClick={() => navigate('/studios')}
        />
        <StatCard
          label="Incoming assets"
          value={inboxCount}
          loading={inboxCount === null}
          onClick={() => navigate('/inbox')}
        />
        <StatCard
          label="Pending invites"
          value={inviteCount}
          loading={inviteCount === null}
          onClick={() => navigate('/studios')}
          highlight={inviteCount > 0}
        />
      </div>
    </main>
  )
}

function StatCard({ label, value, loading, onClick, highlight }) {
  const base = 'flex flex-col gap-1 bg-surface border border-border rounded-xl px-5 py-4'
  const interactive = onClick ? 'cursor-pointer hover:border-accent/50 transition-colors' : ''
  const highlighted = highlight ? 'border-accent/40' : ''
  return (
    <div className={`${base} ${interactive} ${highlighted}`} onClick={onClick}>
      <span className="text-muted text-xs">{label}</span>
      {loading
        ? <div className="h-7 w-12 bg-surface-2 rounded animate-pulse mt-0.5" />
        : <span className="text-foreground text-2xl font-semibold tabular-nums">{value ?? '—'}</span>
      }
    </div>
  )
}
