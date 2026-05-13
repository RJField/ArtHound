import { useState } from 'react'

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

export default function ScenarioViewer({ products, assets, work, isGenerating, hasData }) {
  const [tab,      setTab]      = useState('Products')
  const [sortKey,  setSortKey]  = useState(null)
  const [sortDir,  setSortDir]  = useState('asc')

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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Tab bar */}
      <div className="flex border-b border-border px-6">
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

      {/* Table area */}
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
    </div>
  )
}

function EmptyState({ stage, tab }) {
  if (stage === 'before') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-center py-16">
        <p className="text-muted text-sm">Scenario data will appear here once generated.</p>
        <p className="text-muted text-xs">Answer the scoping questions above to get started.</p>
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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
