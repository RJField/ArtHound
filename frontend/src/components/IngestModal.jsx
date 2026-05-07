import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

export default function IngestModal({ dispatchId, onClose, onIngested }) {
  const [schema, setSchema]       = useState(null)
  const [loadError, setLoadError] = useState(null)

  const [fieldMappings, setFieldMappings] = useState({})
  const [metaTarget, setMetaTarget]       = useState('')
  const [metaFields, setMetaFields]       = useState(new Set())

  const [saved, setSaved]         = useState(false)
  const [saving, setSaving]       = useState(false)
  const [ingesting, setIngesting] = useState(false)

  useEffect(() => {
    apiFetch(`/api/payloads/${encodeURIComponent(dispatchId)}/ingest-schema`)
      .then(data => {
        setSchema(data)
        if (data.existing_mapping) {
          const m = data.existing_mapping
          if (m.mappings && Object.keys(m.mappings).length > 0) {
            const { _meta_summary_target, _meta_summary_fields, ...direct } = m.mappings
            setFieldMappings(direct)
            if (_meta_summary_target) setMetaTarget(_meta_summary_target)
            if (Array.isArray(_meta_summary_fields)) setMetaFields(new Set(_meta_summary_fields))
            setSaved(true)
          }
        }
      })
      .catch(err => setLoadError(err.message))
  }, [dispatchId])

  const isJira     = schema?.source_type === 'jira'
  const isIngested = !!schema?.existing_mapping?.ingested_at
  const autoTarget = schema?.auto_target

  const selectedTable = schema?.source_schema?.find(t => t.id === autoTarget?.table_id)
  const sourceFields  = selectedTable?.fields ?? []

  function markDirty() { setSaved(false) }

  function updateMapping(key, value) {
    setFieldMappings(prev => ({ ...prev, [key]: value }))
    markDirty()
  }

  function toggleMetaField(key) {
    setMetaFields(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
    markDirty()
  }

  async function handleSave() {
    if (metaFields.size > 0 && !metaTarget) {
      toast.error('Select a meta summary field before saving')
      return
    }
    setSaving(true)
    try {
      const cleanDirect = Object.fromEntries(
        Object.entries(fieldMappings).filter(([, v]) => !!v)
      )
      const mappings = {
        ...cleanDirect,
        ...(metaTarget          ? { _meta_summary_target: metaTarget }      : {}),
        ...(metaFields.size > 0 ? { _meta_summary_fields: [...metaFields] } : {}),
      }
      await apiFetch(`/api/payloads/${encodeURIComponent(dispatchId)}/mapping`, {
        method: 'POST',
        body: JSON.stringify({ mappings }),
      })
      setSaved(true)
      toast.success('Mapping saved')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function handleIngest() {
    if (!saved) { toast.error('Save your mapping first'); return }
    setIngesting(true)
    try {
      const result = await apiFetch(`/api/payloads/${encodeURIComponent(dispatchId)}/ingest`, {
        method: 'POST',
      })
      toast.success(`Ingested — record ${result.source_record_id}`)
      onIngested?.(dispatchId, result.source_record_id)
      onClose()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setIngesting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 shrink-0">
          <div>
            <h2 className="text-foreground font-semibold text-sm">Map fields</h2>
            {schema?.source_type && (
              <p className="text-muted text-xs mt-0.5">
                {`Map payload fields to ${isJira ? 'Jira' : 'Airtable'} fields`}
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 pb-2">
          {!schema && !loadError && <p className="text-muted text-sm py-4">Loading schema…</p>}
          {loadError && <p className="text-error text-sm py-4">{loadError}</p>}

          {schema && isIngested && (
            <div className="mt-2 mb-4 px-3 py-2.5 rounded-lg bg-surface-2 border border-border text-xs text-muted">
              Already ingested as <span className="font-mono text-foreground">{schema.existing_mapping.ingested_source_record_id}</span>
            </div>
          )}

          {schema && (
            <div className="flex flex-col gap-0 py-2">
              {/* Resolved target label */}
              {autoTarget && (
                <div className="flex items-center gap-2 mb-3 px-1 text-xs text-muted">
                  <span>Creating in</span>
                  <span className="font-medium text-foreground">{autoTarget.table_name}</span>
                  {autoTarget.issue_type && (
                    <><span>/</span><span className="font-medium text-foreground">{autoTarget.issue_type}</span></>
                  )}
                </div>
              )}

              {/* Meta summary target picker */}
              <div className="flex items-center gap-3 mb-4 pb-3 border-b border-border">
                <span className="text-xs text-muted font-medium whitespace-nowrap shrink-0">Meta summary →</span>
                <select
                  value={metaTarget}
                  onChange={e => { setMetaTarget(e.target.value); markDirty() }}
                  disabled={isIngested}
                  className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                >
                  <option value="">— none —</option>
                  {sourceFields.map(sf => (
                    <option key={sf.id} value={sf.id}>{sf.name}</option>
                  ))}
                </select>
              </div>

              {/* Column headers */}
              <div className="grid items-center gap-3 px-1 mb-1" style={{ gridTemplateColumns: '1fr 1fr auto' }}>
                <span className="text-xs text-muted font-medium">Payload field</span>
                <span className="text-xs text-muted font-medium">{isJira ? 'Jira field' : 'Airtable field'}</span>
                <span className="text-xs text-muted font-medium text-center">Meta</span>
              </div>

              {schema.payload_fields.map(pf => {
                const preview = _previewValue(pf.value)
                const inMeta  = metaFields.has(pf.key)
                return (
                  <div
                    key={pf.key}
                    className="grid items-center gap-3 py-2 border-b border-border/50 last:border-0"
                    style={{ gridTemplateColumns: '1fr 1fr auto' }}
                  >
                    <div className="min-w-0">
                      <p className="text-foreground text-xs font-medium truncate">{pf.label}</p>
                      {preview && <p className="text-muted text-xs truncate mt-0.5">{preview}</p>}
                    </div>
                    <select
                      value={fieldMappings[pf.key] ?? ''}
                      onChange={e => updateMapping(pf.key, e.target.value)}
                      disabled={isIngested}
                      className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
                    >
                      <option value="">— skip —</option>
                      {sourceFields.map(sf => (
                        <option key={sf.id} value={sf.id}>{sf.name}</option>
                      ))}
                    </select>
                    <div className="flex justify-center">
                      <input
                        type="checkbox"
                        checked={inMeta}
                        onChange={() => toggleMetaField(pf.key)}
                        disabled={isIngested}
                        title="Include in meta summary"
                        className="w-3.5 h-3.5 accent-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                      />
                    </div>
                  </div>
                )
              })}

              {schema.payload_fields.length === 0 && (
                <p className="text-muted text-sm py-4">No fields in this payload.</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {schema && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border shrink-0">
            <button
              onClick={handleSave}
              disabled={saving || isIngested}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                saving || isIngested
                  ? 'bg-surface-2 text-muted cursor-not-allowed'
                  : 'bg-surface-2 text-foreground hover:bg-surface-3 cursor-pointer'
              )}
            >
              {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Mapping'}
            </button>
            <button
              onClick={handleIngest}
              disabled={!saved || ingesting || isIngested}
              className={cn(
                'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                (!saved || ingesting || isIngested)
                  ? 'bg-surface-2 text-muted cursor-not-allowed'
                  : 'bg-accent text-white hover:bg-accent-hover cursor-pointer'
              )}
            >
              {isIngested ? 'Ingested' : ingesting ? 'Ingesting…' : 'Ingest'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function _previewValue(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.slice(0, 80)
  if (Array.isArray(v)) return `${v.length} item${v.length !== 1 ? 's' : ''}`
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
  return String(v)
}
