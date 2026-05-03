import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

const SOURCE_TYPE = 'airtable'

const REQUIRED_SLOTS = ['name', 'status', 'item_type']
const ALL_SLOTS = [
  { slot: 'name',         label: 'Name',         required: true  },
  { slot: 'dev_name',     label: 'Dev Name',      required: false },
  { slot: 'item_type',    label: 'Item Type',     required: true  },
  { slot: 'priority',     label: 'Priority',      required: false },
  { slot: 'product',      label: 'Product',       required: false },
  { slot: 'project_date', label: 'Project Date',  required: false },
  { slot: 'status',       label: 'Status',        required: true  },
  { slot: 'asset_number', label: 'Asset Number',  required: false },
]

const ENTITIES = [
  { type: 'product',   label: 'Product',    parent: null,      desc: 'Top-level grouping (e.g. Film, Game, Season)' },
  { type: 'asset',     label: 'Asset',      parent: 'product', desc: 'Individual work item (e.g. Character, Prop, Shot)' },
  { type: 'task',      label: 'Task / Work',parent: 'asset',   desc: 'Unit of work attached to an asset' },
  { type: 'item_type', label: 'Item Type',  parent: null,      optional: true, desc: 'Lookup table for asset categories (e.g. Character, Prop, Vehicle). Skip if you use a select field instead.' },
]

const OPERATORS = [
  { value: 'eq',       label: 'equals' },
  { value: 'neq',      label: 'does not equal' },
  { value: 'contains', label: 'contains' },
]


// ── Helpers ───────────────────────────────────────────────────────────────────

function linkFields(fields, parentTableId) {
  return fields.filter(
    f => f.type === 'multipleRecordLinks' && f.options?.linkedTableId === parentTableId
  )
}

function valueInputForField(field, value, onChange) {
  if (!field) return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="value"
      className="flex-1 bg-surface-3 border border-border rounded px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
    />
  )
  const choices = field.options?.choices
  if (choices?.length) {
    return (
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 bg-surface-3 border border-border rounded px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
      >
        <option value="">— choose —</option>
        {choices.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
      </select>
    )
  }
  if (field.type === 'checkbox') {
    return (
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="flex-1 bg-surface-3 border border-border rounded px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
      >
        <option value="true">checked</option>
        <option value="false">unchecked</option>
      </select>
    )
  }
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="value"
      className="flex-1 bg-surface-3 border border-border rounded px-2 py-1 text-sm text-foreground outline-none focus:border-accent"
    />
  )
}


// ── Step indicator ────────────────────────────────────────────────────────────

function StepDots({ current, total, onNavigate }) {
  return (
    <div className="flex gap-2 items-center justify-center mb-8">
      {Array.from({ length: total }, (_, i) => {
        const step = i + 1
        const isPast = step < current
        const isCurrent = step === current
        return (
          <div
            key={i}
            onClick={() => isPast && onNavigate?.(step)}
            className={`rounded-full transition-all ${
              isCurrent
                ? 'w-6 h-2 bg-accent'
                : isPast
                ? 'w-2 h-2 bg-accent/50 cursor-pointer hover:bg-accent/80'
                : 'w-2 h-2 bg-border'
            }`}
          />
        )
      })}
    </div>
  )
}


// ── Step 1: Credentials ───────────────────────────────────────────────────────

function StepCredentials({ onSuccess }) {
  const [apiToken, setApiToken] = useState('')
  const [baseId, setBaseId]     = useState('')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)

  async function submit(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch('/api/init/credentials', {
        method: 'POST',
        body: JSON.stringify({
          source_type: SOURCE_TYPE,
          credentials: { api_token: apiToken.trim(), base_id: baseId.trim() },
        }),
      })
      onSuccess(res)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <p className="text-muted text-sm">
        Connect ArtHound to your Airtable base. Credentials are encrypted at rest
        and never returned to the browser after saving.
      </p>
      <label className="flex flex-col gap-1.5">
        <span className="text-foreground text-sm font-medium">Airtable API token</span>
        <input
          type="password"
          value={apiToken}
          onChange={e => setApiToken(e.target.value)}
          placeholder="pat…"
          required
          className="bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent font-mono"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-foreground text-sm font-medium">Base ID</span>
        <input
          type="text"
          value={baseId}
          onChange={e => setBaseId(e.target.value)}
          placeholder="appXXXXXXXXXXXXXX"
          required
          className="bg-surface-2 border border-border rounded-md px-3 py-2 text-foreground text-sm outline-none focus:border-accent font-mono"
        />
        <span className="text-muted text-xs">Found in your Airtable base URL: airtable.com/<strong>appXXX</strong>/…</span>
      </label>
      {error && <p className="text-error text-sm">{error}</p>}
      <button
        type="submit"
        disabled={loading || !apiToken || !baseId}
        className="mt-2 px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
      >
        {loading ? 'Testing connection…' : 'Test & Save'}
      </button>
    </form>
  )
}


