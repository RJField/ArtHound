import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'

const SETTINGS_NAV = [
  { label: 'Estimates', to: '/estimates' },
  { label: 'Workflows', to: '/workflows' },
]

const BUCKETS = [
  { value: 'production',    label: 'Production' },
  { value: 'technical',     label: 'Technical' },
  { value: 'business',      label: 'Business' },
  { value: 'custom',        label: 'Custom' },
  { value: 'source_native', label: 'Source native' },
]

const BUCKET_TIER = {
  production:    'primary',
  technical:     'secondary',
  business:      'secondary',
  source_native: 'hidden',
  custom:        'secondary',
}

export default function FieldMappingModal({ onClose }) {
  const navigate = useNavigate()
  const [sourceType, setSourceType] = useState('airtable')
  const [mappings, setMappings]     = useState([])
  const [slots, setSlots]           = useState([])
  const [updatedAt, setUpdatedAt]   = useState(null)
  const [assignments, setAssignments] = useState({}) // slot → source_field_id
  const [buckets, setBuckets]       = useState({})   // source_field_id → {meta_bucket, display_tier, ingest_suppressed}
  const [driftEvents, setDriftEvents] = useState([])
  const [status, setStatus]           = useState(null)
  const [loading, setLoading]         = useState(true)
  const [saving, setSaving]           = useState(false)
  const [syncing, setSyncing]         = useState(false)
  const [error, setError]             = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [])

  async function load(signal) {
    setLoading(true)
    setError(null)
    try {
      const [data, drift] = await Promise.all([
        apiFetch('/api/sync/field-mapping', signal ? { signal } : {}),
        apiFetch('/api/sync/schema-drift').catch(() => ({ events: [] })),
      ])
      setDriftEvents(drift.events || [])
      setSourceType(data.source_type ?? 'airtable')
      setMappings(data.mappings)
      setSlots(data.slots)
      setUpdatedAt(data.updated_at)

      const a = {}
      const b = {}
      for (const m of data.mappings) {
        if (m.arthound_slot) a[m.arthound_slot] = m.source_field_id
        b[m.source_field_id] = {
          meta_bucket:       m.meta_bucket       ?? 'custom',
          display_tier:      m.display_tier      ?? 'secondary',
          ingest_suppressed: m.ingest_suppressed ?? false,
        }
      }
      setAssignments(a)
      setBuckets(b)
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function setSlotAssignment(slot, fieldId) {
    setAssignments(prev => {
      const next = { ...prev }
      if (fieldId) next[slot] = fieldId
      else delete next[slot]
      return next
    })
  }

  function setBucketForField(fieldId, bucket) {
    setBuckets(prev => ({
      ...prev,
      [fieldId]: {
        ...prev[fieldId],
        meta_bucket:  bucket,
        display_tier: BUCKET_TIER[bucket] ?? 'secondary',
      },
    }))
  }

  function setSuppressed(fieldId, suppressed) {
    setBuckets(prev => ({
      ...prev,
      [fieldId]: { ...prev[fieldId], ingest_suppressed: suppressed },
    }))
  }

  async function save() {
    setSaving(true)
    setStatus(null)
    try {
      const updated = mappings.map(m => {
        const slot = Object.entries(assignments).find(([, fid]) => fid === m.source_field_id)?.[0] ?? null
        const b    = buckets[m.source_field_id] || {}
        return {
          ...m,
          arthound_slot:     slot,
          meta_bucket:       b.meta_bucket       ?? m.meta_bucket       ?? 'custom',
          display_tier:      b.display_tier      ?? m.display_tier      ?? 'secondary',
          ingest_suppressed: b.ingest_suppressed ?? m.ingest_suppressed ?? false,
        }
      })
      await apiFetch('/api/sync/field-mapping', {
        method: 'PUT',
        body: JSON.stringify({ source_type: sourceType, mappings: updated }),
      })
      setMappings(updated)
      setStatus(`Saved at ${new Date().toLocaleString()}`)
    } catch (e) {
      setStatus(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function resync() {
    setSyncing(true)
    setStatus('Sync started…')
    try {
      const { log_id } = await apiFetch('/api/sync/run', {
        method: 'POST',
        body: JSON.stringify({ source_type: sourceType, full: true }),
      })
      let delay = 1500
      while (true) {
        await new Promise(r => setTimeout(r, delay))
        const run = await apiFetch(`/api/sync/status/${log_id}`)
        if (run.status === 'running') {
          delay = Math.min(delay * 1.5, 5000)
          continue
        }
        if (run.status === 'success') {
          setStatus(`Sync complete — ${run.records_synced ?? 0} assets updated`)
          window.location.reload()
        } else {
          setStatus(`Sync failed: ${run.error_detail ?? 'unknown error'}`)
          setSyncing(false)
        }
        break
      }
    } catch (e) {
      setStatus(e.message)
      setSyncing(false)
    }
  }

  // Slot key for a given source_field_id (used to badge fields that are mapped to a slot)
  const fieldToSlot = Object.fromEntries(
    Object.entries(assignments).map(([slot, fid]) => [fid, slot])
  )

  // Sort: non-suppressed first (alphabetical), then suppressed (alphabetical)
  const sortedMappings = [...mappings].sort((a, b) => {
    const aSup = buckets[a.source_field_id]?.ingest_suppressed ?? false
    const bSup = buckets[b.source_field_id]?.ingest_suppressed ?? false
    if (aSup !== bSup) return aSup ? 1 : -1
    return a.source_field_name.localeCompare(b.source_field_name)
  })

  const busy = loading || saving || syncing

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-foreground text-base font-semibold">Field Mapping</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        {/* Navigation shortcuts */}
        <div className="flex gap-2 px-6 py-3 border-b border-border shrink-0">
          {SETTINGS_NAV.map(({ label, to }) => (
            <button
              key={to}
              onClick={() => { onClose(); navigate(to) }}
              className="px-3 py-1.5 rounded-md bg-surface-2 text-foreground text-xs font-medium hover:bg-surface-3 transition-colors cursor-pointer"
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto px-6 py-4">
          {loading && <p className="text-muted text-sm">Loading…</p>}
          {error   && <p className="text-error text-sm">{error}</p>}

          {!loading && !error && mappings.length === 0 && (
            <p className="text-muted text-sm">
              No source fields found — run a sync first to populate the mapping table.
            </p>
          )}

          {!loading && !error && driftEvents.length > 0 && (
            <div className="flex items-start gap-3 bg-surface-2 border border-border rounded-lg px-4 py-3 mb-5">
              <span className="text-error text-sm shrink-0 mt-px">!</span>
              <div>
                <p className="text-foreground text-sm font-medium mb-1">
                  {driftEvents.length} field{driftEvents.length !== 1 ? 's' : ''} changed since last review
                </p>
                <ul className="text-muted text-xs space-y-0.5">
                  {driftEvents.map((e, i) => (
                    <li key={i}>
                      <span className="text-foreground">{e.field_name}</span>
                      {e.signal === 'field_added'        && ` — new field (${e.new_type})`}
                      {e.signal === 'field_removed'      && ' — removed from source'}
                      {e.signal === 'field_type_changed' && ` — type changed (${e.old_type} → ${e.new_type})`}
                    </li>
                  ))}
                </ul>
                <p className="text-muted text-xs mt-1.5">Review classification below, then save to dismiss.</p>
              </div>
            </div>
          )}

          {!loading && !error && mappings.length > 0 && (
            <>
              {/* ── Slot assignments ── */}
              <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">Slot assignments</p>
              <table className="w-full text-sm border-collapse mb-8">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-muted font-normal pb-2 w-1/2">ArtHound slot</th>
                    <th className="text-left text-muted font-normal pb-2 w-1/2">Source field</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map(s => (
                    <tr key={s.slot} className="border-b border-border/50">
                      <td className="py-2 pr-4 text-foreground">{s.label}</td>
                      <td className="py-2">
                        <select
                          value={assignments[s.slot] ?? ''}
                          onChange={e => setSlotAssignment(s.slot, e.target.value)}
                          className="w-full bg-surface-2 border border-border rounded-md px-2 py-1.5 text-foreground text-sm outline-none focus:border-accent"
                        >
                          <option value="">— unmapped —</option>
                          {mappings.map(m => (
                            <option key={m.source_field_id} value={m.source_field_id}>
                              {m.source_field_name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* ── Field classification ── */}
              <p className="text-muted text-xs font-medium uppercase tracking-wide mb-3">Field classification</p>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-muted font-normal pb-2">Field</th>
                    <th className="text-left text-muted font-normal pb-2 w-36">Bucket</th>
                    <th className="text-center text-muted font-normal pb-2 w-12">Skip</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedMappings.map(m => {
                    const b          = buckets[m.source_field_id] || {}
                    const suppressed = b.ingest_suppressed ?? false
                    const slotKey    = fieldToSlot[m.source_field_id]
                    return (
                      <tr
                        key={m.source_field_id}
                        className={`border-b border-border/50 transition-opacity ${suppressed ? 'opacity-40' : ''}`}
                      >
                        <td className="py-2 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="text-foreground">{m.source_field_name}</span>
                            {slotKey && (
                              <span className="text-accent text-xs">→ {slotKey}</span>
                            )}
                          </div>
                          {m.source_field_type && (
                            <span className="text-muted text-xs">{m.source_field_type}</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <select
                            value={b.meta_bucket ?? 'custom'}
                            onChange={e => setBucketForField(m.source_field_id, e.target.value)}
                            disabled={suppressed}
                            className="w-full bg-surface-2 border border-border rounded-md px-2 py-1 text-foreground text-xs outline-none focus:border-accent disabled:opacity-40 cursor-pointer disabled:cursor-default"
                          >
                            {BUCKETS.map(bkt => (
                              <option key={bkt.value} value={bkt.value}>{bkt.label}</option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 text-center">
                          <input
                            type="checkbox"
                            checked={suppressed}
                            onChange={e => setSuppressed(m.source_field_id, e.target.checked)}
                            className="accent-accent cursor-pointer"
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-border shrink-0">
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={busy || mappings.length === 0}
              className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save mapping'}
            </button>
            <button
              onClick={resync}
              disabled={busy}
              className="px-3 py-1.5 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface-3 transition-colors cursor-pointer disabled:opacity-40"
            >
              {syncing ? 'Syncing…' : 'Re-sync'}
            </button>
          </div>

          <p className="text-muted text-xs truncate">
            {status ?? (updatedAt ? `Last saved: ${new Date(updatedAt).toLocaleString()}` : '')}
          </p>
        </div>
      </div>
    </div>
  )
}
