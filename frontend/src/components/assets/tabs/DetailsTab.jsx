import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { makeRecordResolver } from '../../../lib/api'
import { fmtDate, formatRawFields } from '../../../lib/fields'
import { cn } from '../../../lib/utils'
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

export default function DetailsTab({ asset, schema }) {
  const [drillModal, setDrillModal] = useState(null)

  const { slotFields, metaFields } = useMemo(() => {
    if (!asset) return { slotFields: [], metaFields: [] }

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
      return [{ label, value }]
    })

    // rawFields.Status is already covered by the 'status' slot above.
    const coveredRawKeys = new Set(['Status'])
    const metaFields = formatRawFields(
      Object.fromEntries(
        Object.entries(asset.rawFields ?? {}).filter(([k]) => !coveredRawKeys.has(k))
      )
    )

    return { slotFields, metaFields }
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

  const allFields = [...slotFields, ...metaFields]

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {allFields.length === 0 && (
        <p className="text-muted text-xs">No fields available.</p>
      )}
      <div className="flex flex-col divide-y divide-border/40">
        {allFields.map((f, i) => {
          const display  = f.value != null && f.value !== '' ? String(f.value) : '—'
          const isLinked = f.type === 'linked-record' && f.resolve
          const isLink   = f.type === 'link' && f.href

          return (
            <div
              key={i}
              onClick={isLinked ? () => openDrill(f) : undefined}
              className={cn(
                'flex items-start gap-3 py-1.5',
                isLinked && display !== '—' && 'cursor-pointer group'
              )}
            >
              <span className="text-muted text-xs w-24 shrink-0 pt-0.5">{f.label}</span>
              <span className={cn(
                'text-xs flex-1 break-words',
                display === '—'                       ? 'text-border'    : 'text-foreground',
                isLinked && display !== '—'           ? 'text-p2 group-hover:underline' : '',
              )}>
                {isLink ? (
                  <a href={f.href} target="_blank" rel="noopener" className="text-p2 hover:underline">
                    {display}
                  </a>
                ) : (
                  <>
                    {display}
                    {isLinked && display !== '—' && <span className="ml-1 text-muted">↗</span>}
                  </>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {drillModal && <DetailModal {...drillModal} onClose={() => setDrillModal(null)} />}
    </div>
  )
}