// ── Step 2: Discover schema ───────────────────────────────────────────────────

function StepDiscover({ onSuccess, onBack }) {
  const [loading, setLoading] = useState(true)
  const [tables, setTables]   = useState([])
  const [error, setError]     = useState(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    discover()
  }, [])

  async function discover() {
    setLoading(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/init/discover?source_type=${SOURCE_TYPE}`, { method: 'POST' })
      setTables(res.tables)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const totalFields = tables.reduce((n, t) => n + t.fields.length, 0)

  return (
    <div className="flex flex-col gap-5">
      {loading && (
        <div className="flex flex-col items-center gap-3 py-8">
          <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-muted text-sm">Discovering schema…</p>
        </div>
      )}
      {error && (
        <div className="flex flex-col gap-3">
          <p className="text-error text-sm">{error}</p>
          <button onClick={discover} className="self-start px-3 py-1.5 rounded-md bg-surface-2 text-foreground text-sm hover:bg-surface-3 cursor-pointer">Retry</button>
        </div>
      )}
      {!loading && !error && (
        <>
          <p className="text-muted text-sm">
            Found <strong className="text-foreground">{tables.length} tables</strong> and <strong className="text-foreground">{totalFields} fields</strong> in your base.
          </p>
          <div className="bg-surface-2 rounded-lg border border-border max-h-48 overflow-y-auto">
            {tables.map(t => (
              <div key={t.id} className="flex items-center justify-between px-3 py-2 border-b border-border/50 last:border-0">
                <span className="text-foreground text-sm font-medium">{t.name}</span>
                <span className="text-muted text-xs">{t.fields.length} fields</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
            <button
              onClick={() => onSuccess(tables)}
              className="flex-1 px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer"
            >
              Continue to hierarchy
            </button>
          </div>
        </>
      )}
      {!loading && error && (
        <button onClick={onBack} className="self-start px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
      )}
    </div>
  )
}


// ── Step 3: Define hierarchy ──────────────────────────────────────────────────

function EntityPanel({ entity, tables, definitions, onChange }) {
  const def = definitions[entity.type] || {}
  const parentDef = entity.parent ? definitions[entity.parent] : null
  const parentTableId = parentDef?.table_id || null

  const tableFields = tables.find(t => t.id === def.table_id)?.fields || []
  const validLinkFields = parentTableId ? linkFields(tableFields, parentTableId) : []

  const [preview, setPreview]       = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewErr, setPreviewErr] = useState(null)

  function update(patch) {
    onChange(entity.type, { ...def, ...patch })
  }

  function addFilter() {
    const first = tableFields[0]
    update({
      filters: [...(def.filters || []), {
        field_id: first?.id || '',
        field_name: first?.name || '',
        operator: 'eq',
        value: '',
      }]
    })
  }

  function updateFilter(i, patch) {
    const next = [...(def.filters || [])]
    next[i] = { ...next[i], ...patch }
    update({ filters: next })
  }

  function removeFilter(i) {
    const next = [...(def.filters || [])]
    next.splice(i, 1)
    update({ filters: next })
  }

  async function runPreview() {
    if (!def.table_id) return
    setPreviewing(true)
    setPreviewErr(null)
    try {
      const res = await apiFetch('/api/init/preview-entity', {
        method: 'POST',
        body: JSON.stringify({
          source_type: SOURCE_TYPE,
          entity_type: entity.type,
          table_id: def.table_id,
          filters: (def.filters || []).filter(f => f.field_id && f.value),
        }),
      })
      setPreview(res)
    } catch (e) {
      setPreviewErr(e.message)
    } finally {
      setPreviewing(false)
    }
  }

  const isComplete = !!def.table_id

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-4 transition-colors ${isComplete ? 'border-accent/40' : 'border-border'}`}>

      {/* Entity header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-foreground text-sm font-semibold flex items-center gap-2">
            {entity.label}
            {entity.optional && !isComplete && <span className="text-muted text-xs font-normal">(optional)</span>}
            {isComplete && <span className="text-accent text-xs">✓</span>}
          </p>
          <p className="text-muted text-xs">{entity.desc}</p>
        </div>
      </div>

      {/* Table selector */}
      <label className="flex flex-col gap-1.5">
        <span className="text-muted text-xs">Table</span>
        <select
          value={def.table_id || ''}
          onChange={e => {
            const t = tables.find(t => t.id === e.target.value)
            update({ table_id: e.target.value, table_name: t?.name || '', filters: [], rel_field_id: '', rel_field_name: '', rel_direction: 'child_holds_link' })
            setPreview(null)
          }}
          className="bg-surface-2 border border-border rounded-md px-2 py-1.5 text-foreground text-sm outline-none focus:border-accent"
        >
          <option value="">— select table —</option>
          {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>

      {/* Filters */}
      {def.table_id && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-muted text-xs">Filters <span className="opacity-60">(optional)</span></span>
            <button
              onClick={addFilter}
              className="text-xs text-accent hover:text-accent-hover cursor-pointer"
            >+ Add filter</button>
          </div>
          {(def.filters || []).map((f, i) => {
            const ff = tableFields.find(tf => tf.id === f.field_id)
            return (
              <div key={i} className="flex gap-2 items-center">
                <select
                  value={f.field_id}
                  onChange={e => {
                    const tf = tableFields.find(tf => tf.id === e.target.value)
                    updateFilter(i, { field_id: e.target.value, field_name: tf?.name || '', value: '' })
                  }}
                  className="flex-1 bg-surface-3 border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                >
                  <option value="">— field —</option>
                  {tableFields.map(tf => <option key={tf.id} value={tf.id}>{tf.name}</option>)}
                </select>
                <select
                  value={f.operator}
                  onChange={e => updateFilter(i, { operator: e.target.value })}
                  className="bg-surface-3 border border-border rounded px-2 py-1 text-xs text-foreground outline-none focus:border-accent"
                >
                  {OPERATORS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
                </select>
                {valueInputForField(ff, f.value, v => updateFilter(i, { value: v }))}
                <button onClick={() => removeFilter(i)} className="text-muted hover:text-error text-sm cursor-pointer">×</button>
              </div>
            )
          })}
        </div>
      )}

      {/* Relationship field (asset + task only) */}
      {entity.parent && def.table_id && (
        <div className="flex flex-col gap-2">
          <span className="text-muted text-xs">Link to {entity.parent}</span>

          {!parentTableId && (
            <p className="text-warning text-xs">Define {entity.parent} first to see link fields.</p>
          )}

          {parentTableId && validLinkFields.length === 0 && (
            <p className="text-warning text-xs">
              No linked-record fields found pointing to the {entity.parent} table.
              Check that a link field exists in this table.
            </p>
          )}

          {parentTableId && validLinkFields.length > 0 && (
            <div className="flex gap-2 items-center">
              <select
                value={def.rel_field_id || ''}
                onChange={e => {
                  const ff = validLinkFields.find(f => f.id === e.target.value)
                  update({ rel_field_id: e.target.value, rel_field_name: ff?.name || '', rel_direction: 'child_holds_link' })
                }}
                className="flex-1 bg-surface-2 border border-border rounded-md px-2 py-1.5 text-sm text-foreground outline-none focus:border-accent"
              >
                <option value="">— select link field —</option>
                {validLinkFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      {/* Preview */}
      {def.table_id && (
        <div className="flex items-center gap-3">
          <button
            onClick={runPreview}
            disabled={previewing}
            className="px-3 py-1 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface-3 transition-colors cursor-pointer disabled:opacity-40"
          >
            {previewing ? 'Previewing…' : 'Preview'}
          </button>
          {preview && (
            <p className="text-muted text-xs">
              <span className="text-foreground font-medium">
                {preview.has_more ? `100+` : preview.count}
              </span>{' '}
              record{preview.count !== 1 ? 's' : ''}
              {preview.samples.length > 0 && ` — ${preview.samples.join(', ')}`}
              {preview.has_more ? '…' : ''}
            </p>
          )}
          {previewErr && <p className="text-error text-xs">{previewErr}</p>}
        </div>
      )}
    </div>
  )
}


function StepHierarchy({ tables, onSuccess, onBack }) {
  const [definitions, setDefinitions] = useState({ product: {}, asset: {}, task: {}, item_type: {} })
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  // Pre-load any saved definitions
  useEffect(() => {
    apiFetch(`/api/init/entity-definitions?source_type=${SOURCE_TYPE}`)
      .then(data => {
        if (Object.keys(data).length > 0) setDefinitions(prev => ({ ...prev, ...data }))
      })
      .catch(() => {})
  }, [])

  function updateDef(type, def) {
    setDefinitions(prev => ({ ...prev, [type]: def }))
  }

  const allComplete = ENTITIES.every(e => e.optional || !!definitions[e.type]?.table_id)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      for (const entity of ENTITIES) {
        const def = definitions[entity.type]
        if (!def?.table_id) continue  // skip optional entities left unconfigured
        await apiFetch('/api/init/entity-definitions', {
          method: 'PUT',
          body: JSON.stringify({
            source_type:    SOURCE_TYPE,
            entity_type:    entity.type,
            table_id:       def.table_id,
            table_name:     def.table_name,
            filters:        (def.filters || []).filter(f => f.field_id && f.value),
            rel_field_id:   def.rel_field_id || null,
            rel_field_name: def.rel_field_name || null,
            rel_direction:  def.rel_direction || null,
          }),
        })
      }
      onSuccess(definitions)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted text-sm">
        Tell ArtHound how your data is structured. Define which table represents
        each entity and how they connect to each other.
      </p>
      {ENTITIES.map(entity => (
        <EntityPanel
          key={entity.type}
          entity={entity}
          tables={tables}
          definitions={definitions}
          onChange={updateDef}
        />
      ))}
      {error && <p className="text-error text-sm">{error}</p>}
      <div className="flex items-center justify-between pt-1">
        <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        <div className="flex items-center gap-3">
          <p className="text-muted text-xs">
            {allComplete ? 'All entities defined' : 'Define all three entities to continue'}
          </p>
          <button
            onClick={save}
            disabled={saving || !allComplete}
            className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save & continue'}
          </button>
        </div>
      </div>
    </div>
  )
}


// ── Step 4: Map fields ────────────────────────────────────────────────────────

function StepMapFields({ sourceFields, onSuccess, onBack }) {
  const [assignments, setAssignments] = useState({})
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  useEffect(() => {
    apiFetch(`/api/init/field-mappings?source_type=${SOURCE_TYPE}`)
      .then(data => {
        const a = {}
        for (const m of data.mappings) {
          if (m.arthound_slot) a[m.arthound_slot] = m.source_field_id
        }
        setAssignments(a)
      })
      .catch(() => {})
  }, [])

  const mappedRequired = REQUIRED_SLOTS.filter(s => assignments[s])
  const allRequiredMapped = mappedRequired.length === REQUIRED_SLOTS.length

  function setSlot(slot, fieldId) {
    setAssignments(prev => {
      const next = { ...prev }
      if (fieldId) next[slot] = fieldId
      else delete next[slot]
      return next
    })
  }

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const mappings = sourceFields.map(f => ({
        source_field_id:      f.id,
        source_field_name:    f.name,
        source_field_type:    f.type,
        source_field_options: f.options || {},
        arthound_slot: Object.entries(assignments).find(([, fid]) => fid === f.id)?.[0] ?? null,
      }))
      await apiFetch('/api/init/field-mappings', {
        method: 'PUT',
        body: JSON.stringify({ source_type: SOURCE_TYPE, mappings }),
      })
      onSuccess()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted text-sm">
        Map your asset fields to ArtHound slots.
        Fields marked <span className="text-error">*</span> are required.
      </p>
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-2">
              <th className="text-left text-muted font-normal px-3 py-2 w-1/2">ArtHound slot</th>
              <th className="text-left text-muted font-normal px-3 py-2 w-1/2">Source field</th>
            </tr>
          </thead>
          <tbody>
            {ALL_SLOTS.map(s => (
              <tr key={s.slot} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-2 text-foreground">
                  {s.label}{s.required && <span className="text-error ml-0.5">*</span>}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={assignments[s.slot] ?? ''}
                    onChange={e => setSlot(s.slot, e.target.value)}
                    className={`w-full bg-surface-2 border rounded-md px-2 py-1.5 text-foreground text-sm outline-none focus:border-accent ${
                      s.required && !assignments[s.slot] ? 'border-error/60' : 'border-border'
                    }`}
                  >
                    <option value="">— unmapped —</option>
                    {sourceFields.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="text-error text-sm">{error}</p>}
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        <div className="flex items-center gap-3">
          <p className="text-muted text-xs">
            {allRequiredMapped
              ? 'All required fields mapped'
              : `${REQUIRED_SLOTS.length - mappedRequired.length} required field(s) still unmapped`}
          </p>
          <button
            onClick={save}
            disabled={saving || !allRequiredMapped}
            className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save & continue'}
          </button>
        </div>
      </div>
    </div>
  )
}


// ── Step 5: Review ────────────────────────────────────────────────────────────

function StepReview({ definitions, isReset, onStart, onBack }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  async function start() {
    setLoading(true)
    setError(null)
    try {
      const endpoint = isReset ? '/api/init/reset' : '/api/init/start'
      const res = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ source_type: SOURCE_TYPE }),
      })
      onStart(res.job_id)
    } catch (e) {
      setError(e.message)
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-surface-2 border border-border rounded-lg divide-y divide-border">
        <div className="flex justify-between px-4 py-3">
          <span className="text-muted text-sm">Source</span>
          <span className="text-foreground text-sm font-medium">Airtable</span>
        </div>
        {ENTITIES.map(e => {
          const def = definitions[e.type]
          return (
            <div key={e.type} className="flex justify-between px-4 py-3">
              <span className="text-muted text-sm">{e.label}</span>
              <span className="text-foreground text-sm font-medium">
                {def?.table_name || '—'}
                {def?.filters?.length > 0 && <span className="text-muted text-xs ml-1">({def.filters.length} filter{def.filters.length > 1 ? 's' : ''})</span>}
              </span>
            </div>
          )
        })}
        <div className="flex justify-between px-4 py-3">
          <span className="text-muted text-sm">Mode</span>
          <span className="text-foreground text-sm font-medium">{isReset ? 'Reset (existing data wiped)' : 'First-time setup'}</span>
        </div>
      </div>

      {isReset && (
        <p className="text-warning text-sm bg-warning/10 border border-warning/30 rounded-md px-3 py-2">
          This will delete all replicated assets, products, and tasks and re-import from scratch.
        </p>
      )}

      {error && <p className="text-error text-sm">{error}</p>}

      <div className="flex gap-2">
        <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        <button
          onClick={start}
          disabled={loading}
          className="flex-1 px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          {loading ? 'Starting…' : isReset ? 'Reset & re-sync' : 'Start sync'}
        </button>
      </div>
    </div>
  )
}


// ── Step 6: Progress ──────────────────────────────────────────────────────────

function StepProgress({ jobId, onComplete, onBack }) {
  const [job, setJob]     = useState(null)
  const intervalRef       = useRef(null)

  useEffect(() => {
    poll()
    intervalRef.current = setInterval(poll, 2000)
    return () => clearInterval(intervalRef.current)
  }, [jobId])

  async function poll() {
    try {
      const data = await apiFetch(`/api/init/jobs/${jobId}`)
      setJob(data)
      if (data.status === 'completed' || data.status === 'error') {
        clearInterval(intervalRef.current)
        if (data.status === 'completed') onComplete(data.progress_current)
      }
    } catch { }
  }

  const pct = job?.progress_total
    ? Math.round((job.progress_current / job.progress_total) * 100)
    : null

  return (
    <div className="flex flex-col gap-5 items-center py-4">
      {(!job || job.status === 'running' || job.status === 'pending') && (
        <>
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-foreground text-sm font-medium">Syncing your project…</p>
          {job && (
            <div className="w-full flex flex-col gap-2">
              {job.progress_total ? (
                <>
                  <div className="w-full bg-surface-2 rounded-full h-2 border border-border">
                    <div className="bg-accent h-full rounded-full transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="text-muted text-xs text-center">{job.progress_current} / {job.progress_total} records ({pct}%)</p>
                </>
              ) : (
                <p className="text-muted text-xs text-center">
                  {job.progress_current > 0 ? `${job.progress_current} records processed…` : 'Fetching records…'}
                </p>
              )}
            </div>
          )}
          <p className="text-muted text-xs">This may take a few minutes. You can leave this page and come back.</p>
        </>
      )}
      {job?.status === 'error' && (
        <div className="flex flex-col gap-3 w-full">
          <p className="text-error text-sm font-medium">Sync failed</p>
          {job.error_log?.length > 0 && (
            <pre className="text-xs text-muted bg-surface-2 border border-border rounded-md p-3 overflow-auto max-h-32">
              {job.error_log.join('\n')}
            </pre>
          )}
          <p className="text-muted text-xs">Check your credentials and hierarchy config, then try again.</p>
          <button
            onClick={onBack}
            className="self-start px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer"
          >
            Back to review
          </button>
        </div>
      )}
    </div>
  )
}


// ── Step 7: Done ──────────────────────────────────────────────────────────────

function StepDone({ recordCount, isReset }) {
  const navigate = useNavigate()
  const { refreshProfile } = useAuth()

  async function finish() {
    await refreshProfile()
    navigate('/', { replace: true })
  }

  return (
    <div className="flex flex-col gap-5 items-center py-4 text-center">
      <div className="w-12 h-12 rounded-full bg-accent/15 flex items-center justify-center text-2xl">✓</div>
      <div>
        <p className="text-foreground font-semibold text-base mb-1">
          {isReset ? 'Project reset complete' : 'Setup complete'}
        </p>
        <p className="text-muted text-sm">
          {recordCount} asset{recordCount !== 1 ? 's' : ''} synced from Airtable.
        </p>
      </div>
      <button
        onClick={finish}
        className="px-5 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer"
      >
        Go to ArtHound
      </button>
    </div>
  )
}


// ── Wizard shell ──────────────────────────────────────────────────────────────

const STEP_TITLES = [
  'Connect source',
  'Discover schema',
  'Define hierarchy',
  'Map fields',
  'Review',
  'Syncing',
  'Done',
]
const TOTAL_STEPS = STEP_TITLES.length

export default function ProjectInit() {
  const [searchParams]  = useSearchParams()
  const isReset = searchParams.get('reset') === '1'

  const [step, setStep]               = useState(1)
  const [tables, setTables]           = useState([])
  const [definitions, setDefinitions] = useState({ product: {}, asset: {}, task: {}, item_type: {} })
  const [sourceFields, setSourceFields] = useState([])
  const [jobId, setJobId]             = useState(null)
  const [recordCount, setRecordCount] = useState(0)

  // Derive asset fields from the asset entity definition + cached schema
  function getAssetFields() {
    const assetDef = definitions.asset
    if (!assetDef?.table_id || tables.length === 0) return sourceFields
    const t = tables.find(t => t.id === assetDef.table_id)
    return t?.fields || sourceFields
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-foreground text-xl font-semibold mb-1">
            {isReset ? 'Reset project data' : 'Set up your project'}
          </h1>
          <p className="text-muted text-sm">{STEP_TITLES[step - 1]}</p>
        </div>

        <StepDots
          current={step}
          total={TOTAL_STEPS}
          onNavigate={step < 6 ? setStep : undefined}
        />

        <div className="bg-surface border border-border rounded-xl p-6">
          {step === 1 && (
            <StepCredentials onSuccess={() => setStep(2)} />
          )}
          {step === 2 && (
            <StepDiscover
              onSuccess={t => { setTables(t); setSourceFields(t[0]?.fields || []); setStep(3) }}
              onBack={() => setStep(1)}
            />
          )}
          {step === 3 && (
            <StepHierarchy
              tables={tables}
              onSuccess={defs => { setDefinitions(defs); setStep(4) }}
              onBack={() => setStep(2)}
            />
          )}
          {step === 4 && (
            <StepMapFields
              sourceFields={getAssetFields()}
              onSuccess={() => setStep(5)}
              onBack={() => setStep(3)}
            />
          )}
          {step === 5 && (
            <StepReview
              definitions={definitions}
              isReset={isReset}
              onStart={id => { setJobId(id); setStep(6) }}
              onBack={() => setStep(4)}
            />
          )}
          {step === 6 && (
            <StepProgress
              jobId={jobId}
              onComplete={count => { setRecordCount(count); setStep(7) }}
              onBack={() => setStep(5)}
            />
          )}
          {step === 7 && (
            <StepDone recordCount={recordCount} isReset={isReset} />
          )}
        </div>
      </div>
    </div>
  )
}
