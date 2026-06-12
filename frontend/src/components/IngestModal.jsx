import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { Inbox } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { Modal, Button, Select, Pill, Spinner, SectionLabel, EmptyState } from './ui'

// ── Drift resolution step ─────────────────────────────────────────────────────
// Shown when the saved template doesn't match the current dispatch's field set.
// Vendor resolves each new field (map / skip / add to meta) and confirms
// removed fields (auto-cleaned from template unless explicitly kept).

function DriftStep({ drift, payloadFields, sourceFields, onResolve }) {
  const fieldByKey = Object.fromEntries(payloadFields.map(f => [f.key, f]))

  // new fields: start as skip (''). Vendor can set a source field ID or 'meta'
  const [newResolutions, setNewResolutions] = useState(
    () => Object.fromEntries(drift.new_fields.map(k => [k, '']))
  )
  // removed fields: default to remove (false = remove, true = keep)
  const [keepRemoved, setKeepRemoved] = useState(
    () => Object.fromEntries(drift.removed_fields.map(k => [k, false]))
  )

  function setNew(key, value) {
    setNewResolutions(prev => ({ ...prev, [key]: value }))
  }

  function toggleKeep(key) {
    setKeepRemoved(prev => ({ ...prev, [key]: !prev[key] }))
  }

  function confirm() {
    onResolve({ newResolutions, keepRemoved })
  }

  const hasChanges = drift.new_fields.length > 0 || drift.removed_fields.length > 0

  return (
    <div className="flex flex-col gap-5 py-2">
      <div className="px-3 py-2.5 rounded-lg bg-warning-tint border border-warning/25 text-xs text-warning">
        Your saved mapping template doesn't match this payload. Resolve the differences before ingesting.
      </div>

      {/* New fields */}
      {drift.new_fields.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-foreground">
            New fields ({drift.new_fields.length}) — not in your saved template
          </p>
          <div className="flex flex-col gap-0">
            <div className="grid gap-3 px-1 mb-1" style={{ gridTemplateColumns: '1fr 1fr auto' }}>
              <SectionLabel>Field</SectionLabel>
              <SectionLabel>Map to source field</SectionLabel>
              <SectionLabel className="text-center">Meta</SectionLabel>
            </div>
            {drift.new_fields.map(key => {
              const pf      = fieldByKey[key]
              const preview = pf ? _previewValue(pf.value) : null
              const inMeta  = newResolutions[key] === 'meta'
              return (
                <div
                  key={key}
                  className="grid items-center gap-3 py-2 border-b border-border-faint last:border-0"
                  style={{ gridTemplateColumns: '1fr 1fr auto' }}
                >
                  <div className="min-w-0">
                    <p className="text-foreground text-xs font-medium truncate">{pf?.label ?? key}</p>
                    {preview && <p className="text-muted text-xs truncate mt-0.5">{preview}</p>}
                  </div>
                  <Select
                    value={inMeta ? '' : (newResolutions[key] ?? '')}
                    onChange={e => setNew(key, e.target.value)}
                    disabled={inMeta}
                    className="w-full"
                  >
                    <option value="">— skip —</option>
                    {sourceFields.map(sf => (
                      <option key={sf.id} value={sf.id}>{sf.name}</option>
                    ))}
                  </Select>
                  <div className="flex justify-center">
                    <input
                      type="checkbox"
                      checked={inMeta}
                      onChange={() => setNew(key, inMeta ? '' : 'meta')}
                      title="Add to meta summary"
                      className="w-3.5 h-3.5 accent-accent cursor-pointer"
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Removed fields */}
      {drift.removed_fields.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-foreground">
            Removed fields ({drift.removed_fields.length}) — in your template but not in this payload
          </p>
          <div className="flex flex-col gap-1">
            {drift.removed_fields.map(key => (
              <div
                key={key}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-2 border border-border"
              >
                <span className="text-muted text-xs font-mono">{key}</span>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={keepRemoved[key]}
                    onChange={() => toggleKeep(key)}
                    className="w-3.5 h-3.5 accent-accent cursor-pointer"
                  />
                  <span className="text-muted text-xs">Keep in template</span>
                </label>
              </div>
            ))}
          </div>
          <p className="text-faint text-xs">Unchecked fields will be removed from your template when you save.</p>
        </div>
      )}

      {!hasChanges && (
        <p className="text-muted text-sm">No changes to resolve.</p>
      )}

      <div className="flex justify-end">
        <Button variant="primary" size="lg" onClick={confirm}>
          Continue to mapping
        </Button>
      </div>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function IngestModal({ dispatchId, onClose, onIngested }) {
  const [schema, setSchema]       = useState(null)
  const [loadError, setLoadError] = useState(null)

  // 'drift' | 'mapping'
  const [step, setStep] = useState('mapping')

  const [fieldMappings, setFieldMappings] = useState({})
  const [metaTarget, setMetaTarget]       = useState('')
  const [metaFields, setMetaFields]       = useState(new Set())

  const [saved, setSaved]         = useState(false)
  const [saving, setSaving]       = useState(false)
  const [ingesting, setIngesting] = useState(false)
  const [retrying, setRetrying]   = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch(`/api/payloads/${encodeURIComponent(dispatchId)}/ingest-schema`, { signal: controller.signal })
      .then(data => {
        setSchema(data)

        // Priority: existing per-dispatch mapping > template > blank
        const source = data.existing_mapping?.mappings
          ? data.existing_mapping
          : data.default_template
            ? { mappings: data.default_template.field_mappings, ...data.default_template }
            : null

        if (source?.mappings && Object.keys(source.mappings).length > 0) {
          const { _meta_summary_target, _meta_summary_fields, ...direct } = source.mappings
          setFieldMappings(direct)
          if (_meta_summary_target) setMetaTarget(_meta_summary_target)
          if (Array.isArray(_meta_summary_fields)) setMetaFields(new Set(_meta_summary_fields))
          // Only mark as saved if this came from an existing per-dispatch mapping
          if (data.existing_mapping?.mappings) setSaved(true)
        }

        // Show drift resolution step if template was used and drift exists
        const hasDrift = data.drift && (
          data.drift.new_fields?.length > 0 ||
          data.drift.removed_fields?.length > 0
        )
        if (!data.existing_mapping && data.default_template && hasDrift) {
          setStep('drift')
        }
      })
      .catch(err => { if (err.name !== 'AbortError') setLoadError(err.message) })
    return () => controller.abort()
  }, [dispatchId])

  const isJira     = schema?.source_type === 'jira'
  const isIngested = !!schema?.existing_mapping?.ingested_at
  const isFailed   = !isIngested && !!schema?.existing_mapping?.failed_at
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

  function applyDriftResolutions({ newResolutions, keepRemoved }) {
    setFieldMappings(prev => {
      const next = { ...prev }

      // Apply new field resolutions
      for (const [key, value] of Object.entries(newResolutions)) {
        if (value && value !== 'meta') {
          next[key] = value
        } else {
          delete next[key]
        }
      }

      // Remove stale keys the vendor chose not to keep
      for (const [key, keep] of Object.entries(keepRemoved)) {
        if (!keep) delete next[key]
      }

      return next
    })

    // Add new meta fields
    const newMetaKeys = Object.entries(newResolutions)
      .filter(([, v]) => v === 'meta')
      .map(([k]) => k)
    if (newMetaKeys.length > 0) {
      setMetaFields(prev => {
        const next = new Set(prev)
        newMetaKeys.forEach(k => next.add(k))
        return next
      })
    }

    setSaved(false)
    setStep('mapping')
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

  async function saveTemplate(mappings) {
    const { sender_studio_id, active_link_id } = schema
    if (!sender_studio_id || !active_link_id) return
    try {
      await apiFetch(`/api/handshake/template/${encodeURIComponent(sender_studio_id)}`, {
        method: 'PUT',
        body: JSON.stringify({ link_id: active_link_id, field_mappings: mappings }),
      })
    } catch {
      // Non-fatal — don't surface this as an error to the vendor
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

      // Persist the mappings as the default template for this studio
      const cleanDirect = Object.fromEntries(
        Object.entries(fieldMappings).filter(([, v]) => !!v)
      )
      const mappings = {
        ...cleanDirect,
        ...(metaTarget          ? { _meta_summary_target: metaTarget }      : {}),
        ...(metaFields.size > 0 ? { _meta_summary_fields: [...metaFields] } : {}),
      }
      await saveTemplate(mappings)

      onIngested?.(dispatchId, result.source_record_id)
      onClose()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setIngesting(false)
    }
  }

  async function handleRetry() {
    setRetrying(true)
    try {
      const result = await apiFetch(`/api/payloads/${encodeURIComponent(dispatchId)}/retry-canonical`, {
        method: 'POST',
      })
      toast.success(`Link recovered — record ${result.source_record_id}`)
      onIngested?.(dispatchId, result.source_record_id)
      onClose()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRetrying(false)
    }
  }

  const title = step === 'drift' ? 'Resolve mapping changes' : 'Map fields'
  const subtitle = step === 'drift'
    ? 'Your template needs updating before this dispatch can be ingested'
    : schema?.source_type
      ? `Map payload fields to ${isJira ? 'Jira' : 'Airtable'} fields`
      : null

  const footer = schema && step === 'mapping' ? (
    isFailed ? (
      <Button variant="danger" size="lg" onClick={handleRetry} disabled={retrying}>
        {retrying ? 'Retrying…' : 'Retry Link'}
      </Button>
    ) : (
      <>
        <Button size="lg" onClick={handleSave} disabled={saving || isIngested}>
          {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Mapping'}
        </Button>
        <Button variant="primary" size="lg" onClick={handleIngest} disabled={!saved || ingesting || isIngested}>
          {isIngested ? 'Ingested' : ingesting ? 'Ingesting…' : 'Ingest'}
        </Button>
      </>
    )
  ) : undefined

  return (
    <Modal
      title={
        <span className="flex flex-col min-w-0">
          <span className="truncate">{title}</span>
          {subtitle && <span className="text-xs text-muted font-normal truncate">{subtitle}</span>}
        </span>
      }
      onClose={onClose}
      width="max-w-2xl"
      footer={footer}
    >
      {!schema && !loadError && (
        <div className="flex items-center gap-2 py-4 text-muted text-sm">
          <Spinner size={14} /> Loading schema…
        </div>
      )}
      {loadError && <p className="text-error text-sm py-4">{loadError}</p>}

      {/* Drift resolution step */}
      {schema && step === 'drift' && (
        <DriftStep
          drift={schema.drift}
          payloadFields={schema.payload_fields}
          sourceFields={sourceFields}
          onResolve={applyDriftResolutions}
        />
      )}

      {/* Mapping step */}
      {schema && step === 'mapping' && (
        <div className="flex flex-col gap-0 py-2">
          {isIngested && (
            <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-surface-2 border border-border text-xs text-muted">
              <Pill tone="success">Ingested</Pill>
              <span>
                Already ingested as{' '}
                <span className="font-mono text-foreground">
                  {schema.existing_mapping.ingested_source_record_id}
                </span>
              </span>
            </div>
          )}

          {isFailed && (
            <div className="mb-4 px-3 py-2.5 rounded-lg bg-error-tint border border-error/25 text-xs text-error flex flex-col gap-1">
              <span className="font-medium">Canonical link failed after ingest</span>
              <span className="text-error/70">{schema.existing_mapping.failure_reason}</span>
              <span className="text-error/70 mt-0.5">The record was created in your source tool. Use Retry Link to re-establish the ArtHound connection without creating a duplicate.</span>
            </div>
          )}

          {schema.default_template && !schema.existing_mapping && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-accent-tint border border-accent/25 text-xs text-muted">
              Pre-filled from your saved template for this studio.
            </div>
          )}

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
            <Select
              value={metaTarget}
              onChange={e => { setMetaTarget(e.target.value); markDirty() }}
              disabled={isIngested}
              className="flex-1"
            >
              <option value="">— none —</option>
              {sourceFields.map(sf => (
                <option key={sf.id} value={sf.id}>{sf.name}</option>
              ))}
            </Select>
          </div>

          {/* Column headers */}
          <div className="grid items-center gap-3 px-1 mb-1" style={{ gridTemplateColumns: '1fr 1fr auto' }}>
            <SectionLabel>Payload field</SectionLabel>
            <SectionLabel>{isJira ? 'Jira field' : 'Airtable field'}</SectionLabel>
            <SectionLabel className="text-center">Meta</SectionLabel>
          </div>

          {schema.payload_fields.map(pf => {
            const preview = _previewValue(pf.value)
            const inMeta  = metaFields.has(pf.key)
            return (
              <div
                key={pf.key}
                className="grid items-center gap-3 py-2 border-b border-border-faint last:border-0"
                style={{ gridTemplateColumns: '1fr 1fr auto' }}
              >
                <div className="min-w-0">
                  <p className="text-foreground text-xs font-medium truncate">{pf.label}</p>
                  {preview && <p className="text-muted text-xs truncate mt-0.5">{preview}</p>}
                </div>
                <Select
                  value={fieldMappings[pf.key] ?? ''}
                  onChange={e => updateMapping(pf.key, e.target.value)}
                  disabled={isIngested}
                  className="w-full"
                >
                  <option value="">— skip —</option>
                  {sourceFields.map(sf => (
                    <option key={sf.id} value={sf.id}>{sf.name}</option>
                  ))}
                </Select>
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
            <EmptyState icon={Inbox} title="No fields in this payload." />
          )}
        </div>
      )}
    </Modal>
  )
}

function _previewValue(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.slice(0, 80)
  if (Array.isArray(v)) return `${v.length} item${v.length !== 1 ? 's' : ''}`
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80)
  return String(v)
}
