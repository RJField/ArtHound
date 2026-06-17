import { Pill, StatusDot, Select } from '../ui'
import { statusColor } from '../../lib/statusColors'

// Shared renderer for agent-written records (asset_flags / review_requests / estimate_adjustment_
// proposals) — used by the per-asset AgentTab (with triage) and the home AgentActivityWidget (read-only).

const KIND = {
  flag:           { label: 'Risk',     tone: 'warning' },
  review_request: { label: 'Review',   tone: 'accent'  },
  proposal:       { label: 'Estimate', tone: 'info'    },
}
const SEVERITY_TONE = { high: 'error', medium: 'warning', low: 'neutral' }
const STATUS_OPTS = {
  flag:           ['open', 'acknowledged', 'resolved'],
  review_request: ['open', 'addressed'],
  proposal:       ['pending', 'accepted', 'rejected'],
}

function timeAgo(iso) {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export default function AgentActivityList({ items, onStatusChange, showAsset = false, busyId }) {
  if (!items?.length) return null
  return (
    <div className="flex flex-col gap-2">
      {items.map(item => {
        const kind = KIND[item.kind] || { label: item.kind, tone: 'neutral' }
        return (
          <div
            key={`${item.kind}-${item.id}`}
            className="rounded-lg border border-border bg-surface-2/40 p-3 flex flex-col gap-1.5"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Pill tone={kind.tone}>{kind.label}</Pill>
              {item.severity && (
                <Pill tone={SEVERITY_TONE[item.severity] || 'neutral'}>{item.severity}</Pill>
              )}
              {item.risk_type && <span className="text-faint text-xs">{item.risk_type}</span>}
              <span className="text-faint text-xs ml-auto">{timeAgo(item.created_at)}</span>
            </div>

            <span className="text-foreground text-xs font-medium leading-snug">{item.title || '—'}</span>
            {item.detail && (
              <p className="text-muted text-xs whitespace-pre-wrap line-clamp-3">{item.detail}</p>
            )}

            <div className="flex items-center gap-2 mt-0.5">
              {showAsset && item.asset_name && (
                <span className="text-faint text-xs truncate">{item.asset_name}</span>
              )}
              {onStatusChange ? (
                <Select
                  value={item.status}
                  onChange={e => onStatusChange(item, e.target.value)}
                  disabled={busyId === item.id}
                  className="ml-auto w-auto"
                >
                  {(STATUS_OPTS[item.kind] || [item.status]).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </Select>
              ) : (
                <StatusDot
                  label={item.status}
                  color={statusColor(item.status)}
                  className="text-xs text-muted ml-auto capitalize"
                />
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
