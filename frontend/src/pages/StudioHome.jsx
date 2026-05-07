import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { apiFetch } from '../lib/api'
import NumbersBotModal from '../components/NumbersBotModal'
import LoreBotModal from '../components/LoreBotModal'

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
  const [summary, setSummary]   = useState(null)
  const [error, setError]       = useState(null)
  const [openBot, setOpenBot]   = useState(null)

  useEffect(() => {
    apiFetch('/api/user/studio-summary')
      .then(setSummary)
      .catch(e => setError(e.message))
  }, [])

  const loading = !summary && !error

  return (
    <main className="flex-1 p-8 flex flex-col gap-8 max-w-4xl">
      <div className="flex items-center gap-4">
        <img src="/ArtHound_logo.png" alt="ArtHound" className="w-28 h-28 rounded-xl object-cover shrink-0" />
        <div>
        <h1 className="text-foreground text-2xl font-semibold mb-1">
          Welcome{profile?.org ? `, ${profile.org.name}` : ''}
        </h1>
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
          onClick={() => navigate('/shares')}
        />
        <StatCard
          label="Generated work"
          value={summary?.work_count}
          loading={loading}
        />
      </div>

      {/* Cu-TOOL-u panel */}
      <div className="bg-surface border border-border rounded-xl p-5 flex flex-col gap-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <img src="/cutoolu_logo.png" alt="Cu-TOOL-u" className="w-16 h-16 rounded-lg object-cover" />
          <div>
            <div className="text-foreground text-sm font-semibold">Cu-TOOL-u</div>
            <div className="text-muted text-xs">Intelligence beyond mortal comprehension</div>
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
    </main>
  )
}
