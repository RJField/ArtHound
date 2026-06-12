import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { ListX } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { Modal, Button, Field, Input, Spinner, SectionLabel, EmptyState } from './ui'

// Props:
//   template: existing template row to edit, or null to create
//   onClose: fn()
//   onSaved: fn(savedTemplate)

const FORM_ID = 'payload-template-form'

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
    const controller = new AbortController()
    apiFetch('/api/payloads/field-preview', { signal: controller.signal })
      .then(fields => {
        setAvailableFields(fields)
        if (!isEdit) setSelectedKeys(new Set(fields.map(f => f.key)))
      })
      .catch(err => { if (err.name !== 'AbortError') toast.error(`Could not load fields: ${err.message}`) })
      .finally(() => setLoadingFields(false))
    return () => controller.abort()
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
    <Modal
      title={isEdit ? 'Edit template' : 'New payload template'}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant="primary"
            size="lg"
            disabled={saving || !name.trim() || selectedKeys.size === 0}
          >
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create template'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={save} className="flex flex-col gap-4">

        {/* Name */}
        <Field label="Template name">
          <Input
            size="lg"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            required
            autoFocus
            placeholder="e.g. Standard brief"
          />
        </Field>

        {/* Field picker */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <SectionLabel>
              Fields to include
              {availableFields.length > 0 && (
                <span className="ml-1 text-faint tabular-nums normal-case">
                  ({selectedKeys.size}/{availableFields.length} selected)
                </span>
              )}
            </SectionLabel>
            {availableFields.length > 0 && (
              <div className="flex items-center gap-3">
                <button type="button" onClick={selectAll}  className="text-xs text-link hover:underline cursor-pointer">All</button>
                <button type="button" onClick={selectNone} className="text-xs text-muted hover:text-foreground cursor-pointer">None</button>
              </div>
            )}
          </div>

          {loadingFields ? (
            <div className="flex items-center gap-2 text-muted text-xs">
              <Spinner size={14} /> Loading available fields…
            </div>
          ) : availableFields.length === 0 ? (
            <EmptyState
              icon={ListX}
              title="No asset fields found"
              hint="Sync your source tool first."
            />
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
      </form>
    </Modal>
  )
}
