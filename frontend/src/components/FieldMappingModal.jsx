import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../lib/api'

const SETTINGS_NAV = [
  { label: 'Estimates', to: '/estimates' },
  { label: 'Workflows', to: '/workflows' },
]

export default function FieldMappingModal({ onClose }) {
  const navigate = useNavigate()
  const [sourceType, setSourceType] = useState('airtable')
  const [mappings, setMappings]   = useState([])
  const [slots, setSlots]         = useState([])
  const [updatedAt, setUpdatedAt] = useState(null)
  const [assignments, setAssignments] = useState({}) // slot → source_field_id
  const [status, setStatus]       = useState(null)
  const [loading, setLoading]     = useState(true)
  const [saving, setSaving]       = useState(false)
  const [syncing, setSyncing]     = useState(false)
  const [error, setError]         = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await apiFetch('/api/sync/field-mapping')
      setSourceType(data.source_type ?? 'airtable')
      setMappings(data.mappings)
      setSlots(data.slots)
      setUpdatedAt(data.updated_at)
      const a = {}
      for (const m of data.mappings) {
        if (m.arthound_slot) a[m.arthound_slot] = m.source_field_id
      }
      setAssignments(a)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    setSaving(true)
    setStatus(null)
    try {
      // Reverse the slot→field map: for each source field, find which slot it's assigned to
      const updated = mappings.map(m => {
        const slot = Object.entries(assignments).find(([, fid]) => fid === m.source_field_id)?.[0] ?? null
        return { source_field_id: m.source_field_id, source_field_name: m.source_field_name, arthound_slot: slot }
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
    setStatus(null)
    try {
      await apiFetch('/api/sync/run', {
        method: 'POST',
        body: JSON.stringify({ source_type: sourceType, full: true }),
      })
      setTimeout(() => window.location.reload(), 4000)
    } catch (e) {
      setStatus(e.message)
      setSyncing(false)
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

  const busy = loading || saving || syncing

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col">

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

          {!loading && !error && mappings.length > 0 && (
            <table className="w-full text-sm border-collapse">
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
