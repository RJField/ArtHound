import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../../../lib/api'
import { fmtDate } from '../../../lib/fields'
import { cn } from '../../../lib/utils'
// ── Timeline ──────────────────────────────────────────────────────────────────

function TasksTimeline({ tasks }) {
  const dated = tasks
    .filter(t => t.startDate && t.endDate)
    .map(t => ({ ...t, start: new Date(t.startDate), end: new Date(t.endDate) }))

  if (!dated.length) return <p className="text-muted text-xs p-3">No dated tasks to display.</p>

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
            <span key={m.label} className="absolute text-muted text-xs" style={{ left: `${m.pct}%` }}>
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
          <div className="w-32 shrink-0 pr-2 text-muted text-xs truncate">{t.task}</div>
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

// ── Tab ───────────────────────────────────────────────────────────────────────

const SOURCES = [
  { id: 'source',   label: 'Source'   },
  { id: 'arthound', label: 'Generated' },
]

export default function TasksTab({ asset, taskRefreshKey }) {
  const [source,    setSource]    = useState('source')
  const [view,      setView]      = useState('list')
  const [tasks,     setTasks]     = useState(null)
  const [loading,   setLoading]   = useState(false)

  useEffect(() => {
    if (!asset) { setTasks(null); return }
    setTasks(null)
    setLoading(true)

    async function load() {
      try {
        if (source === 'source') {
          const data = await apiFetch(
            `/api/tasks?asset_source_id=${encodeURIComponent(asset.id)}`
          )
          setTasks(data)
        } else {
          if (!asset.canonicalId) { setTasks([]); return }
          const data = await apiFetch(
            `/api/schedule/tasks-local?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`
          )
          setTasks(data)
        }
      } catch (err) {
        toast.error(err.message)
        setTasks([])
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [asset?.id, source, taskRefreshKey])

  function emptyMessage() {
    if (source === 'source') return 'No source tasks synced for this asset.'
    if (!asset?.canonicalId) return 'Asset not yet synced to ArtHound.'
    return 'No tasks yet — use Generate Work to create them.'
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
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

      {/* Task list / timeline */}
      <div className="flex-1 overflow-y-auto p-3">
        {loading && <p className="text-muted text-xs">Loading…</p>}

        {!loading && tasks !== null && tasks.length === 0 && (
          <p className="text-muted text-xs">{emptyMessage()}</p>
        )}

        {tasks?.length > 0 && view === 'timeline' && source !== 'source' && (
          <TasksTimeline tasks={tasks} />
        )}

        {tasks?.length > 0 && view === 'list' && source === 'source' && (
          <div className="flex flex-col gap-1">
            {tasks.map(t => (
              <div key={t.id} className="flex items-start justify-between gap-4 px-3 py-2 rounded-md">
                <div className="min-w-0 flex-1">
                  <p className="text-foreground text-xs truncate">{t.name || '—'}</p>
                  {t.status && <p className="text-muted text-xs">{t.status}</p>}
                </div>
                <span className="text-muted text-xs shrink-0">
                  {t.estimate != null ? `${t.estimate}` : '—'}
                </span>
              </div>
            ))}
          </div>
        )}

        {tasks?.length > 0 && view === 'list' && source === 'arthound' && (
          <div className="flex flex-col gap-1">
            {tasks.map(t => (
              <div key={t.id} className="flex items-center justify-between gap-4 px-3 py-2 rounded-md">
                <div className="min-w-0">
                  <p className="text-foreground text-xs truncate">{t.task}</p>
                  <p className="text-muted text-xs">
                    {t.startDate ? fmtDate(t.startDate) : '—'} → {t.endDate ? fmtDate(t.endDate) : '—'}
                  </p>
                </div>
                <span className="text-muted text-xs shrink-0">
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
