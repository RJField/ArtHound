import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'

// Props:
//   template: existing template row to edit, or null to create
//   onClose: fn()
//   onSaved: fn(savedTemplate)

export default function PayloadTemplateModal({ template, onClose, onSaved }) {
  const isEdit = !!template

  const [name, setName]             = useState(template?.name ?? '')
  const [availableFields, setAvailableFields] = useState([])   // [{key, label, sample}]
  const [selectedKeys, setSelectedKeys] = useState(
    () => new Set((template?.field_schema ?? []).map(f => f.key))
  )
  const [loadingFields, setLoadingFields] = useState(true)
  const [saving, setSaving]         = useState(false)

  useEffect(() => {
    apiFetch('/api/payloads/field-preview')
      .then(fields => {
        setAvailableFields(fields)
        // For new templates, pre-select all fields
        if (!isEdit) setSelectedKeys(new Set(fields.map(f => f.key)))
      })
      .catch(err => toast.error(`Could not load fields: ${err.message}`))
      .finally(() => setLoadingFields(false))
  }, [])

  function toggle(key) {
    setSelectedKeys(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function selectAll()   { setSelectedKeys(new Set(availableFields.map(f => f.key))) }
  function selectNone()  { setSelectedKeys(new Set()) }

  async function save(e) {
    e.preventDefault()
    if (!name.trim()) { toast.error('Template name is required'); return }
    if (selectedKeys.size === 0) { toast.error('Select at least one field'); return }

    const field_schema = availableFields
      .filter(f => selectedKeys.has(f.key))
      .map(f => ({ key: f.key, label: f.label, type: 'text' }))

    setSaving(true)
    try {
      let saved
      if (isEdit) {
        await apiFetch(`/api/payloads/templates/${template.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: name.trim(), field_schema }),
        })
        saved = { ...template, name: name.trim(), field_schema }
      } else {
        saved = await apiFetch('/api/payloads/templates', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), field_schema }),
        })
      }
      toast.success(isEdit ? 'Template updated' : 'Template created')
      onSaved(saved)
      onClose()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0 border-b border-border">
          <h2 className="text-foreground text-base font-semibold">
            {isEdit ? 'Edit template' : 'New payload template'}
          </h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        <form onSubmit={save} className="flex flex-col flex-1 min-h-0">
          <div className="px-5 pt-4 flex flex-col gap-4 flex-1 min-h-0 overflow-y-auto">

            {/* Name */}
            <div className="flex flex-col gap-1">
              <label className="text-muted text-xs">Template name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                autoFocus
                placeholder="e.g. Standard brief"
                className="bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent"
              />
            </div>

            {/* Field picker */}
            <div className="flex flex-col gap-2 flex-1 min-h-0">
              <div className="flex items-center justify-between">
                <span className="text-muted text-xs">
                  Fields to include
                  {availableFields.length > 0 && (
                    <span className="ml-1 text-muted/60">
                      ({selectedKeys.size}/{availableFields.length} selected)
                    </span>
                  )}
                </span>
                {availableFields.length > 0 && (
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={selectAll}  className="text-xs text-accent hover:text-accent-hover cursor-pointer">All</button>
                    <button type="button" onClick={selectNone} className="text-xs text-muted hover:text-foreground cursor-pointer">None</button>
                  </div>
                )}
              </div>

              {loadingFields ? (
                <p className="text-muted text-xs">Loading available fields…</p>
              ) : availableFields.length === 0 ? (
                <p className="text-muted text-xs">No asset fields found — sync your source tool first.</p>
              ) : (
                <div className="flex flex-col gap-1 overflow-y-auto max-h-72 border border-border rounded-lg p-2 bg-surface-2">
                  {availableFields.map(field => (
                    <label
                      key={field.key}
                      className="flex items-start gap-3 px-2 py-1.5 rounded-md hover:bg-surface-3 cursor-pointer group"
                    >
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(field.key)}
                        onChange={() => toggle(field.key)}
                        className="mt-0.5 accent-accent shrink-0"
                      />
                      <div className="flex-1 min-w-0">
                        <span className="text-foreground text-xs font-medium">{field.label}</span>
                        {field.sample != null && (
                          <span className="text-muted text-xs ml-2 truncate">e.g. {field.sample}</span>
                        )}
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !name.trim() || selectedKeys.size === 0}
              className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover cursor-pointer disabled:opacity-40"
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
