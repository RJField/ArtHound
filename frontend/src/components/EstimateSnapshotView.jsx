import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Table, Th, Tr, Td, Pill, EmptyState } from './ui'

// Read-only renderer for a frozen estimate-share snapshot (vendor-estimate-share plan §3.5, §4.5).
// The snapshot is self-describing; granularity decides whether a per-profile breakdown is present:
//   asset_total   → total only (no breakdown key)
//   craft_bucket  → breakdown labelled by craft
//   workflow_step → breakdown labelled by step name
// This component renders exactly what the snapshot carries — it never infers detail the vendor
// chose not to expose.

export const GRANULARITY_LABELS = {
  asset_total:   'Asset total',
  craft_bucket:  'By craft',
  workflow_step: 'By workflow step',
}

export const GRANULARITY_HINTS = {
  asset_total:   'One total per asset profile — no process breakdown.',
  craft_bucket:  'Totals grouped by craft. No individual step names.',
  workflow_step: 'Per-step detail, labelled with each workflow step.',
}

function profileName(variableValues, variableFields) {
  const vv = variableValues || {}
  const fields = variableFields?.length ? variableFields : Object.keys(vv)
  const parts = fields.map(f => vv[f]).filter(v => v != null && v !== '')
  return parts.length ? parts.join(' · ') : 'Default'
}

function ProfileRow({ profile, variableFields, unit, hasBreakdown }) {
  const [open, setOpen] = useState(false)
  const breakdown = profile.breakdown || []
  const canExpand = hasBreakdown && breakdown.length > 0

  return (
    <>
      <Tr
        onClick={canExpand ? () => setOpen(o => !o) : undefined}
        className={canExpand ? undefined : 'hover:bg-transparent'}
      >
        <Td primary>
          <span className="flex items-center gap-1.5 min-w-0">
            {canExpand ? (
              open
                ? <ChevronDown size={12} className="text-muted shrink-0" />
                : <ChevronRight size={12} className="text-muted shrink-0" />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className="truncate">
              {profileName(profile.variable_values, variableFields)}
            </span>
          </span>
        </Td>
        <Td className="text-right text-foreground font-semibold">
          {profile.total_days} {unit}
        </Td>
      </Tr>

      {open && canExpand && breakdown.map((b, i) => (
        <Tr key={i} className="bg-surface-2 hover:bg-surface-2">
          <Td className="pl-8 border-border-faint">{b.label}</Td>
          <Td className="text-right border-border-faint">{b.days} {unit}</Td>
        </Tr>
      ))}
    </>
  )
}

export default function EstimateSnapshotView({ snapshot }) {
  if (!snapshot) return null
  const { granularity, variable_fields: variableFields, unit = 'days', profiles = [] } = snapshot
  const hasBreakdown = granularity !== 'asset_total'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <Pill tone="neutral">{GRANULARITY_LABELS[granularity] ?? granularity}</Pill>
        <span>{GRANULARITY_HINTS[granularity]}</span>
      </div>

      {profiles.length === 0 ? (
        <EmptyState title="This share contains no estimate profiles." />
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <Table>
            <thead>
              <tr>
                <Th>Profile</Th>
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p, i) => (
                <ProfileRow
                  key={i}
                  profile={p}
                  variableFields={variableFields}
                  unit={unit}
                  hasBreakdown={hasBreakdown}
                />
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  )
}
