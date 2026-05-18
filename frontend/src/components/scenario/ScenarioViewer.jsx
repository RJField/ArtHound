import { useState, useCallback, useMemo } from 'react'

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
  { key: '_asset_name',   label: 'Asset' },
  { key: 'step_name',     label: 'Step' },
  { key: 'craft',         label: 'Craft' },
  { key: 'estimate_days', label: 'Est. Days' },
  { key: 'start_date',    label: 'Start' },
  { key: 'end_date',      label: 'End' },
]

// Column hidden when that axis is the group key
const GROUP_HIDE_COL = { product: null, asset: '_asset_name', craft: 'craft' }

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
  const [workView,          setWorkView]          = useState('table')
  const [sortKey,           setSortKey]           = useState(null)
  const [sortDir,           setSortDir]           = useState('asc')
  const [warningsDismissed, setWarningsDismissed] = useState(false)

  // Work tab filter + group state
  const [wProductFilter, setWProductFilter] = useState('')
  const [wCraftFilter,   setWCraftFilter]   = useState('')
  const [wAssetSearch,   setWAssetSearch]   = useState('')
  const [workGroup,      setWorkGroup]      = useState(null) // null | 'product' | 'asset' | 'craft'

  const dismissWarnings = useCallback(() => setWarningsDismissed(true), [])

  // Lookup maps
  const productById = useMemo(() => Object.fromEntries(products.map(p => [p.id, p])), [products])
  const assetById   = useMemo(() => Object.fromEntries(assets.map(a => [a.id, a])),   [assets])

  const enrichedAssets = useMemo(() => assets.map(a => ({
    ...a,
    _profile:      _profileLabel(a.variable_values),
    _product_name: productById[a.product_id]?.name ?? '—',
  })), [assets, productById])

  const enrichedWork = useMemo(() => work.map(w => {
    const asset   = assetById[w.asset_id]
    const product = asset ? productById[asset.product_id] : null
    return {
      ...w,
      _asset_name:   asset?.name   ?? '—',
      _product_name: product?.name ?? '—',
    }
  }), [work, assetById, productById])

  // Derived filter options (unique values present in the data)
  const productOptions = useMemo(() =>
    [...new Set(enrichedWork.map(w => w._product_name))].filter(Boolean).sort(_naturalSort),
    [enrichedWork])
  const craftOptions = useMemo(() =>
    [...new Set(enrichedWork.map(w => w.craft).filter(Boolean))].sort(),
    [enrichedWork])

  // Filtered work rows
  const filteredWork = useMemo(() => enrichedWork.filter(w => {
    if (wProductFilter && w._product_name !== wProductFilter) return false
    if (wCraftFilter   && w.craft         !== wCraftFilter)   return false
    if (wAssetSearch   && !w._asset_name.toLowerCase().includes(wAssetSearch.toLowerCase())) return false
    return true
  }), [enrichedWork, wProductFilter, wCraftFilter, wAssetSearch])

  const hasWorkFilters = wProductFilter || wCraftFilter || wAssetSearch

  const rows = tab === 'Products' ? products
             : tab === 'Assets'   ? enrichedAssets
             :                      filteredWork

  const cols = tab === 'Products' ? PRODUCT_COLS
             : tab === 'Assets'   ? ASSET_COLS
             :                      WORK_COLS

  const sorted = sortKey ? _sort(rows, sortKey, sortDir) : rows

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const handleTabChange = (t) => {
    setTab(t)
    setSortKey(null)
    setSortDir('asc')
  }

  const showWarnings = !warningsDismissed && preflightWarnings.length > 0
  const showTimeline = tab === 'Work' && workView === 'timeline' && hasData && work.length > 0

  // Work columns with group-hidden column removed
  const visibleWorkCols = workGroup
    ? WORK_COLS.filter(c => c.key !== GROUP_HIDE_COL[workGroup])
    : WORK_COLS

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border px-6">
        <div className="flex flex-1">
          {TABS.map(t => {
            const count = t === 'Work' && hasWorkFilters
              ? `${filteredWork.length}/${work.length}`
              : t === 'Products' ? products.length
              : t === 'Assets'   ? assets.length
              :                    work.length
            return (
              <button
                key={t}
                onClick={() => handleTabChange(t)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  tab === t
                    ? 'border-accent text-foreground'
                    : 'border-transparent text-muted hover:text-foreground'
                }`}
              >
                {t}
                {hasData && (
                  <span className="ml-1.5 text-xs text-muted">({count})</span>
                )}
              </button>
            )
          })}
        </div>

        {/* Work tab controls */}
        {tab === 'Work' && hasData && work.length > 0 && (
          <div className="flex items-center gap-2 mr-3">
            {/* Group by — table view only */}
            {workView === 'table' && (
              <div className="flex items-center gap-1 p-0.5 bg-surface-2 rounded border border-border">
                {[
                  { value: null,      label: 'No group' },
                  { value: 'product', label: 'Product' },
                  { value: 'asset',   label: 'Asset' },
                  { value: 'craft',   label: 'Craft' },
                ].map(opt => (
                  <button
                    key={String(opt.value)}
                    onClick={() => setWorkGroup(opt.value)}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      workGroup === opt.value
                        ? 'bg-accent/20 text-accent'
                        : 'text-muted hover:text-foreground'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            {/* Table / Timeline toggle */}
            <div className="flex items-center gap-1 p-0.5 bg-surface-2 rounded border border-border">
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

      {/* Work filter bar */}
      {tab === 'Work' && hasData && work.length > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border/50 bg-surface-2/30">
          <span className="text-xs text-muted shrink-0">Filter:</span>

          <select
            value={wProductFilter}
            onChange={e => setWProductFilter(e.target.value)}
            className={`text-xs rounded px-2 py-1 border transition-colors bg-transparent cursor-pointer ${
              wProductFilter ? 'border-accent/60 text-foreground' : 'border-border text-muted'
            }`}
          >
            <option value="">All products</option>
            {productOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          <select
            value={wCraftFilter}
            onChange={e => setWCraftFilter(e.target.value)}
            className={`text-xs rounded px-2 py-1 border transition-colors bg-transparent cursor-pointer ${
              wCraftFilter ? 'border-accent/60 text-foreground' : 'border-border text-muted'
            }`}
          >
            <option value="">All crafts</option>
            {craftOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <input
            type="text"
            placeholder="Search asset…"
            value={wAssetSearch}
            onChange={e => setWAssetSearch(e.target.value)}
            className={`text-xs rounded px-2 py-1 border transition-colors bg-transparent placeholder:text-muted/50 ${
              wAssetSearch ? 'border-accent/60 text-foreground' : 'border-border text-muted'
            }`}
          />

          {hasWorkFilters && (
            <button
              onClick={() => { setWProductFilter(''); setWCraftFilter(''); setWAssetSearch('') }}
              className="text-xs text-muted hover:text-foreground transition-colors ml-1"
            >
              Clear
            </button>
          )}
        </div>
      )}

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
              <a href="/org?tab=estimates" className="text-accent hover:text-accent/80 transition-colors">
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
        <WorkTimeline work={filteredWork} assets={assets} />
      ) : (
        <div className="flex-1 overflow-auto px-6 py-4">
          {isGenerating && !hasData ? (
            <SkeletonTable cols={cols} />
          ) : !hasData ? (
            <EmptyState stage="before" />
          ) : sorted.length === 0 ? (
            <EmptyState stage="empty_tab" tab={tab} />
          ) : tab === 'Work' && workGroup ? (
            <GroupedWorkTable
              rows={sorted}
              cols={visibleWorkCols}
              groupKey={workGroup === 'product' ? '_product_name' : workGroup === 'asset' ? '_asset_name' : 'craft'}
              groupLabel={workGroup.charAt(0).toUpperCase() + workGroup.slice(1)}
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={handleSort}
            />
          ) : (
            <FlatTable rows={sorted} cols={cols} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
          )}
        </div>
      )}
    </div>
  )
}

// ── Table renderers ───────────────────────────────────────────────────────────

function FlatTable({ rows, cols, sortKey, sortDir, onSort }) {
  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-border">
          {cols.map(col => (
            <th
              key={col.key}
              onClick={() => onSort(col.key)}
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
        {rows.map((row, i) => (
          <tr key={row.id ?? i} className="border-b border-border/50 hover:bg-surface-2 transition-colors">
            {cols.map(col => (
              <td key={col.key} className="py-2 px-3 text-foreground">{_fmt(row[col.key])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GroupedWorkTable({ rows, cols, groupKey, groupLabel, sortKey, sortDir, onSort }) {
  // Build ordered groups preserving natural sort of group keys
  const groupMap = {}
  const groupOrder = []
  for (const row of rows) {
    const key = row[groupKey] || '—'
    if (!groupMap[key]) { groupMap[key] = []; groupOrder.push(key) }
    groupMap[key].push(row)
  }
  groupOrder.sort(_naturalSort)

  const [collapsed, setCollapsed] = useState({})
  const toggle = (key) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="border-b border-border">
          <th className="text-left py-2 px-3 text-muted font-medium text-xs w-6" />
          {cols.map(col => (
            <th
              key={col.key}
              onClick={() => onSort(col.key)}
              className="text-left py-2 px-3 text-muted font-medium text-xs cursor-pointer select-none hover:text-foreground transition-colors"
            >
              {col.label}
              {sortKey === col.key && <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groupOrder.map(groupKey_ => {
          const groupRows = groupMap[groupKey_]
          const isOpen    = !collapsed[groupKey_]
          return [
            <tr
              key={`hdr-${groupKey_}`}
              onClick={() => toggle(groupKey_)}
              className="border-b border-border bg-surface-2/60 cursor-pointer hover:bg-surface-2 transition-colors select-none"
            >
              <td className="py-1.5 px-3 text-muted text-xs">{isOpen ? '▾' : '▸'}</td>
              <td colSpan={cols.length} className="py-1.5 px-3">
                <span className="text-foreground font-medium text-xs">{groupKey_}</span>
                <span className="ml-2 text-muted text-xs">({groupRows.length})</span>
              </td>
            </tr>,
            ...(isOpen ? groupRows.map((row, i) => (
              <tr key={row.id ?? `${groupKey_}-${i}`} className="border-b border-border/40 hover:bg-surface-2 transition-colors">
                <td className="py-2 px-3" />
                {cols.map(col => (
                  <td key={col.key} className="py-2 px-3 text-foreground">{_fmt(row[col.key])}</td>
                ))}
              </tr>
            )) : []),
          ]
        })}
      </tbody>
    </table>
  )
}

// ── Timeline ──────────────────────────────────────────────────────────────────

const PX_PER_DAY  = 5
const LANE_H      = 10
const ROW_PAD     = 4
const HEADER_H    = 32
const LABEL_W     = 200

function assignLanes(tasks) {
  const sorted = [...tasks].sort((a, b) => a.start_date.localeCompare(b.start_date))
  const laneEnd = []
  return sorted.map(task => {
    let lane = laneEnd.findIndex(e => e < task.start_date)
    if (lane === -1) { lane = laneEnd.length; laneEnd.push(task.end_date) }
    else laneEnd[lane] = task.end_date
    return { ...task, _lane: lane }
  })
}

function WorkTimeline({ work, assets }) {
  const assetById = Object.fromEntries(assets.map(a => [a.id, a]))

  let minMs = Infinity, maxMs = -Infinity
  for (const w of work) {
    if (w.start_date) minMs = Math.min(minMs, +new Date(w.start_date))
    if (w.end_date)   maxMs = Math.max(maxMs, +new Date(w.end_date))
  }
  if (!isFinite(minMs)) return <EmptyState stage="empty_tab" tab="Work" />

  const minDate   = new Date(minMs)
  const maxDate   = new Date(maxMs)
  const totalDays = Math.ceil((maxMs - minMs) / 86_400_000) + 1
  const totalWidth = totalDays * PX_PER_DAY

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

  const byAsset = {}
  for (const w of work) {
    const name = w._asset_name ?? assetById[w.asset_id]?.name ?? w.asset_id
    if (!byAsset[name]) byAsset[name] = []
    byAsset[name].push(w)
  }
  const assetNames = Object.keys(byAsset).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const assetTasks = {}
  const assetRowH  = {}
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

      <div className="flex-1 overflow-auto">
        <div style={{ width: LABEL_W + totalWidth, minWidth: '100%' }}>
          <div className="flex sticky top-0 z-20" style={{ background: 'var(--color-background, #0f0e1a)' }}>
            <div
              className="sticky left-0 z-30 shrink-0 border-b border-r border-border flex items-end pb-1 px-3"
              style={{ width: LABEL_W, height: HEADER_H, background: 'var(--color-background, #0f0e1a)' }}
            >
              <span className="text-xs text-muted font-medium">Asset</span>
            </div>
            <div className="relative border-b border-border" style={{ width: totalWidth, height: HEADER_H, flexShrink: 0 }}>
              {months.map((m, i) => (
                <div key={i} className="absolute bottom-0 pb-1 text-xs text-muted select-none" style={{ left: m.x + 4 }}>
                  {m.label}
                </div>
              ))}
            </div>
          </div>

          {assetNames.map(name => {
            const rowH = assetRowH[name]
            return (
              <div key={name} className="flex" style={{ height: rowH }}>
                <div
                  className="sticky left-0 z-10 shrink-0 flex items-center px-3 border-b border-r border-border/50 text-xs text-muted truncate"
                  style={{ width: LABEL_W, background: 'var(--color-background, #0f0e1a)' }}
                  title={name}
                >
                  {name}
                </div>
                <div className="relative border-b border-border/30" style={{ width: totalWidth, flexShrink: 0 }}>
                  {months.map((m, i) => (
                    <div key={i} className="absolute top-0 bottom-0" style={{ left: m.x, width: 1, background: 'rgba(255,255,255,0.04)' }} />
                  ))}
                  {assetTasks[name].map((w, i) => (
                    <div
                      key={i}
                      title={`${w.step_name} · ${w.craft ?? 'No craft'} · ${w.estimate_days}d\n${w.start_date} → ${w.end_date}`}
                      style={{
                        position: 'absolute',
                        left:     barX(w.start_date),
                        width:    barW(w.start_date, w.end_date),
                        top:      ROW_PAD + w._lane * LANE_H,
                        height:   LANE_H - 2,
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
            <th key={col.key} className="text-left py-2 px-3 text-muted font-medium text-xs">{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 5 }).map((_, i) => (
          <tr key={i} className="border-b border-border/50">
            {cols.map((col, j) => (
              <td key={col.key} className="py-2 px-3">
                <div className="h-3 bg-surface-2 rounded animate-pulse" style={{ width: `${60 + ((i * 3 + j * 7) % 30)}%` }} />
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

function _naturalSort(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}
