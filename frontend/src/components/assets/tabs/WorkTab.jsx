import { useState, useEffect } from 'react'
import { ListChecks } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '../../../lib/api'
import { fmtDate } from '../../../lib/fields'
import { cn } from '../../../lib/utils'
import { EmptyState, Spinner, StatusDot, Table, Th, Tr, Td } from '../../ui'
// ── Timeline ──────────────────────────────────────────────────────────────────

function WorkTimeline({ work }) {
  const dated = work
    .filter(t => t.startDate && t.endDate)
    .map(t => ({ ...t, start: new Date(t.startDate), end: new Date(t.endDate) }))

  if (!dated.length) return <EmptyState title="No dated work items to display." />

  const minMs  = Math.min(...dated.map(t => t.start.getTime()))
  const maxMs  = Math.max(...dated.map(t => t.end.getTime()))
  const range  = maxMs - minMs || 1
  const pct    = ms    => ((ms - minMs) / range * 100).toFixed(2)
  const wPct   = (s, e) => ((e - s) / range * 100).toFixed(2)
  const now    = Date.now()
  const showNow = now >= minMs && now <= maxMs

  const months = []
  const cursor = new Date(new Date(minMs).getFullYear(), new Date(minMs).getMonth(), 1)
  while (cursor.getTime() <= maxMs) {
    months.push({
      label: cursor.toLocaleString('default', { month: 'short', year: 'numeric' }),
      pct:   Math.max(0, pct(cursor.getTime())),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex mb-1 relative h-5">
        <div className="w-32 shrink-0" />
        <div className="flex-1 relative">
          {months.map(m => (
            <span key={m.label} className="absolute text-faint text-xs" style={{ left: `${m.pct}%` }}>
              {m.label}
            </span>
          ))}
          {showNow && (
            <div className="absolute top-0 bottom-0 w-px bg-error opacity-60" style={{ left: `${pct(now)}%` }} />
          )}
        </div>
      </div>
      {dated.map(t => (
        <div key={t.id} className="flex items-center mb-1 min-h-7">
          <div className="w-32 shrink-0 pr-2 text-muted text-xs truncate">{t.work}</div>
          <div className="flex-1 relative h-5">
            {showNow && (
              <div className="absolute top-0 bottom-0 w-px bg-error opacity-60" style={{ left: `${pct(now)}%` }} />
            )}
            <div
              className="absolute top-0 h-full rounded bg-accent/70 flex items-center px-1"
              style={{ left: `${pct(t.start.getTime())}%`, width: `${wPct(t.start, t.end)}%` }}
            >
              {t.estimate != null && (
                <span className="text-white text-xs truncate">{t.estimate}d</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Craft rollup ─────────────────────────────────────────────────────────────

function CraftRollup({ work }) {
  const rows = Object.entries(
    work.reduce((acc, t) => {
      if (t.estimate == null) return acc
      const craft = t.craft || 'Unassigned'
      acc[craft] = (acc[craft] || 0) + t.estimate
      return acc
    }, {})
  ).sort(([a], [b]) => a.localeCompare(b))

  if (!rows.length) return null

  const total = rows.reduce((s, [, d]) => s + d, 0)

  return (
    <div className="border border-border rounded-md overflow-hidden mb-3">
      <Table>
        <thead>
          <tr>
            <Th className="static">Craft</Th>
            <Th className="static text-right">Days</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([craft, days]) => (
            <Tr key={craft}>
              <Td primary>{craft}</Td>
              <Td className="text-right text-foreground">{days}d</Td>
            </Tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border bg-surface-2">
            <td className="px-2.5 h-[30px] text-muted font-medium text-xs">Total</td>
            <td className="px-2.5 h-[30px] text-right text-foreground font-medium tabular-nums text-xs">{total}d</td>
          </tr>
        </tfoot>
      </Table>
    </div>
  )
}

// ── Tab ───────────────────────────────────────────────────────────────────────

const SOURCES = [
  { id: 'source',   label: 'Source'   },
  { id: 'arthound', label: 'ArtHound' },
]

export default function WorkTab({ asset, workRefreshKey }) {
  const [source,  setSource]  = useState('arthound')
  const [view,    setView]    = useState('list')
  const [work,    setWork]    = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!asset) { setWork(null); return }
    setWork(null)
    setLoading(true)
    const controller = new AbortController()
    const { signal } = controller

    async function load() {
      try {
        if (source === 'source') {
          if (!asset.canonicalId) { setWork([]); return }
          const data = await apiFetch(
            `/api/work/?canonical_asset_id=${encodeURIComponent(asset.canonicalId)}`,
            { signal }
          )
          setWork(data)
        } else {
          if (!asset.canonicalId) { setWork([]); return }
          const data = await apiFetch(
            `/api/schedule/work-local?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`,
            { signal }
          )
          setWork(data)
        }
      } catch (err) {
        if (err.name !== 'AbortError') { toast.error(err.message); setWork([]) }
      } finally {
        setLoading(false)
      }
    }

    load()
    return () => controller.abort()
  }, [asset?.id, source, workRefreshKey])

  function emptyMessage() {
    if (source === 'source') return 'No source work synced for this asset.'
    if (!asset?.canonicalId) return 'Asset not yet synced to ArtHound.'
    return 'No work yet — use Generate Work to create it.'
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface shrink-0">
        <div className="flex rounded-md overflow-hidden border border-border text-xs">
          {SOURCES.map(s => (
            <button key={s.id} onClick={() => setSource(s.id)} className={cn(
              'px-2 py-1 cursor-pointer transition-colors',
              source === s.id ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground'
            )}>{s.label}</button>
          ))}
        </div>
        <div className="flex rounded-md overflow-hidden border border-border text-xs ml-auto">
          {['list', 'timeline'].map(v => (
            <button key={v} onClick={() => setView(v)} className={cn(
              'px-2 py-1 cursor-pointer transition-colors capitalize',
              view === v ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground'
            )}>{v}</button>
          ))}
        </div>
      </div>

      {/* Work list / timeline */}
      <div className="flex-1 overflow-y-auto p-3">
        {loading && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}

        {!loading && work !== null && work.length === 0 && (
          <EmptyState icon={ListChecks} title={emptyMessage()} />
        )}

        {work?.length > 0 && source === 'arthound' && (
          <CraftRollup work={work} />
        )}

        {work?.length > 0 && view === 'timeline' && source !== 'source' && (
          <WorkTimeline work={work} />
        )}

        {work?.length > 0 && view === 'list' && source === 'source' && (
          <div className="flex flex-col gap-1">
            {work.map(t => (
              <div key={t.id} className="flex items-start justify-between gap-4 px-3 py-2 rounded-md">
                <div className="min-w-0 flex-1">
                  <p className="text-foreground text-xs truncate">{t.name || '—'}</p>
                  {t.status && (
                    <StatusDot label={t.status} className="text-muted text-xs" />
                  )}
                </div>
                <span className="text-muted text-xs shrink-0 tabular-nums">
                  {t.estimate != null ? `${t.estimate}` : '—'}
                </span>
              </div>
            ))}
          </div>
        )}

        {work?.length > 0 && view === 'list' && source === 'arthound' && (
          <div className="flex flex-col gap-1">
            {work.map(t => (
              <div key={t.id} className="flex items-center justify-between gap-4 px-3 py-2 rounded-md">
                <div className="min-w-0">
                  <p className="text-foreground text-xs truncate">{t.work}</p>
                  <p className="text-muted text-xs">
                    {t.startDate ? fmtDate(t.startDate) : '—'} → {t.endDate ? fmtDate(t.endDate) : '—'}
                  </p>
                </div>
                <span className="text-muted text-xs shrink-0 tabular-nums">
                  {t.estimate != null ? `${t.estimate}d` : '—'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  )
}
