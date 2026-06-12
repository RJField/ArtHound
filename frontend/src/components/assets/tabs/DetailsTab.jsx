import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { makeRecordResolver } from '../../../lib/api'
import { fmtDate, formatRawFields } from '../../../lib/fields'
import { cn } from '../../../lib/utils'
import { priorityColor } from '../../../lib/statusColors'
import { EmptyState, StatusDot } from '../../ui'
import DetailModal from '../../DetailModal'

const SLOT_ORDER = [
  'name', 'dev_name', 'item_type', 'product',
  'priority', 'project_date', 'status', 'asset_number',
]

const SLOT_FALLBACK_LABELS = {
  name:         'Name',
  dev_name:     'Dev Name',
  item_type:    'Item Type',
  product:      'Product',
  priority:     'Priority',
  project_date: 'Date',
  status:       'Status',
  asset_number: 'Asset #',
}

function getSlotValue(asset, slotKey) {
  switch (slotKey) {
    case 'name':         return asset.name || null
    case 'dev_name':     return asset.devName || null
    case 'item_type':    return asset.itemType || null
    case 'product':      return asset.product || null
    case 'priority':     return asset.priority != null ? `P${asset.priority}` : null
    case 'project_date': return asset.projectDate ? fmtDate(asset.projectDate.slice(0, 10)) : null
    case 'status':       return asset.rawFields?.Status ?? null
    case 'asset_number': return asset.assetNumber || null
    default:             return null
  }
}

// Key-value row matching the <KV> vocabulary; hand-written because rows can be
// click-to-drill (linked records), which KV does not forward.
function FieldRow({ f, onDrill }) {
  const display  = f.value != null && f.value !== '' ? String(f.value) : '—'
  const isLinked = f.type === 'linked-record' && f.resolve
  const isLink   = f.type === 'link' && f.href
  const isStatus = f.type === 'status' && display !== '—'

  return (
    <div
      onClick={isLinked ? () => onDrill(f) : undefined}
      className={cn(
        'flex items-start gap-3 py-1.5 border-b border-border-faint last:border-b-0',
        isLinked && display !== '—' && 'cursor-pointer group'
      )}
    >
      <span className="text-faint text-xs w-24 shrink-0 pt-0.5">{f.label}</span>
      <span className={cn(
        'text-xs flex-1 break-words',
        display === '—'                       ? 'text-faint'    : 'text-foreground',
        isLinked && display !== '—'           ? 'text-link group-hover:underline' : '',
      )}>
        {isLink ? (
          <a href={f.href} target="_blank" rel="noopener" className="text-link hover:underline">
            {display}
          </a>
        ) : isStatus ? (
          <StatusDot label={display} color={f.statusColor} />
        ) : (
          <>
            {display}
            {isLinked && display !== '—' && <span className="ml-1 text-muted">↗</span>}
          </>
        )}
      </span>
    </div>
  )
}

export default function DetailsTab({ asset, schema }) {
  const [drillModal, setDrillModal] = useState(null)
  const [showMore, setShowMore]     = useState(false)

  const { slotFields, primaryMeta, secondaryMeta } = useMemo(() => {
    if (!asset) return { slotFields: [], primaryMeta: [], secondaryMeta: [] }

    const slotFields = SLOT_ORDER.flatMap(slotKey => {
      const value = getSlotValue(asset, slotKey)
      if (!value) return []
      const col   = schema?.columns.find(c => c.source === 'slot' && c.slotKey === slotKey)
      const label = col?.label ?? SLOT_FALLBACK_LABELS[slotKey]

      if (slotKey === 'product' && asset.productId) {
        return [{
          label,
          value,
          type: 'linked-record',
          resolve: makeRecordResolver('products', asset.productId, value),
        }]
      }
      if (slotKey === 'status') {
        return [{ label, value, type: 'status' }]
      }
      if (slotKey === 'priority') {
        return [{ label, value, type: 'status', statusColor: priorityColor(asset.priority) }]
      }
      return [{ label, value }]
    })

    // Build field → tier lookup from schema columns
    const fieldTierMap = {}
    for (const col of schema?.columns ?? []) {
      if (col.source === 'meta') fieldTierMap[col.fieldName] = col.displayTier
    }

    // rawFields.Status is already covered by the 'status' slot above.
    const coveredRawKeys = new Set(['Status'])
    const allMeta = formatRawFields(
      Object.fromEntries(
        Object.entries(asset.rawFields ?? {}).filter(([k]) => !coveredRawKeys.has(k))
      )
    )

    const primaryMeta   = []
    const secondaryMeta = []
    for (const f of allMeta) {
      const tier = fieldTierMap[f.label] ?? 'secondary'
      if (tier === 'primary') primaryMeta.push(f)
      else secondaryMeta.push(f)
    }

    return { slotFields, primaryMeta, secondaryMeta }
  }, [asset?.id, schema])

  async function openDrill(field) {
    setDrillModal({ title: 'Loading…', fields: [], loading: true })
    try {
      setDrillModal(await field.resolve())
    } catch (err) {
      setDrillModal(null)
      toast.error(err.message)
    }
  }

  const visibleFields = [...slotFields, ...primaryMeta]
  const hasAny = visibleFields.length > 0 || secondaryMeta.length > 0

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {!hasAny && (
        <EmptyState title="No fields available." />
      )}

      <div className="flex flex-col">
        {visibleFields.map((f, i) => (
          <FieldRow key={i} f={f} onDrill={openDrill} />
        ))}
      </div>

      {secondaryMeta.length > 0 && (
        <>
          <button
            onClick={() => setShowMore(v => !v)}
            className="mt-2 w-full text-left text-muted text-xs hover:text-foreground transition-colors py-1.5 flex items-center gap-1 cursor-pointer"
          >
            <span className="text-faint">{showMore ? '↑' : '↓'}</span>
            {showMore
              ? 'Show fewer fields'
              : `${secondaryMeta.length} more field${secondaryMeta.length !== 1 ? 's' : ''}`
            }
          </button>

          {showMore && (
            <div className="flex flex-col">
              {secondaryMeta.map((f, i) => (
                <FieldRow key={i} f={f} onDrill={openDrill} />
              ))}
            </div>
          )}
        </>
      )}

      {drillModal && <DetailModal {...drillModal} onClose={() => setDrillModal(null)} />}
    </div>
  )
}
