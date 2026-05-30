import { useState } from 'react'

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
    <div className="flex flex-col">
      <button
        type="button"
        disabled={!canExpand}
        onClick={() => canExpand && setOpen(o => !o)}
        className={
          'flex items-center justify-between gap-4 px-3 py-2 text-left ' +
          (canExpand ? 'cursor-pointer hover:bg-surface-2' : 'cursor-default')
        }
      >
        <span className="flex items-center gap-2 min-w-0">
          {canExpand && (
            <span className="text-muted text-xs w-3 shrink-0">{open ? '▾' : '▸'}</span>
          )}
          {!canExpand && <span className="w-3 shrink-0" />}
          <span className="text-foreground text-xs font-medium truncate">
            {profileName(profile.variable_values, variableFields)}
          </span>
        </span>
        <span className="text-foreground text-xs font-semibold tabular-nums shrink-0">
          {profile.total_days} {unit}
        </span>
      </button>

      {open && canExpand && (
        <div className="flex flex-col divide-y divide-border border-t border-border bg-surface-2">
          {breakdown.map((b, i) => (
            <div key={i} className="flex items-center justify-between gap-4 pl-8 pr-3 py-1.5">
              <span className="text-muted text-xs truncate">{b.label}</span>
              <span className="text-muted text-xs tabular-nums shrink-0">{b.days} {unit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function EstimateSnapshotView({ snapshot }) {
  if (!snapshot) return null
  const { granularity, variable_fields: variableFields, unit = 'days', profiles = [] } = snapshot
  const hasBreakdown = granularity !== 'asset_total'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="px-2 py-0.5 rounded-full bg-surface-2 border border-border text-foreground">
          {GRANULARITY_LABELS[granularity] ?? granularity}
        </span>
        <span>{GRANULARITY_HINTS[granularity]}</span>
      </div>

      {profiles.length === 0 ? (
        <p className="text-muted text-xs">This share contains no estimate profiles.</p>
      ) : (
        <div className="flex flex-col divide-y divide-border border border-border rounded-lg overflow-hidden">
          {profiles.map((p, i) => (
            <ProfileRow
              key={i}
              profile={p}
              variableFields={variableFields}
              unit={unit}
              hasBreakdown={hasBreakdown}
            />
          ))}
        </div>
      )}
    </div>
  )
}
