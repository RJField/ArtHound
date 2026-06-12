import { Boxes, MousePointerClick } from 'lucide-react'
import { fmtDate } from '../../lib/fields'
import { priorityColor } from '../../lib/statusColors'
import { Button, Dropdown, EmptyState, SectionLabel, Spinner, StatusDot, Table, Th, Tr, Td } from '../ui'

// ── Cell value resolver ──────────────────────────────────────────────────────

function getCellValue(asset, col) {
  if (col.source === 'slot') {
    switch (col.slotKey) {
      case 'name':         return asset.name || null
      case 'dev_name':     return asset.devName || null
      case 'item_type':    return asset.itemType || null
      case 'priority':     return asset.priority != null ? `P${asset.priority}` : null
      case 'product':      return asset.product || null
      case 'project_date': return asset.projectDate ? fmtDate(asset.projectDate.slice(0, 10)) : null
      case 'status':       return asset.rawFields?.Status ?? null
      case 'asset_number': return asset.assetNumber || null
      default:             return null
    }
  }
  // meta field — value already formatted to a display string by the backend
  const v = asset.rawFields?.[col.fieldName]
  if (v == null) return null
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

function CellContent({ asset, col, val }) {
  if (val == null) return <span className="text-faint">—</span>
  if (col.source === 'slot' && col.slotKey === 'status') {
    return <StatusDot label={val} />
  }
  if (col.source === 'slot' && col.slotKey === 'priority') {
    return <StatusDot label={val} color={priorityColor(asset.priority)} />
  }
  return val
}

// ── Column picker dropdown ───────────────────────────────────────────────────

function ColumnPicker({ schema, visibleColumnIds, onToggle }) {
  if (!schema) return null

  const slotCols = schema.columns.filter(c => c.source === 'slot')
  const metaCols = schema.columns.filter(c => c.source === 'meta')

  return (
    <Dropdown
      align="right"
      width="w-52"
      panelClassName="p-3 flex flex-col gap-0.5 max-h-80 overflow-y-auto"
      trigger={({ toggle }) => (
        <Button variant="ghost" size="md" onClick={toggle}>
          Columns
        </Button>
      )}
    >
      {slotCols.length > 0 && (
        <SectionLabel className="mb-1">Standard</SectionLabel>
      )}
      {slotCols.map(col => {
        const pinned = col.id === 'slot:name'
        return (
          <label key={col.id} className={pinned ? 'flex items-center gap-2 py-0.5 opacity-50 cursor-not-allowed' : 'flex items-center gap-2 py-0.5 cursor-pointer'}>
            <input
              type="checkbox"
              checked={visibleColumnIds.includes(col.id)}
              disabled={pinned}
              onChange={() => onToggle(col.id)}
              className="accent-accent"
            />
            <span className="text-foreground text-xs">{col.label}</span>
          </label>
        )
      })}

      {metaCols.length > 0 && (
        <>
          <SectionLabel className="mt-2 mb-1">Source Fields</SectionLabel>
          {metaCols.map(col => (
            <label key={col.id} className="flex items-center gap-2 py-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={visibleColumnIds.includes(col.id)}
                onChange={() => onToggle(col.id)}
                className="accent-accent"
              />
              <span className="text-foreground text-xs truncate">{col.label}</span>
            </label>
          ))}
        </>
      )}
    </Dropdown>
  )
}

// ── Main grid ────────────────────────────────────────────────────────────────

export default function AssetGrid({
  assets, loading, selectedProductId, productName,
  selectedIds, focusedId,
  schema, visibleColumnIds, onToggleColumn,
  onToggleAsset, onToggleAll, onFocusAsset,
  genBusy, genResult, onGenerate, onSend,
}) {
  const allSelected  = assets.length > 0 && assets.every(a => selectedIds.has(a.id))
  const someSelected = selectedIds.size > 0 && !allSelected
  const cbRef        = el => { if (el) el.indeterminate = someSelected }

  const visibleColumns = schema?.columns.filter(c => visibleColumnIds.includes(c.id)) ?? []

  return (
    <div className="flex flex-col flex-1 overflow-hidden border-r border-border">

      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-surface shrink-0">
        <input
          type="checkbox"
          checked={allSelected}
          ref={cbRef}
          onChange={e => onToggleAll(e.target.checked)}
          disabled={assets.length === 0}
          className="accent-accent shrink-0"
        />
        <span className="text-muted text-xs font-medium flex-1 truncate">
          {productName || 'Assets'}
        </span>
        <ColumnPicker
          schema={schema}
          visibleColumnIds={visibleColumnIds}
          onToggle={onToggleColumn}
        />
      </div>

      {/* Scrollable table */}
      <div className="flex-1 overflow-auto">
        {!selectedProductId && (
          <EmptyState icon={MousePointerClick} title="Select a product" />
        )}
        {selectedProductId && loading && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {selectedProductId && !loading && assets.length === 0 && (
          <EmptyState icon={Boxes} title="No assets for this product" />
        )}
        {assets.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th className="w-8 px-2" />
                {visibleColumns.map(col => (
                  <Th key={col.id}>{col.label}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assets.map(a => (
                <Tr
                  key={a.id}
                  selected={focusedId === a.id}
                  onClick={() => onFocusAsset(a.id)}
                >
                  <Td className="w-8 px-2">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(a.id)}
                      onClick={e => e.stopPropagation()}
                      onChange={e => onToggleAsset(a.id, e.target.checked)}
                      className="accent-accent"
                    />
                  </Td>
                  {visibleColumns.map(col => {
                    const val = getCellValue(a, col)
                    return (
                      <Td key={col.id} primary={col.id === 'slot:name'} className="max-w-[200px]">
                        <CellContent asset={a} col={col} val={val} />
                      </Td>
                    )
                  })}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </div>

      {/* Selection actions — studio only */}
      {(onGenerate || onSend) && (
        <div className="border-t border-border px-3 py-2 flex flex-col gap-2 shrink-0 bg-surface">
          <div className="flex items-center gap-1.5">
            <span className="text-muted text-xs flex-1 tabular-nums">
              {selectedIds.size === 0 ? 'None selected' : `${selectedIds.size} selected`}
            </span>
          </div>
          <div className="flex gap-1.5">
            {onGenerate && (
              <Button
                size="md"
                onClick={onGenerate}
                disabled={genBusy || selectedIds.size === 0}
                className="flex-1"
              >
                {genBusy ? 'Generating…' : 'Generate Work'}
              </Button>
            )}
            {onSend && (
              <Button
                variant="primary"
                size="md"
                onClick={onSend}
                disabled={selectedIds.size === 0}
              >
                Send
              </Button>
            )}
          </div>
          {genResult && (
            <div className="text-xs flex flex-col gap-1">
              {genResult.created > 0 && (
                <span className="text-success">✓ {genResult.created} tasks written</span>
              )}
              {genResult.failed?.map((f, i) => (
                <div key={i} className="text-error">✕ {f.error}</div>
              ))}
              {genResult.warnings?.map((w, i) => (
                <div key={i} className="text-muted">· {w}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
