import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { fmtDate } from '../../lib/fields'

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

// ── Column picker dropdown ───────────────────────────────────────────────────

function ColumnPicker({ schema, visibleColumnIds, onToggle }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    function onOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  if (!schema) return null

  const slotCols = schema.columns.filter(c => c.source === 'slot')
  const metaCols = schema.columns.filter(c => c.source === 'meta')

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="text-muted text-xs hover:text-foreground cursor-pointer px-1.5 py-1 rounded transition-colors hover:bg-surface-2"
      >
        Columns
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 bg-surface border border-border rounded-lg shadow-lg p-3 w-52 flex flex-col gap-0.5 max-h-80 overflow-y-auto">
          {slotCols.length > 0 && (
            <p className="text-muted text-xs font-medium uppercase tracking-wide mb-1">Standard</p>
          )}
          {slotCols.map(col => {
            const pinned = col.id === 'slot:name'
            return (
              <label key={col.id} className={cn('flex items-center gap-2 py-0.5', pinned ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer')}>
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
              <p className="text-muted text-xs font-medium uppercase tracking-wide mt-2 mb-1">Source Fields</p>
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
        </div>
      )}
    </div>
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
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
          <p className="text-muted text-xs p-3">Select a product</p>
        )}
        {selectedProductId && loading && (
          <p className="text-muted text-xs p-3">Loading…</p>
        )}
        {selectedProductId && !loading && assets.length === 0 && (
          <p className="text-muted text-xs p-3">No assets for this product</p>
        )}
        {assets.length > 0 && (
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-surface z-10">
              <tr className="border-b border-border">
                <th className="w-8 px-2 py-1.5" />
                {visibleColumns.map(col => (
                  <th key={col.id} className="px-2 py-1.5 text-left text-muted font-medium whitespace-nowrap">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assets.map(a => (
                <tr
                  key={a.id}
                  onClick={() => onFocusAsset(a.id)}
                  className={cn(
                    'border-b border-border/50 cursor-pointer transition-colors',
                    focusedId === a.id ? 'bg-surface-2' : 'hover:bg-surface-2/60'
                  )}
                >
                  <td className="w-8 px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(a.id)}
                      onClick={e => e.stopPropagation()}
                      onChange={e => onToggleAsset(a.id, e.target.checked)}
                      className="accent-accent"
                    />
                  </td>
                  {visibleColumns.map(col => {
                    const val = getCellValue(a, col)
                    return (
                      <td key={col.id} className="px-2 py-1.5 max-w-[200px]">
                        <span className={cn('block truncate', val ? 'text-foreground' : 'text-border')}>
                          {val ?? '—'}
                        </span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Selection actions — studio only */}
      {(onGenerate || onSend) && (
        <div className="border-t border-border px-3 py-2 flex flex-col gap-2 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-muted text-xs flex-1">
              {selectedIds.size === 0 ? 'None selected' : `${selectedIds.size} selected`}
            </span>
          </div>
          <div className="flex gap-1.5">
            {onGenerate && (
              <button
                onClick={onGenerate}
                disabled={genBusy || selectedIds.size === 0}
                className="flex-1 px-2 py-1.5 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface-3 cursor-pointer disabled:opacity-40 transition-colors"
              >
                {genBusy ? 'Generating…' : 'Generate Work'}
              </button>
            )}
            {onSend && (
              <button
                onClick={onSend}
                disabled={selectedIds.size === 0}
                className="px-2 py-1.5 rounded-md bg-accent text-white text-xs hover:bg-accent-hover cursor-pointer disabled:opacity-40 transition-colors"
              >
                Send
              </button>
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
