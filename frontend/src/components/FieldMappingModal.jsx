import { useState, useEffect } from 'react'
import { AlertTriangle, Database } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { Modal, Button, Select, Spinner, EmptyState, SectionLabel, Pill, Table, Th, Tr, Td } from './ui'

const BUCKETS = [
  { value: 'scheduling',    label: 'Scheduling' },
  { value: 'creative',      label: 'Creative' },
  { value: 'tech_specs',    label: 'Tech Specs' },
  { value: 'production',    label: 'Production' },
  { value: 'custom',        label: 'Custom' },
  { value: 'source_native', label: 'Source native' },
]

const BUCKET_TIER = {
  scheduling:    'primary',
  creative:      'secondary',
  tech_specs:    'secondary',
  production:    'primary',
  source_native: 'hidden',
  custom:        'secondary',
}

export default function FieldMappingModal({ onClose, inline = false }) {
  const [sourceType, setSourceType] = useState('airtable')
  const [mappings, setMappings]     = useState([])
  const [slots, setSlots]           = useState([])
  const [updatedAt, setUpdatedAt]   = useState(null)
  const [assignments, setAssignments] = useState({})
  const [buckets, setBuckets]       = useState({})
  const [driftEvents, setDriftEvents] = useState([])
  const [status, setStatus]           = useState(null)
  const [loading, setLoading]         = useState(true)
  const [saving, setSaving]           = useState(false)
  const [syncing, setSyncing]         = useState(false)
  const [error, setError]             = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      apiFetch('/api/sync/field-mapping', { signal: controller.signal }),
      apiFetch('/api/sync/schema-drift').catch(() => ({ events: [] })),
    ])
      .then(([data, drift]) => {
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
      })
      .catch(e => { if (e.name !== 'AbortError') setError(e.message) })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [])

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

  const fieldToSlot = Object.fromEntries(
    Object.entries(assignments).map(([slot, fid]) => [fid, slot])
  )

  const sortedMappings = [...mappings].sort((a, b) => {
    const aSup = buckets[a.source_field_id]?.ingest_suppressed ?? false
    const bSup = buckets[b.source_field_id]?.ingest_suppressed ?? false
    if (aSup !== bSup) return aSup ? 1 : -1
    return a.source_field_name.localeCompare(b.source_field_name)
  })

  const busy = loading || saving || syncing

  const body = (
    <>
      {loading && (
        <div className="flex items-center gap-2 text-muted text-sm">
          <Spinner size={14} /> Loading…
        </div>
      )}
      {error && <p className="text-error text-sm">{error}</p>}

      {!loading && !error && mappings.length === 0 && (
        <EmptyState
          icon={Database}
          title="No source fields found"
          hint="Run a sync first to populate the mapping table."
        />
      )}

      {!loading && !error && driftEvents.length > 0 && (
        <div className="flex items-start gap-3 bg-warning-tint border border-border rounded-lg px-4 py-3 mb-5">
          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
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
            <p className="text-faint text-xs mt-1.5">Review classification below, then save to dismiss.</p>
          </div>
        </div>
      )}

      {!loading && !error && mappings.length > 0 && (
        <>
          {/* ── Slot assignments ── */}
          <SectionLabel className="mb-3">Slot assignments</SectionLabel>
          <Table className="mb-8">
            <thead>
              <tr>
                <Th className="w-1/2">ArtHound slot</Th>
                <Th className="w-1/2">Source field</Th>
              </tr>
            </thead>
            <tbody>
              {slots.map(s => (
                <Tr key={s.slot}>
                  <Td primary className="font-normal text-foreground">{s.label}</Td>
                  <Td className="py-1 overflow-visible">
                    <Select
                      value={assignments[s.slot] ?? ''}
                      onChange={e => setSlotAssignment(s.slot, e.target.value)}
                      className="w-full"
                    >
                      <option value="">— unmapped —</option>
                      {mappings.map(m => (
                        <option key={m.source_field_id} value={m.source_field_id}>
                          {m.source_field_name}
                        </option>
                      ))}
                    </Select>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>

          {/* ── Field classification ── */}
          <SectionLabel className="mb-3">Field classification</SectionLabel>
          <Table>
            <thead>
              <tr>
                <Th>Field</Th>
                <Th className="w-36">Bucket</Th>
                <Th className="w-12 text-center">Skip</Th>
              </tr>
            </thead>
            <tbody>
              {sortedMappings.map(m => {
                const b          = buckets[m.source_field_id] || {}
                const suppressed = b.ingest_suppressed ?? false
                const slotKey    = fieldToSlot[m.source_field_id]
                return (
                  <Tr
                    key={m.source_field_id}
                    className={`transition-opacity ${suppressed ? 'opacity-40' : ''}`}
                  >
                    <Td primary className="h-auto py-1.5 whitespace-normal font-normal text-foreground">
                      <div className="flex items-center gap-2">
                        <span>{m.source_field_name}</span>
                        {slotKey && <Pill tone="accent">→ {slotKey}</Pill>}
                      </div>
                      {m.source_field_type && (
                        <span className="text-faint text-xs font-mono">{m.source_field_type}</span>
                      )}
                    </Td>
                    <Td className="h-auto py-1.5 overflow-visible">
                      <Select
                        value={b.meta_bucket ?? 'custom'}
                        onChange={e => setBucketForField(m.source_field_id, e.target.value)}
                        disabled={suppressed}
                        className="w-full"
                      >
                        {BUCKETS.map(bkt => (
                          <option key={bkt.value} value={bkt.value}>{bkt.label}</option>
                        ))}
                      </Select>
                    </Td>
                    <Td className="h-auto py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={suppressed}
                        onChange={e => setSuppressed(m.source_field_id, e.target.checked)}
                        className="accent-accent cursor-pointer"
                      />
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </>
      )}
    </>
  )

  const footer = (
    <>
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={save}
          disabled={busy || mappings.length === 0}
        >
          {saving ? 'Saving…' : 'Save mapping'}
        </Button>
        <Button onClick={resync} disabled={busy}>
          {syncing ? 'Syncing…' : 'Re-sync'}
        </Button>
      </div>

      <p className="flex-1 min-w-0 text-faint text-xs truncate text-right">
        {status ?? (updatedAt ? `Last saved: ${new Date(updatedAt).toLocaleString()}` : '')}
      </p>
    </>
  )

  if (inline) {
    return (
      <div className="flex flex-col">
        <div className="px-6 py-4">{body}</div>
        <div className="flex items-center gap-2 px-6 py-4 border-t border-border-soft">{footer}</div>
      </div>
    )
  }

  return (
    <Modal title="Field Mapping" onClose={onClose} width="max-w-2xl" footer={footer}>
      {body}
    </Modal>
  )
}
