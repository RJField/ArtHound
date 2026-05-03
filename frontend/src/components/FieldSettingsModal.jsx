import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

export const BUILTIN_FIELDS = [
  { key: 'name',        label: 'Name' },
  { key: 'devName',     label: 'Dev Name' },
  { key: 'itemType',    label: 'Item Type' },
  { key: 'product',     label: 'Product' },
  { key: 'team',        label: 'Team' },
  { key: 'priority',    label: 'Priority' },
  { key: 'projectDate', label: 'Project Date' },
  { key: 'assetNumber', label: 'Asset #' },
]

export const DEFAULT_BUILTINS = BUILTIN_FIELDS.map(f => f.key)

const STORAGE_KEY = 'arthound:assetDetailFields'

const BUILTIN_AIRTABLE_NAMES = new Set([
  'Name', 'Dev Name', 'ID', 'Product', 'Item Type',
  'Team (from Product)', 'Priority', 'Milestone 4 [Dates]',
])

export function loadFieldSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch (_) {}
  return null
}

export function saveFieldSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export default function FieldSettingsModal({ assets, onClose, onSaved }) {
  const existing = loadFieldSettings() || { builtins: [...DEFAULT_BUILTINS], extras: [] }
  const [builtins, setBuiltins] = useState(new Set(existing.builtins))
  const [extras, setExtras]     = useState(new Set(existing.extras))
  const [addFields, setAddFields] = useState(null) // additional field list

  useEffect(() => {
    apiFetch('/api/assets/fields')
      .then(fields => setAddFields(fields.filter(f => !BUILTIN_AIRTABLE_NAMES.has(f.name))))
      .catch(() => {
        // Fall back to keys found in current asset rawFields
        const names = new Set()
        assets.forEach(a => Object.keys(a.rawFields || {}).forEach(k => names.add(k)))
        setAddFields([...names]
          .filter(n => !BUILTIN_AIRTABLE_NAMES.has(n))
          .sort()
          .map(name => ({ name })))
      })
  }, [])

  function save() {
    saveFieldSettings({ builtins: [...builtins], extras: [...extras] })
    onSaved()
    onClose()
  }

  function toggleBuiltin(key) {
    setBuiltins(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function toggleExtra(name) {
    setExtras(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-sm max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-foreground text-base font-semibold">Detail Fields</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <p className="text-muted text-xs font-medium uppercase tracking-wide">Default Fields</p>
            {BUILTIN_FIELDS.map(f => (
              <label key={f.key} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={builtins.has(f.key)} onChange={() => toggleBuiltin(f.key)} className="accent-accent" />
                <span className="text-foreground text-sm">{f.label}</span>
              </label>
            ))}
          </section>

          {addFields === null && <p className="text-muted text-xs">Loading fields…</p>}

          {addFields?.length > 0 && (
            <section className="flex flex-col gap-2">
              <p className="text-muted text-xs font-medium uppercase tracking-wide">Additional Airtable Fields</p>
              {addFields.map(f => (
                <label key={f.name} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={extras.has(f.name)} onChange={() => toggleExtra(f.name)} className="accent-accent" />
                  <span className="text-foreground text-sm">{f.name}</span>
                </label>
              ))}
            </section>
          )}

          {addFields?.length === 0 && (
            <p className="text-muted text-xs">No additional fields found.</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer">Cancel</button>
          <button onClick={save}    className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer">Save</button>
        </div>
      </div>
    </div>
  )
}
