import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import NumbersBotModal from '../components/NumbersBotModal'
import LoreBotModal from '../components/LoreBotModal'
import PageContainer from '../components/PageContainer'

function timeAgo(iso) {
  if (!iso) return null
  const secs = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (secs < 60)  return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function StatCard({ label, value, sub, onClick, loading }) {
  const base = 'flex flex-col gap-1 bg-surface border border-border rounded-xl px-5 py-4'
  const interactive = onClick ? 'cursor-pointer hover:border-accent/50 transition-colors' : ''
  return (
    <div className={`${base} ${interactive}`} onClick={onClick}>
      <span className="text-muted text-xs">{label}</span>
      {loading
        ? <div className="h-7 w-12 bg-surface-2 rounded animate-pulse mt-0.5" />
        : <span className="text-foreground text-2xl font-semibold tabular-nums">{value ?? '—'}</span>
      }
      {sub && !loading && <span className="text-muted text-xs">{sub}</span>}
    </div>
  )
}

const BOTS = [
  { icon: '◈', name: 'NumberBot', desc: 'Estimation audits + variance flags', live: true },
  { icon: '✦', name: 'LoreBot',   desc: 'In dev - proceed with caution.',      live: true },
  { icon: '⇄', name: 'OpsBot',    desc: 'Pipeline handoff automation',          live: false },
  { icon: '⊕', name: 'ATCBot',    desc: 'Asset traffic control',                live: false },
]

export default function StudioHome() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [summary, setSummary]       = useState(null)
  const [vendorCount, setVendorCount] = useState(null)
  const [error, setError]           = useState(null)
  const [openBot, setOpenBot]       = useState(null)
  const [syncing, setSyncing]       = useState(null) // null | 'full' | 'delta'
  const [syncMsg, setSyncMsg]       = useState(null) // null | 'ok' | 'err'

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    apiFetch('/api/user/studio-summary', { signal })
      .then(setSummary)
      .catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    apiFetch('/api/handshake/links', { signal })
      .then(links => setVendorCount(links.length))
      .catch(e => { if (e.name !== 'AbortError') setVendorCount(0) })
    return () => controller.abort()
  }, [])

  const loading = !summary && !error

  async function runSync(full) {
    if (syncing) return
    setSyncing(full ? 'full' : 'delta')
    setSyncMsg(null)
    try {
      await apiFetch('/api/sync/run', { method: 'POST', body: JSON.stringify({ full }) })
      setSyncMsg('ok')
    } catch {
      setSyncMsg('err')
    } finally {
      setSyncing(null)
      setTimeout(() => setSyncMsg(null), 3000)
    }
  }

  return (
    <PageContainer width="md" className="p-8 gap-8">
      <div className="flex items-center gap-4">
        <img src="/ArtHound_logo.png" alt="ArtHound" className="w-28 h-28 rounded-xl object-cover shrink-0" />
        <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-foreground text-2xl font-semibold">
            Welcome{profile?.org ? `, ${profile.org.name}` : ''}
          </h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => runSync(false)}
              disabled={!!syncing}
              className="px-2.5 py-1 rounded-md text-xs border border-border text-muted hover:text-foreground hover:border-foreground/40 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {syncing === 'delta' ? 'Syncing…' : 'Delta sync'}
            </button>
            <button
              onClick={() => runSync(true)}
              disabled={!!syncing}
              className="px-2.5 py-1 rounded-md text-xs border border-border text-muted hover:text-foreground hover:border-foreground/40 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {syncing === 'full' ? 'Syncing…' : 'Full sync'}
            </button>
            {syncMsg === 'ok'  && <span className="text-success text-xs">Synced ✓</span>}
            {syncMsg === 'err' && <span className="text-error text-xs">Failed</span>}
          </div>
        </div>
        {summary?.last_synced_at && (
          <p className="text-muted text-sm">
            Last synced {timeAgo(summary.last_synced_at)}
          </p>
        )}
        {!summary?.last_synced_at && !loading && (
          <p className="text-muted text-sm">Not yet synced</p>
        )}
        {summary?.last_full_sync_at && (() => {
          const hoursAgo = (Date.now() - new Date(summary.last_full_sync_at)) / 3600000
          const stale = hoursAgo > 25
          return (
            <p className={`text-xs ${stale ? 'text-warning' : 'text-muted/60'}`}>
              Full reconciliation {timeAgo(summary.last_full_sync_at)}
              {stale && ' — deletion check overdue'}
            </p>
          )
        })()}
        {summary?.last_synced_at && !summary.last_full_sync_at && (
          <p className="text-xs text-muted/60">No full reconciliation yet</p>
        )}
        {error && <p className="text-error text-xs mt-1">{error}</p>}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label="Assets"
          value={summary?.asset_count}
          loading={loading}
          onClick={() => navigate('/assets')}
        />
        <StatCard
          label="Products"
          value={summary?.product_count}
          loading={loading}
        />
        <StatCard
          label="Active shares"
          value={summary?.active_shares}
          loading={loading}
          onClick={() => navigate('/vendors')}
        />
        <StatCard
          label="Generated work"
          value={summary?.work_count}
          loading={loading}
        />
        <StatCard
          label="Vendors"
          value={vendorCount}
          loading={vendorCount === null}
          onClick={() => navigate('/vendors')}
        />
      </div>

      {/* ScentHounds panel */}
      <div className="bg-surface border border-border rounded-xl p-5 flex flex-col gap-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <img src="/scenthounds_logo.png" alt="ScentHounds" className="w-16 h-16 rounded-lg object-cover" />
          <div>
            <div className="text-foreground text-sm font-semibold">ScentHounds</div>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {BOTS.map(bot => (
            <div
              key={bot.name}
              className={`flex flex-col gap-1 px-3 py-2.5 rounded-lg border border-border ${bot.live ? 'cursor-pointer hover:border-accent/50 transition-colors' : 'opacity-50'}`}
              onClick={bot.live ? () => setOpenBot(bot.name) : undefined}
            >
              <div className="flex items-center justify-between">
                <span className="text-accent text-base">{bot.icon}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded-full border ${bot.live ? 'border-accent text-accent' : 'border-border text-muted'}`}>
                  {bot.live ? 'Ask' : 'Soon'}
                </span>
              </div>
              <div className="text-foreground text-xs font-medium">{bot.name}</div>
              <div className="text-muted text-xs leading-tight">{bot.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {openBot === 'NumberBot' && <NumbersBotModal onClose={() => setOpenBot(null)} />}
      {openBot === 'LoreBot'   && <LoreBotModal    onClose={() => setOpenBot(null)} />}
    </PageContainer>
  )
}
