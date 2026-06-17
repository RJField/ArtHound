import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import PageContainer from '../components/PageContainer'
import AgentActivityWidget from '../components/AgentActivityWidget'
import { PageHeader, SectionLabel, Skeleton } from '../components/ui'
import { cn } from '../lib/utils'

export default function VendorHome() {
  const { profile } = useAuth()
  const navigate    = useNavigate()

  const [inviteCount, setInviteCount]   = useState(null)
  const [studioCount, setStudioCount]   = useState(null)
  const [inboxCount, setInboxCount]     = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    apiFetch('/api/handshake/invites/incoming', { signal })
      .then(inv => setInviteCount(inv.length))
      .catch(e => { if (e.name !== 'AbortError') setInviteCount(0) })
    apiFetch('/api/handshake/links', { signal })
      .then(links => setStudioCount(links.length))
      .catch(e => { if (e.name !== 'AbortError') setStudioCount(0) })
    apiFetch('/api/payloads/vendor-inbox', { signal })
      .then(items => setInboxCount(items.length))
      .catch(e => { if (e.name !== 'AbortError') setInboxCount(0) })
    return () => controller.abort()
  }, [])

  return (
    <PageContainer width="sm" className="p-8 gap-8">
      <PageHeader
        title={`Welcome${profile?.org ? `, ${profile.org.name}` : ''}`}
        subtitle="Vendor dashboard"
      />

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
          <span className="text-link text-xs hover:underline">Review →</span>
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

      <AgentActivityWidget />
    </PageContainer>
  )
}

function StatCard({ label, value, loading, onClick, highlight }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 bg-surface border border-border rounded-lg px-5 py-4',
        onClick && 'cursor-pointer hover:border-accent/50 transition-colors',
        highlight && 'border-accent/40'
      )}
      onClick={onClick}
    >
      <SectionLabel>{label}</SectionLabel>
      {loading
        ? <Skeleton className="h-7 w-12 mt-0.5" />
        : <span className="text-foreground text-2xl font-semibold tabular-nums">{value ?? '—'}</span>
      }
    </div>
  )
}
