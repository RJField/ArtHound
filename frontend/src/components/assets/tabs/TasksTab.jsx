import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch, makeRecordResolver } from '../../../lib/api'
import { fmtDate, LINKED_TABLE_MAP, fieldDisplayString } from '../../../lib/fields'
import { cn } from '../../../lib/utils'
import DetailModal from '../../DetailModal'

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

// ── Task detail fetcher (Airtable source only) ────────────────────────────────

async function fetchTaskDetail(taskId, taskName) {
  const { fields, displayFields = {} } = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}`)
  const SKIP = new Set(['Task'])
  const entries = []

  for (const [k, v] of Object.entries(fields)) {
    if (SKIP.has(k) || v == null || v === '') continue

    const isCanonical = Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && 'source_id' in v[0]
    const isRawRec    = !isCanonical && Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.startsWith('rec'))

    if (isCanonical || isRawRec) {
      const tableKey  = LINKED_TABLE_MAP[k]
      const sourceId  = isCanonical ? v[0].source_id : v[0]
      const resolved  = isCanonical ? v.map(x => x.display_name || '').filter(Boolean).join(', ') : null
      if (tableKey && v.length === 1) {
        const name = displayFields[k] || resolved || sourceId
        entries.push({ label: k, value: name, type: 'linked-record', resolve: makeRecordResolver(tableKey, sourceId, name) })
      } else {
        const display = displayFields[k] || resolved || (tableKey ? `${v.length} linked record${v.length !== 1 ? 's' : ''}` : v.join(', '))
        entries.push({ label: k, value: display })
      }
    } else {
      const display = (displayFields[k] != null && displayFields[k] !== '')
        ? displayFields[k]
        : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
          ? fmtDate(v.slice(0, 10))
          : fieldDisplayString(v)
      entries.push({ label: k, value: display })
    }
  }

  return { title: taskName, fields: entries.length ? entries : [{ label: 'No fields', value: null }] }
}

// ── Tab ───────────────────────────────────────────────────────────────────────

export default function TasksTab({ asset, taskRefreshKey }) {
  const [source,    setSource]    = useState('arthound')
  const [view,      setView]      = useState('list')
  const [tasks,     setTasks]     = useState(null)
  const [loading,   setLoading]   = useState(false)
  const [taskModal, setTaskModal] = useState(null)

  useEffect(() => {
    if (!asset) { setTasks(null); return }
    setTasks(null)
    setLoading(true)

    async function load() {
      try {
        if (source === 'arthound') {
          if (!asset.canonicalId) { setTasks([]); return }
          const data = await apiFetch(
            `/api/schedule/tasks-local?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`
          )
          setTasks(data)
        } else {
          const nameQ = asset.name ? `&assetName=${encodeURIComponent(asset.name)}` : ''
          const data  = await apiFetch(`/api/schedule/tasks?assetId=${encodeURIComponent(asset.id)}${nameQ}`)
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

  async function openTaskDetail(taskId, taskName) {
    if (source === 'arthound') return
    setTaskModal({ title: taskName, fields: [], loading: true })
    try {
      setTaskModal(await fetchTaskDetail(taskId, taskName))
    } catch (err) {
      setTaskModal(null)
      toast.error(err.message)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Controls */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <div className="flex rounded-md overflow-hidden border border-border text-xs">
          {['arthound', 'airtable'].map(s => (
            <button key={s} onClick={() => setSource(s)} className={cn(
              'px-2 py-1 cursor-pointer transition-colors capitalize',
              source === s ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground'
            )}>{s}</button>
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
          <p className="text-muted text-xs">
            {source === 'arthound' && !asset?.canonicalId
              ? 'Asset not yet synced to ArtHound.'
              : 'No tasks yet — use Generate Work to create them.'}
          </p>
        )}

        {tasks?.length > 0 && view === 'timeline' && <TasksTimeline tasks={tasks} />}

        {tasks?.length > 0 && view === 'list' && (
          <div className="flex flex-col gap-1">
            {tasks.map(t => (
              <div
                key={t.id}
                onClick={() => openTaskDetail(t.id, t.task)}
                className={cn(
                  'flex items-center justify-between gap-4 px-3 py-2 rounded-md',
                  source !== 'arthound' && 'cursor-pointer hover:bg-surface-2 transition-colors'
                )}
              >
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

      {taskModal && <DetailModal {...taskModal} onClose={() => setTaskModal(null)} />}
    </div>
  )
}
