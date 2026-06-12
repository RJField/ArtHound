import { useState, useCallback, useMemo } from 'react'
import { X } from 'lucide-react'
import { EmptyState, Input, Pill, Select, Skeleton, Spinner, StatusDot, Table, Tabs, Td, Th, Tr } from '../ui'
import { craftColor } from '../../lib/statusColors'

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

const GROUP_OPTIONS = [
  { value: '',        label: 'No group' },
  { value: 'product', label: 'Group: Product' },
  { value: 'asset',   label: 'Group: Asset' },
  { value: 'craft',   label: 'Group: Craft' },
]

export default function ScenarioViewer({
  products, assets, work, isGenerating, hasData,
  generationMode = 'ai', preflightWarnings = [], generationStatus = null,
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

  const tabItems = TABS.map(t => ({
    id: t,
    label: t,
    count: hasData
      ? (t === 'Work' && hasWorkFilters
          ? `${filteredWork.length}/${work.length}`
          : t === 'Products' ? products.length
          : t === 'Assets'   ? assets.length
          :                    work.length)
      : undefined,
  }))

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-2 border-b border-border px-6">
        <Tabs tabs={tabItems} active={tab} onChange={handleTabChange} className="flex-1 border-b-0" />

        {/* Work tab controls */}
        {tab === 'Work' && hasData && work.length > 0 && (
          <div className="flex items-center gap-2">
            {/* Group by — table view only */}
            {workView === 'table' && (
              <Select
                size="sm"
                value={workGroup ?? ''}
                onChange={e => setWorkGroup(e.target.value || null)}
              >
                {GROUP_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </Select>
            )}

            {/* Table / Timeline toggle */}
            <div className="flex items-center gap-1 p-0.5 bg-surface-2 rounded-md border border-border">
              {['table', 'timeline'].map(v => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setWorkView(v)}
                  className={`px-2.5 py-1 text-xs rounded transition-colors cursor-pointer ${
                    workView === v
                      ? 'bg-accent-tint-2 text-accent-hover'
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
          <Pill tone={generationMode === 'rule_based' ? 'accent' : 'neutral'} className="shrink-0">
            {generationMode === 'rule_based' ? 'Rule-based' : 'AI'}
          </Pill>
        )}
      </div>

      {/* Work filter bar */}
      {tab === 'Work' && hasData && work.length > 0 && (
        <div className="flex items-center gap-2 px-6 py-2 border-b border-border-soft bg-surface">
          <span className="text-xs text-faint shrink-0">Filter:</span>

          <Select
            size="sm"
            value={wProductFilter}
            onChange={e => setWProductFilter(e.target.value)}
            className={wProductFilter ? 'border-accent/60 text-foreground' : 'text-muted'}
          >
            <option value="">All products</option>
            {productOptions.map(p => <option key={p} value={p}>{p}</option>)}
          </Select>

          <Select
            size="sm"
            value={wCraftFilter}
            onChange={e => setWCraftFilter(e.target.value)}
            className={wCraftFilter ? 'border-accent/60 text-foreground' : 'text-muted'}
          >
            <option value="">All crafts</option>
            {craftOptions.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>

          <Input
            size="sm"
            type="text"
            placeholder="Search asset…"
            value={wAssetSearch}
            onChange={e => setWAssetSearch(e.target.value)}
            className={wAssetSearch ? 'border-accent/60' : ''}
          />

          {hasWorkFilters && (
            <button
              type="button"
              onClick={() => { setWProductFilter(''); setWCraftFilter(''); setWAssetSearch('') }}
              className="text-xs text-muted hover:text-foreground transition-colors cursor-pointer ml-1"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Sparsity warning banner */}
      {showWarnings && (
        <div className="flex items-start justify-between gap-3 mx-6 mt-3 px-4 py-3 bg-warning-tint border border-warning/25 rounded-lg text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-foreground font-medium">Matrix gaps detected</span>
            <span className="text-muted text-xs">
              {preflightWarnings.length === 1
                ? `Profile "${preflightWarnings[0].profile}" has no steps with estimates.`
                : `${preflightWarnings.length} profiles have no steps with estimates: ${preflightWarnings.map(w => `"${w.profile}"`).join(', ')}.`}
              {' '}
              <a href="/org?tab=estimates" className="text-link hover:underline">
                Edit matrix →
              </a>
            </span>
          </div>
          <button
            type="button"
            onClick={dismissWarnings}
            className="text-muted hover:text-foreground transition-colors cursor-pointer shrink-0 mt-0.5"
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Content area */}
      {showTimeline ? (
        <WorkTimeline work={filteredWork} assets={assets} />
      ) : (
        <div className="flex-1 overflow-auto px-6 py-4">
          {isGenerating && !hasData ? (
            <GeneratingState status={generationStatus} cols={cols} />
          ) : !hasData ? (
            <EmptyState title="Scenario data will appear here once generated." className="h-full" />
          ) : sorted.length === 0 ? (
            <EmptyState title={`No ${tab.toLowerCase()} in this scenario.`} />
          ) : tab === 'Work' && workGroup ? (
            <GroupedWorkTable
              rows={sorted}
              cols={visibleWorkCols}
              groupKey={workGroup === 'product' ? '_product_name' : workGroup === 'asset' ? '_asset_name' : 'craft'}
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

function _cell(row, col) {
  const value = row[col.key]
  if (col.key === 'craft' && value) {
    return <StatusDot label={value} color={craftColor(value)} />
  }
  return _fmt(value)
}

function SortableTh({ col, sortKey, sortDir, onSort }) {
  return (
    <Th
      onClick={() => onSort(col.key)}
      className="cursor-pointer select-none hover:text-muted transition-colors"
    >
      {col.label}
      {sortKey === col.key && (
        <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
      )}
    </Th>
  )
}

function FlatTable({ rows, cols, sortKey, sortDir, onSort }) {
  return (
    <Table>
      <thead>
        <tr>
          {cols.map(col => (
            <SortableTh key={col.key} col={col} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <Tr key={row.id ?? i}>
            {cols.map((col, j) => (
              <Td key={col.key} primary={j === 0}>{_cell(row, col)}</Td>
            ))}
          </Tr>
        ))}
      </tbody>
    </Table>
  )
}

function GroupedWorkTable({ rows, cols, groupKey, sortKey, sortDir, onSort }) {
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
    <Table>
      <thead>
        <tr>
          <Th className="w-6" />
          {cols.map(col => (
            <SortableTh key={col.key} col={col} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
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
              className="border-b border-border-soft bg-surface-2/60 cursor-pointer hover:bg-surface-2 transition-colors select-none"
            >
              <td className="py-1.5 px-2.5 text-muted text-xs">{isOpen ? '▾' : '▸'}</td>
              <td colSpan={cols.length} className="py-1.5 px-2.5">
                {groupKey === 'craft' ? (
                  <StatusDot
                    label={groupKey_}
                    color={craftColor(groupKey_)}
                    className="text-foreground font-medium text-xs"
                  />
                ) : (
                  <span className="text-foreground font-medium text-xs">{groupKey_}</span>
                )}
                <span className="ml-2 text-faint text-xs tabular-nums">({groupRows.length})</span>
              </td>
            </tr>,
            ...(isOpen ? groupRows.map((row, i) => (
              <Tr key={row.id ?? `${groupKey_}-${i}`}>
                <Td />
                {cols.map((col, j) => (
                  <Td key={col.key} primary={j === 0}>{_cell(row, col)}</Td>
                ))}
              </Tr>
            )) : []),
          ]
        })}
      </tbody>
    </Table>
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
  if (!isFinite(minMs)) return <EmptyState title="No work in this scenario." />

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
            <div className="w-3 h-3 rounded-sm" style={{ background: craftColor(c) }} />
            {c}
          </div>
        ))}
        {work.some(w => !w.craft) && (
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <div className="w-3 h-3 rounded-sm" style={{ background: craftColor(null) }} />
            Other
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <div style={{ width: LABEL_W + totalWidth, minWidth: '100%' }}>
          <div className="flex sticky top-0 z-20 bg-background">
            <div
              className="sticky left-0 z-30 shrink-0 border-b border-r border-border flex items-end pb-1 px-3 bg-background"
              style={{ width: LABEL_W, height: HEADER_H }}
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
                  className="sticky left-0 z-10 shrink-0 flex items-center px-3 border-b border-r border-border-soft text-xs text-muted truncate bg-background"
                  style={{ width: LABEL_W }}
                  title={name}
                >
                  {name}
                </div>
                <div className="relative border-b border-border-faint" style={{ width: totalWidth, flexShrink: 0 }}>
                  {months.map((m, i) => (
                    <div key={i} className="absolute top-0 bottom-0 w-px bg-border-faint" style={{ left: m.x }} />
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
                        background:   craftColor(w.craft),
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

function GeneratingState({ status, cols }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2.5 py-2 text-sm text-muted">
        <Spinner size={14} className="shrink-0" />
        <span>{status ?? 'Generating scenario…'}</span>
      </div>
      <SkeletonTable cols={cols} />
    </div>
  )
}

function SkeletonTable({ cols }) {
  return (
    <Table>
      <thead>
        <tr>
          {cols.map(col => (
            <Th key={col.key}>{col.label}</Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: 5 }).map((_, i) => (
          <tr key={i} className="border-b border-border-soft">
            {cols.map((col, j) => (
              <td key={col.key} className="py-2 px-2.5">
                <div style={{ width: `${60 + ((i * 3 + j * 7) % 30)}%` }}>
                  <Skeleton className="h-3 w-full" />
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
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
