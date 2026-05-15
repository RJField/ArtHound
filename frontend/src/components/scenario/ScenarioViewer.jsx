import { useState, useCallback } from 'react'

const TABS = ['Products', 'Assets', 'Work']

const PRODUCT_COLS = [
  { key: 'name',                label: 'Name' },
  { key: 'target_release_date', label: 'Release Date' },
]

const ASSET_COLS = [
  { key: 'name',            label: 'Name' },
  { key: '_profile',        label: 'Profile' },
  { key: 'priority',        label: 'Priority' },
  { key: '_product_name',   label: 'Product' },
]

const WORK_COLS = [
  { key: '_asset_name',  label: 'Asset' },
  { key: 'step_name',    label: 'Step' },
  { key: 'craft',        label: 'Craft' },
  { key: 'estimate_days', label: 'Est. Days' },
  { key: 'start_date',   label: 'Start' },
  { key: 'end_date',     label: 'End' },
]

// Craft → bar colour (CSS hex so they work in inline styles)
const CRAFT_COLOR = {
  '3D':        '#7c3aed',
  '2D':        '#3b82f6',
  'Animation': '#22c55e',
  'VFX':       '#f59e0b',
}
const CRAFT_COLOR_DEFAULT = '#6b7280'

export default function ScenarioViewer({
  products, assets, work, isGenerating, hasData,
  generationMode = 'ai', preflightWarnings = [],
}) {
  const [tab,               setTab]               = useState('Products')
  const [workView,          setWorkView]          = useState('table')   // 'table' | 'timeline'
  const [sortKey,           setSortKey]           = useState(null)
  const [sortDir,           setSortDir]           = useState('asc')
  const [warningsDismissed, setWarningsDismissed] = useState(false)
  const dismissWarnings = useCallback(() => setWarningsDismissed(true), [])

  // Build lookup maps for denormalised display columns.
  const productById = Object.fromEntries(products.map(p => [p.id, p]))
  const assetById   = Object.fromEntries(assets.map(a => [a.id, a]))

  const enrichedAssets = assets.map(a => ({
    ...a,
    _profile:      _profileLabel(a.variable_values),
    _product_name: productById[a.product_id]?.name ?? '—',
  }))

  const enrichedWork = work.map(w => ({
    ...w,
    _asset_name: assetById[w.asset_id]?.name ?? '—',
  }))

  const rows = tab === 'Products' ? products
             : tab === 'Assets'   ? enrichedAssets
             :                      enrichedWork

  const cols = tab === 'Products' ? PRODUCT_COLS
             : tab === 'Assets'   ? ASSET_COLS
             :                      WORK_COLS

  const sorted = sortKey ? _sort(rows, sortKey, sortDir) : rows

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const showWarnings  = !warningsDismissed && preflightWarnings.length > 0
  const showTimeline  = tab === 'Work' && workView === 'timeline' && hasData && work.length > 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border px-6">
        <div className="flex flex-1">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? 'border-accent text-foreground'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              {t}
              {hasData && (
                <span className="ml-1.5 text-xs text-muted">
                  ({tab === t
                    ? sorted.length
                    : t === 'Products' ? products.length
                    : t === 'Assets'   ? assets.length
                    :                    work.length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Timeline / Table toggle — only on Work tab when data exists */}
        {tab === 'Work' && hasData && work.length > 0 && (
          <div className="flex items-center gap-1 mr-3 p-0.5 bg-surface-2 rounded border border-border">
            {['table', 'timeline'].map(v => (
              <button
                key={v}
                onClick={() => setWorkView(v)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
                  workView === v
                    ? 'bg-accent/20 text-accent'
                    : 'text-muted hover:text-foreground'
                }`}
              >
                {v === 'table' ? '≡ Table' : '▬ Timeline'}
              </button>
            ))}
          </div>
        )}

        {/* Mode badge */}
        {hasData && (
          <span className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded border ${
            generationMode === 'rule_based'
              ? 'text-accent border-accent/40 bg-accent/5'
              : 'text-muted border-border bg-surface-2'
          }`}>
            {generationMode === 'rule_based' ? 'Rule-based' : 'AI'}
          </span>
        )}
      </div>

      {/* Sparsity warning banner */}
      {showWarnings && (
        <div className="flex items-start justify-between gap-3 mx-6 mt-3 px-4 py-3 bg-surface-2 border border-border rounded-lg text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-foreground font-medium">Matrix gaps detected</span>
            <span className="text-muted text-xs">
              {preflightWarnings.length === 1
                ? `Profile "${preflightWarnings[0].profile}" has no steps with estimates.`
                : `${preflightWarnings.length} profiles have no steps with estimates: ${preflightWarnings.map(w => `"${w.profile}"`).join(', ')}.`}
              {' '}
              <a href="/estimates" className="text-accent hover:text-accent/80 transition-colors">
                Edit matrix →
              </a>
            </span>
          </div>
          <button
            onClick={dismissWarnings}
            className="text-muted hover:text-foreground transition-colors shrink-0 mt-0.5"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Content area */}
      {showTimeline ? (
        <WorkTimeline work={enrichedWork} assets={assets} />
      ) : (
        <div className="flex-1 overflow-auto px-6 py-4">
          {isGenerating && !hasData ? (
            <SkeletonTable cols={cols} />
          ) : !hasData ? (
            <EmptyState stage="before" />
          ) : sorted.length === 0 ? (
            <EmptyState stage="empty_tab" tab={tab} />
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-border">
                  {cols.map(col => (
                    <th
                      key={col.key}
                      onClick={() => handleSort(col.key)}
                      className="text-left py-2 px-3 text-muted font-medium text-xs cursor-pointer select-none hover:text-foreground transition-colors"
                    >
                      {col.label}
                      {sortKey === col.key && (
                        <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row, i) => (
                  <tr
                    key={row.id ?? i}
                    className="border-b border-border/50 hover:bg-surface-2 transition-colors"
                  >
                    {cols.map(col => (
                      <td key={col.key} className="py-2 px-3 text-foreground">
                        {_fmt(row[col.key])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// ── Timeline ──────────────────────────────────────────────────────────────────

const PX_PER_DAY  = 5    // 6 months ≈ 183 days × 5 px ≈ 915 px visible
const LANE_H      = 10   // height of one lane inside a row
const ROW_PAD     = 4    // padding above/below lanes within a row
const HEADER_H    = 32
const LABEL_W     = 200

// Greedy interval packing: assign each task a lane index so that no two
// tasks in the same lane overlap. Tasks must be pre-sorted by start_date.
function assignLanes(tasks) {
  const sorted = [...tasks].sort((a, b) => a.start_date.localeCompare(b.start_date))
  const laneEnd = []  // end_date string of the last task placed in each lane
  return sorted.map(task => {
    let lane = laneEnd.findIndex(e => e < task.start_date)
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(task.end_date) }
    else laneEnd[lane] = task.end_date
    return { ...task, _lane: lane }
  })
}

function WorkTimeline({ work, assets }) {
  const assetById = Object.fromEntries(assets.map(a => [a.id, a]))

  // Derive full span
  let minMs = Infinity, maxMs = -Infinity
  for (const w of work) {
    if (w.start_date) minMs = Math.min(minMs, +new Date(w.start_date))
    if (w.end_date)   maxMs = Math.max(maxMs, +new Date(w.end_date))
  }
  if (!isFinite(minMs)) return <EmptyState stage="empty_tab" tab="Work" />

  const minDate    = new Date(minMs)
  const maxDate    = new Date(maxMs)
  const totalDays  = Math.ceil((maxMs - minMs) / 86_400_000) + 1
  const totalWidth = totalDays * PX_PER_DAY

  // Month tick marks
  const months = []
  const cur = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), 1))
  while (cur <= maxDate) {
    const offset = Math.round((+cur - minMs) / 86_400_000)
    months.push({
      label: cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      x: Math.max(0, offset * PX_PER_DAY),
    })
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }

  // Group by asset name, assign lanes per asset
  const byAsset = {}
  for (const w of work) {
    const name = w._asset_name ?? assetById[w.asset_id]?.name ?? w.asset_id
    if (!byAsset[name]) byAsset[name] = []
    byAsset[name].push(w)
  }
  const assetNames = Object.keys(byAsset).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  )
  // Lane-assign each asset's tasks; compute per-asset row height
  const assetTasks  = {}
  const assetRowH   = {}
  for (const name of assetNames) {
    assetTasks[name] = assignLanes(byAsset[name])
    const numLanes   = Math.max(...assetTasks[name].map(t => t._lane)) + 1
    assetRowH[name]  = numLanes * LANE_H + ROW_PAD * 2
  }

  function barX(dateStr) {
    return Math.round((+new Date(dateStr) - minMs) / 86_400_000) * PX_PER_DAY
  }
  function barW(startStr, endStr) {
    const days = Math.round((+new Date(endStr) - +new Date(startStr)) / 86_400_000) + 1
    return Math.max(3, days * PX_PER_DAY)
  }

  const crafts = [...new Set(work.map(w => w.craft).filter(Boolean))].sort()

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Craft legend */}
      <div className="flex items-center gap-4 px-6 py-2 border-b border-border">
        {crafts.map(c => (
          <div key={c} className="flex items-center gap-1.5 text-xs text-muted">
            <div className="w-3 h-3 rounded-sm" style={{ background: CRAFT_COLOR[c] ?? CRAFT_COLOR_DEFAULT }} />
            {c}
          </div>
        ))}
        {work.some(w => !w.craft) && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <div className="w-3 h-3 rounded-sm" style={{ background: CRAFT_COLOR_DEFAULT }} />
            Other
          </div>
        )}
      </div>

      {/* Scrollable canvas — both axes */}
      <div className="flex-1 overflow-auto">
        <div style={{ width: LABEL_W + totalWidth, minWidth: '100%' }}>

          {/* Sticky header */}
          <div
            className="flex sticky top-0 z-20"
            style={{ background: 'var(--color-background, #0f0e1a)' }}
          >
            <div
              className="sticky left-0 z-30 shrink-0 border-b border-r border-border flex items-end pb-1 px-3"
              style={{ width: LABEL_W, height: HEADER_H, background: 'var(--color-background, #0f0e1a)' }}
            >
              <span className="text-xs text-muted font-medium">Asset</span>
            </div>
            <div className="relative border-b border-border" style={{ width: totalWidth, height: HEADER_H, flexShrink: 0 }}>
              {months.map((m, i) => (
                <div
                  key={i}
                  className="absolute bottom-0 pb-1 text-xs text-muted select-none"
                  style={{ left: m.x + 4 }}
                >
                  {m.label}
                </div>
              ))}
            </div>
          </div>

          {/* Asset rows — variable height based on lane count */}
          {assetNames.map(name => {
            const rowH = assetRowH[name]
            return (
              <div key={name} className="flex" style={{ height: rowH }}>
                {/* Frozen label */}
                <div
                  className="sticky left-0 z-10 shrink-0 flex items-center px-3 border-b border-r border-border/50 text-xs text-muted truncate"
                  style={{ width: LABEL_W, background: 'var(--color-background, #0f0e1a)' }}
                  title={name}
                >
                  {name}
                </div>
                {/* Bar track */}
                <div className="relative border-b border-border/30" style={{ width: totalWidth, flexShrink: 0 }}>
                  {months.map((m, i) => (
                    <div
                      key={i}
                      className="absolute top-0 bottom-0"
                      style={{ left: m.x, width: 1, background: 'rgba(255,255,255,0.04)' }}
                    />
                  ))}
                  {assetTasks[name].map((w, i) => (
                    <div
                      key={i}
                      title={`${w.step_name} · ${w.craft ?? 'No craft'} · ${w.estimate_days}d\n${w.start_date} → ${w.end_date}`}
                      style={{
                        position:     'absolute',
                        left:         barX(w.start_date),
                        width:        barW(w.start_date, w.end_date),
                        top:          ROW_PAD + w._lane * LANE_H,
                        height:       LANE_H - 2,
                        background:   CRAFT_COLOR[w.craft] ?? CRAFT_COLOR_DEFAULT,
                        borderRadius: 2,
                        opacity:      0.85,
                      }}
                      className="hover:opacity-100 transition-opacity cursor-default"
                    />
                  ))}
                </div>
              </div>
            )
          })}

        </div>
      </div>
    </div>
  )
}

// ── Supporting components ─────────────────────────────────────────────────────

function EmptyState({ stage, tab }) {
  if (stage === 'before') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center py-16">
        <p className="text-muted text-sm">Scenario data will appear here once generated.</p>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-muted text-sm">No {tab?.toLowerCase()} in this scenario.</p>
    </div>
  )
}

function SkeletonTable({ cols }) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-border">
          {cols.map(col => (
            <th key={col.key} className="text-left py-2 px-3 text-muted font-medium text-xs">
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 5 }).map((_, i) => (
          <tr key={i} className="border-b border-border/50">
            {cols.map((col, j) => (
              <td key={col.key} className="py-2 px-3">
                <div
                  className="h-3 bg-surface-2 rounded animate-pulse"
                  style={{ width: `${60 + ((i * 3 + j * 7) % 30)}%` }}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _profileLabel(variableValues) {
  if (!variableValues || !Object.keys(variableValues).length) return '—'
  return Object.values(variableValues).join(' | ')
}

function _fmt(value) {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

function _sort(rows, key, dir) {
  return [...rows].sort((a, b) => {
    const av = a[key] ?? ''
    const bv = b[key] ?? ''
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
    return dir === 'asc' ? cmp : -cmp
  })
}
