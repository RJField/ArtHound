import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { Modal, Button, Spinner, SectionLabel } from './ui'

const BUILTIN_FIELDS = [
  { key: 'name',        label: 'Name' },
  { key: 'devName',     label: 'Dev Name' },
  { key: 'itemType',    label: 'Item Type' },
  { key: 'product',     label: 'Product' },
  { key: 'team',        label: 'Team' },
  { key: 'priority',    label: 'Priority' },
  { key: 'projectDate', label: 'Project Date' },
  { key: 'assetNumber', label: 'Asset #' },
]

const DEFAULT_BUILTINS = BUILTIN_FIELDS.map(f => f.key)

const STORAGE_KEY = 'arthound:assetDetailFields'

const BUILTIN_AIRTABLE_NAMES = new Set([
  'Name', 'Dev Name', 'ID', 'Product', 'Item Type',
  'Team (from Product)', 'Priority', 'Milestone 4 [Dates]',
])

function loadFieldSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* corrupted settings — fall through to defaults */
  }
  return null
}

function saveFieldSettings(settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export default function FieldSettingsModal({ assets, onClose, onSaved }) {
  const existing = loadFieldSettings() || { builtins: [...DEFAULT_BUILTINS], extras: [] }
  const [builtins, setBuiltins] = useState(new Set(existing.builtins))
  const [extras, setExtras]     = useState(new Set(existing.extras))
  const [addFields, setAddFields] = useState(null) // additional field list

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/assets/fields', { signal: controller.signal })
      .then(fields => setAddFields(fields.filter(f => !BUILTIN_AIRTABLE_NAMES.has(f.name))))
      .catch(e => {
        if (e.name === 'AbortError') return
        const names = new Set()
        assets.forEach(a => Object.keys(a.rawFields || {}).forEach(k => names.add(k)))
        setAddFields([...names]
          .filter(n => !BUILTIN_AIRTABLE_NAMES.has(n))
          .sort()
          .map(name => ({ name })))
      })
    return () => controller.abort()
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
    <Modal
      title="Detail Fields"
      onClose={onClose}
      width="max-w-sm"
      className="max-h-[80vh]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" onClick={save}>Save</Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <SectionLabel>Default Fields</SectionLabel>
          {BUILTIN_FIELDS.map(f => (
            <label key={f.key} className="flex items-center gap-2 cursor-pointer border-b border-border-soft pb-2 last:border-b-0 last:pb-0">
              <input type="checkbox" checked={builtins.has(f.key)} onChange={() => toggleBuiltin(f.key)} className="accent-accent" />
              <span className="text-foreground text-sm">{f.label}</span>
            </label>
          ))}
        </section>

        {addFields === null && (
          <div className="flex items-center gap-2 text-faint text-xs">
            <Spinner size={14} /> Loading fields…
          </div>
        )}

        {addFields?.length > 0 && (
          <section className="flex flex-col gap-2">
            <SectionLabel>Additional Airtable Fields</SectionLabel>
            {addFields.map(f => (
              <label key={f.name} className="flex items-center gap-2 cursor-pointer border-b border-border-soft pb-2 last:border-b-0 last:pb-0">
                <input type="checkbox" checked={extras.has(f.name)} onChange={() => toggleExtra(f.name)} className="accent-accent" />
                <span className="text-foreground text-sm">{f.name}</span>
              </label>
            ))}
          </section>
        )}

        {addFields?.length === 0 && (
          <p className="text-faint text-xs">No additional fields found.</p>
        )}
      </div>
    </Modal>
  )
}
