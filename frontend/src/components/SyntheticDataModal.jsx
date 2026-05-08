import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

function clamp(v) {
  const n = parseInt(v, 10)
  if (isNaN(n)) return 1
  return Math.min(1000, Math.max(1, n))
}

const inputCls = 'w-full bg-surface-2 border border-border rounded-md px-3 py-1.5 text-xs text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-primary font-mono'
const selectCls = 'w-full bg-surface-2 border border-border rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary'

const STEP_LABELS = ['Connect', 'Map tables', 'PAW counts', 'Confirm']

const WRITABLE_TYPES = new Set([
  'singleLineText', 'multilineText', 'number', 'currency', 'percent',
  'singleSelect', 'multipleSelects', 'checkbox', 'date', 'dateTime',
  'rating', 'duration', 'email', 'url', 'phoneNumber',
])

const TYPE_LABEL = {
  singleLineText:  'text',
  multilineText:   'long text',
  number:          'number',
  currency:        'currency',
  percent:         'percent',
  singleSelect:    'single select',
  multipleSelects: 'multi select',
  checkbox:        'checkbox',
  date:            'date',
  dateTime:        'date+time',
  rating:          'rating',
  duration:        'duration',
  email:           'email',
  url:             'url',
  phoneNumber:     'phone',
}

function ExtraFieldsPanel({ tableFields, primaryField, linkField, checkedFields, setCheckedFields, open, setOpen }) {
  const extras = tableFields.filter(f =>
    WRITABLE_TYPES.has(f.type) &&
    f.name !== primaryField &&
    f.name !== linkField
  )
  if (extras.length === 0) return null
  const checkedCount = Object.values(checkedFields).filter(Boolean).length
  return (
    <div className="pl-2 mt-2">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground"
      >
        <span>{open ? '▾' : '▸'}</span>
        <span>Additional fields</span>
        {checkedCount > 0 && <span className="text-primary ml-1">({checkedCount} selected)</span>}
      </button>
      {open && (
        <div className="mt-1.5 max-h-44 overflow-y-auto border border-border rounded-md divide-y divide-border">
          {extras.map(f => {
            const noOptions = (f.type === 'singleSelect' || f.type === 'multipleSelects') &&
              !f.options?.choices?.length
            return (
              <label
                key={f.id}
                className={`flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-surface-2 ${noOptions ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={!!checkedFields[f.id]}
                  disabled={noOptions}
                  onChange={e => setCheckedFields(prev => ({ ...prev, [f.id]: e.target.checked }))}
                  className="accent-primary shrink-0"
                />
                <span className="text-xs text-foreground flex-1 min-w-0 truncate">{f.name}</span>
                <span className="text-xs text-muted bg-surface-2 border border-border px-1.5 py-0.5 rounded shrink-0">
                  {noOptions
                    ? `${TYPE_LABEL[f.type] ?? f.type} — no options`
                    : (TYPE_LABEL[f.type] ?? f.type)}
                </span>
              </label>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function SyntheticDataModal({ onClose }) {
  const [step, setStep] = useState(1)

  // ── Step 1 ──
  const [targets, setTargets]               = useState([])
  const [loadingTargets, setLoadingTargets] = useState(true)
  const [selectedId, setSelectedId]         = useState(null)
  const [showNewForm, setShowNewForm]       = useState(false)
  const [newForm, setNewForm]               = useState({ name: '', base_id: '', token: '' })
  const [connecting, setConnecting]         = useState(false)
  const [step1Error, setStep1Error]         = useState(null)

  // ── Step 2 ──
  const [schema, setSchema]               = useState(null)
  const [schemaLoading, setSchemaLoading] = useState(false)
  const [schemaError, setSchemaError]     = useState(null)
  const [pTableId, setPTableId]           = useState('')
  const [aTableId, setATableId]           = useState('')
  const [wTableId, setWTableId]           = useState('')
  const [pPrimaryField, setPPrimaryField] = useState('')
  const [aPrimaryField, setAPrimaryField] = useState('')
  const [wPrimaryField, setWPrimaryField] = useState('')
  const [aLinkField, setALinkField]       = useState('')
  const [wLinkField, setWLinkField]       = useState('')
  const [mappingSaving, setMappingSaving] = useState(false)
  const [mappingError, setMappingError]   = useState(null)
  // Extra field selection per layer — { [fieldId]: bool }, reset on table change
  const [pCheckedFields, setPCheckedFields] = useState({})
  const [aCheckedFields, setACheckedFields] = useState({})
  const [wCheckedFields, setWCheckedFields] = useState({})
  const [pExtraOpen, setPExtraOpen] = useState(false)
  const [aExtraOpen, setAExtraOpen] = useState(false)
  const [wExtraOpen, setWExtraOpen] = useState(false)

  // ── Step 3 ──
  const [pCount, setPCount]     = useState(10)
  const [aCount, setACount]     = useState(10)
  const [wCount, setWCount]     = useState(10)
  const [linkAtoP, setLinkAtoP] = useState(false)
  const [linkWtoA, setLinkWtoA] = useState(false)

  // ── Step 4 ──
  const [generating, setGenerating] = useState(false)
  const [result, setResult]         = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    apiFetch('/api/synthetic/targets', { signal: controller.signal })
      .then(data => { setTargets(data); setLoadingTargets(false) })
      .catch(e => { if (e.name !== 'AbortError') setLoadingTargets(false) })
    return () => controller.abort()
  }, [])

  const selectedTarget = targets.find(t => t.id === selectedId) ?? null

  const pTableFields = schema?.tables.find(t => t.id === pTableId)?.fields ?? []
  const aTableFields = schema?.tables.find(t => t.id === aTableId)?.fields ?? []
  const wTableFields = schema?.tables.find(t => t.id === wTableId)?.fields ?? []
  const aLinkFields  = aTableFields.filter(f => f.type === 'multipleRecordLinks')
  const wLinkFields  = wTableFields.filter(f => f.type === 'multipleRecordLinks')

  function primaryFieldOf(tableId) {
    return schema?.tables.find(t => t.id === tableId)?.fields?.[0]?.name ?? ''
  }

  function getCheckedExtraFields(tableFields, primaryField, linkField, checkedState) {
    return tableFields
      .filter(f => WRITABLE_TYPES.has(f.type) && f.name !== primaryField && f.name !== linkField && checkedState[f.id])
      .map(f => ({ name: f.name, type: f.type, options: f.options ?? {} }))
  }

  // ── Step 1 handlers ──────────────────────────────────────────────────────────

  function handleSelectTarget(id) {
    setSelectedId(id)
    setShowNewForm(false)
    setStep1Error(null)
  }

  async function handleDeleteTarget(id, e) {
    e.stopPropagation()
    try {
      await apiFetch(`/api/synthetic/targets/${id}`, { method: 'DELETE' })
    } catch (err) {
      console.error('Delete target failed:', err)
      return
    }
    setTargets(prev => prev.filter(t => t.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  async function handleConnect() {
    setStep1Error(null)
    if (!newForm.name.trim() || !newForm.base_id.trim() || !newForm.token.trim()) {
      setStep1Error('Name, Base ID, and token are all required')
      return
    }
    setConnecting(true)
    try {
      const saved = await apiFetch('/api/synthetic/targets', {
        method: 'POST',
        body: JSON.stringify({
          name:    newForm.name.trim(),
          base_id: newForm.base_id.trim(),
          token:   newForm.token.trim(),
        }),
      })
      setTargets(prev => [...prev, saved])
      setSelectedId(saved.id)
      setNewForm({ name: '', base_id: '', token: '' })
      setShowNewForm(false)
      await enterStep2(saved.id)
    } catch (err) {
      setStep1Error(err.message ?? 'Connection failed')
    } finally {
      setConnecting(false)
    }
  }

  async function handleNextFromStep1() {
    if (!selectedId) return
    await enterStep2(selectedId)
  }

  // ── Step 2 handlers ──────────────────────────────────────────────────────────

  async function enterStep2(targetId) {
    setStep(2)
    setSchemaLoading(true)
    setSchemaError(null)
    setSchema(null)
    setPTableId(''); setATableId(''); setWTableId('')
    setPPrimaryField(''); setAPrimaryField(''); setWPrimaryField('')
    setALinkField(''); setWLinkField('')
    setPCheckedFields({}); setACheckedFields({}); setWCheckedFields({})
    setPExtraOpen(false); setAExtraOpen(false); setWExtraOpen(false)
    try {
      const data = await apiFetch(`/api/synthetic/targets/${targetId}/schema`)
      setSchema(data)
      const t = targets.find(t => t.id === targetId)
      if (t) {
        const findId = (name) => data.tables.find(tb => tb.name === name || tb.id === name)?.id ?? ''
        if (t.p_table) { const id = findId(t.p_table); setPTableId(id); setPPrimaryField(t.p_primary_field || data.tables.find(tb => tb.id === id)?.fields?.[0]?.name || '') }
        if (t.a_table) { const id = findId(t.a_table); setATableId(id); setAPrimaryField(t.a_primary_field || data.tables.find(tb => tb.id === id)?.fields?.[0]?.name || '') }
        if (t.w_table) { const id = findId(t.w_table); setWTableId(id); setWPrimaryField(t.w_primary_field || data.tables.find(tb => tb.id === id)?.fields?.[0]?.name || '') }
        if (t.a_link_field) setALinkField(t.a_link_field)
        if (t.w_link_field) setWLinkField(t.w_link_field)
      }
    } catch (err) {
      setSchemaError(err.message ?? 'Failed to load schema')
    } finally {
      setSchemaLoading(false)
    }
  }

  async function handleSaveMapping() {
    if (!pTableId || !aTableId || !wTableId) {
      setMappingError('Select a table for each layer')
      return
    }
    if (!pPrimaryField || !aPrimaryField || !wPrimaryField) {
      setMappingError('Select a primary field for each table')
      return
    }
    setMappingError(null)
    setMappingSaving(true)
    const tableName = (id) => schema.tables.find(t => t.id === id)?.name ?? id
    try {
      await apiFetch(`/api/synthetic/targets/${selectedId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          p_table:         tableName(pTableId),
          a_table:         tableName(aTableId),
          w_table:         tableName(wTableId),
          p_primary_field: pPrimaryField,
          a_primary_field: aPrimaryField,
          w_primary_field: wPrimaryField,
          a_link_field:    aLinkField || null,
          w_link_field:    wLinkField || null,
        }),
      })
      setTargets(prev => prev.map(t => t.id !== selectedId ? t : {
        ...t,
        p_table: tableName(pTableId), a_table: tableName(aTableId), w_table: tableName(wTableId),
        p_primary_field: pPrimaryField, a_primary_field: aPrimaryField, w_primary_field: wPrimaryField,
        a_link_field: aLinkField || null, w_link_field: wLinkField || null,
      }))
      setStep(3)
    } catch (err) {
      setMappingError(err.message ?? 'Failed to save mapping')
    } finally {
      setMappingSaving(false)
    }
  }

  // ── Step 4 handler ───────────────────────────────────────────────────────────

  async function handleGenerate() {
    setGenerating(true)
    setResult(null)
    try {
      const data = await apiFetch('/api/synthetic/generate', {
        method: 'POST',
        body: JSON.stringify({
          target_id:      selectedId,
          p_count:        pCount,
          a_count:        aCount,
          w_count:        wCount,
          link_a_to_p:    linkAtoP,
          link_w_to_a:    linkWtoA,
          extra_fields_p: getCheckedExtraFields(pTableFields, pPrimaryField, null, pCheckedFields),
          extra_fields_a: getCheckedExtraFields(aTableFields, aPrimaryField, aLinkField, aCheckedFields),
          extra_fields_w: getCheckedExtraFields(wTableFields, wPrimaryField, wLinkField, wCheckedFields),
        }),
      })
      setResult(data)
    } catch (err) {
      setResult({ error: err.message ?? 'Generation failed' })
    } finally {
      setGenerating(false)
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl flex flex-col w-full max-w-xl max-h-[85vh] overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-foreground">Synthetic Data</span>
            <div className="flex items-center gap-1.5">
              {STEP_LABELS.map((label, i) => (
                <span key={i} className={`text-xs px-1.5 py-0.5 rounded ${step === i + 1 ? 'text-foreground bg-surface-2' : 'text-muted'}`}>
                  {label}
                </span>
              ))}
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-foreground text-lg leading-none">×</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">

          {/* ── Step 1: Connect ── */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-xs text-muted">Select an existing target or connect a new Airtable base.</p>

              {loadingTargets ? (
                <p className="text-xs text-muted">Loading…</p>
              ) : (
                <div className="space-y-1.5">
                  {targets.map(t => (
                    <button
                      key={t.id}
                      onClick={() => handleSelectTarget(t.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border text-xs transition-colors flex items-center justify-between gap-2 ${
                        selectedId === t.id
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-surface-2 text-foreground hover:border-primary/50'
                      }`}
                    >
                      <div>
                        <div className="font-medium">{t.name}</div>
                        <div className="text-muted mt-0.5 font-mono">{t.base_id}</div>
                      </div>
                      <span
                        onClick={e => handleDeleteTarget(t.id, e)}
                        className="text-muted hover:text-error shrink-0 cursor-pointer"
                        title="Delete"
                      >×</span>
                    </button>
                  ))}
                </div>
              )}

              {!showNewForm ? (
                <button
                  onClick={() => { setShowNewForm(true); setSelectedId(null); setStep1Error(null) }}
                  className="text-xs text-primary hover:underline"
                >
                  + Connect new base
                </button>
              ) : (
                <div className="border border-border rounded-lg p-4 space-y-3 bg-surface-2">
                  <p className="text-xs font-medium text-foreground">New Airtable Connection</p>
                  <div>
                    <label className="text-xs text-muted block mb-1">Name <span className="text-error">*</span></label>
                    <input
                      className={inputCls + ' font-sans'}
                      placeholder="e.g. Test Base"
                      value={newForm.name}
                      onChange={e => setNewForm(f => ({ ...f, name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted block mb-1">Base ID <span className="text-error">*</span></label>
                    <input
                      className={inputCls}
                      placeholder="appXXXXXXXXXXXXXX"
                      value={newForm.base_id}
                      onChange={e => setNewForm(f => ({ ...f, base_id: e.target.value }))}
                    />
                    <p className="text-xs text-muted mt-1">Found in your base URL: airtable.com/<strong>appXXX</strong>/…</p>
                  </div>
                  <div>
                    <label className="text-xs text-muted block mb-1">Personal Access Token <span className="text-error">*</span></label>
                    <input
                      type="password"
                      className={inputCls}
                      placeholder="patXXXXXXXXXXXXXX"
                      value={newForm.token}
                      onChange={e => setNewForm(f => ({ ...f, token: e.target.value }))}
                    />
                  </div>
                  {step1Error && <p className="text-xs text-error">{step1Error}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={handleConnect}
                      disabled={connecting}
                      className="px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
                    >
                      {connecting ? 'Connecting…' : 'Test & Connect'}
                    </button>
                    <button
                      onClick={() => { setShowNewForm(false); setStep1Error(null) }}
                      className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Map tables ── */}
          {step === 2 && (
            <div className="space-y-4">
              {schemaLoading && (
                <div className="flex flex-col items-center gap-3 py-8">
                  <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs text-muted">Discovering schema…</p>
                </div>
              )}

              {schemaError && (
                <div className="space-y-2">
                  <p className="text-xs text-error">{schemaError}</p>
                  <button onClick={() => enterStep2(selectedId)} className="text-xs text-primary hover:underline">Retry</button>
                </div>
              )}

              {schema && !schemaLoading && (
                <>
                  <p className="text-xs text-muted">
                    Found <strong className="text-foreground">{schema.tables.length} tables</strong> in <strong className="text-foreground">{selectedTarget?.name}</strong>.
                    Assign one to each layer.
                  </p>

                  {/* Table + primary field + extra fields selectors */}
                  <div className="space-y-5">
                    {[
                      {
                        label: 'Products',
                        tableId: pTableId,
                        setTable: (v) => { setPTableId(v); setPPrimaryField(primaryFieldOf(v)); setPCheckedFields({}); setPExtraOpen(false) },
                        primaryField: pPrimaryField, setPrimary: setPPrimaryField, fields: pTableFields,
                        linkField: null,
                        checkedFields: pCheckedFields, setCheckedFields: setPCheckedFields,
                        extraOpen: pExtraOpen, setExtraOpen: setPExtraOpen,
                      },
                      {
                        label: 'Assets',
                        tableId: aTableId,
                        setTable: (v) => { setATableId(v); setAPrimaryField(primaryFieldOf(v)); setALinkField(''); setACheckedFields({}); setAExtraOpen(false) },
                        primaryField: aPrimaryField, setPrimary: setAPrimaryField, fields: aTableFields,
                        linkField: aLinkField,
                        checkedFields: aCheckedFields, setCheckedFields: setACheckedFields,
                        extraOpen: aExtraOpen, setExtraOpen: setAExtraOpen,
                      },
                      {
                        label: 'Work',
                        tableId: wTableId,
                        setTable: (v) => { setWTableId(v); setWPrimaryField(primaryFieldOf(v)); setWLinkField(''); setWCheckedFields({}); setWExtraOpen(false) },
                        primaryField: wPrimaryField, setPrimary: setWPrimaryField, fields: wTableFields,
                        linkField: wLinkField,
                        checkedFields: wCheckedFields, setCheckedFields: setWCheckedFields,
                        extraOpen: wExtraOpen, setExtraOpen: setWExtraOpen,
                      },
                    ].map(({ label, tableId, setTable, primaryField, setPrimary, fields, linkField, checkedFields, setCheckedFields, extraOpen, setExtraOpen }) => (
                      <div key={label} className="space-y-1.5">
                        <label className="text-xs text-muted block">{label} table <span className="text-error">*</span></label>
                        <select className={selectCls} value={tableId} onChange={e => setTable(e.target.value)}>
                          <option value="">— select table —</option>
                          {schema.tables.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                        {tableId && (
                          <>
                            <div className="flex items-center gap-2 pl-2">
                              <span className="text-xs text-muted shrink-0">Primary field</span>
                              <select
                                className={selectCls}
                                value={primaryField}
                                onChange={e => setPrimary(e.target.value)}
                              >
                                <option value="">— select field —</option>
                                {fields.map(f => (
                                  <option key={f.id} value={f.name}>{f.name}</option>
                                ))}
                              </select>
                            </div>
                            <ExtraFieldsPanel
                              tableFields={fields}
                              primaryField={primaryField}
                              linkField={linkField}
                              checkedFields={checkedFields}
                              setCheckedFields={setCheckedFields}
                              open={extraOpen}
                              setOpen={setExtraOpen}
                            />
                          </>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Link field selectors */}
                  {(aTableId || wTableId) && (
                    <div className="border-t border-border pt-4 space-y-3">
                      <p className="text-xs font-medium text-foreground">Link fields <span className="text-muted font-normal">(optional)</span></p>
                      <p className="text-xs text-muted">
                        Select the linked-record fields used to connect layers. Only linked-record fields are shown.
                      </p>

                      {aTableId && (
                        <div>
                          <label className="text-xs text-muted block mb-1">
                            Assets → Products field
                            {aLinkFields.length === 0 && <span className="ml-1 italic">(no linked-record fields in this table)</span>}
                          </label>
                          <select
                            className={selectCls}
                            value={aLinkField}
                            onChange={e => setALinkField(e.target.value)}
                            disabled={aLinkFields.length === 0}
                          >
                            <option value="">— none —</option>
                            {aLinkFields.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
                          </select>
                        </div>
                      )}

                      {wTableId && (
                        <div>
                          <label className="text-xs text-muted block mb-1">
                            Work → Assets field
                            {wLinkFields.length === 0 && <span className="ml-1 italic">(no linked-record fields in this table)</span>}
                          </label>
                          <select
                            className={selectCls}
                            value={wLinkField}
                            onChange={e => setWLinkField(e.target.value)}
                            disabled={wLinkFields.length === 0}
                          >
                            <option value="">— none —</option>
                            {wLinkFields.map(f => <option key={f.id} value={f.name}>{f.name}</option>)}
                          </select>
                        </div>
                      )}
                    </div>
                  )}

                  {mappingError && <p className="text-xs text-error">{mappingError}</p>}
                </>
              )}
            </div>
          )}

          {/* ── Step 3: PAW counts ── */}
          {step === 3 && (
            <div className="space-y-5">
              <p className="text-xs text-muted">How many records to generate in each layer?</p>

              <div className="space-y-3">
                {[
                  { label: 'Products', value: pCount, set: setPCount },
                  { label: 'Assets',   value: aCount, set: setACount },
                  { label: 'Work',     value: wCount, set: setWCount },
                ].map(({ label, value, set }) => (
                  <div key={label} className="flex items-center gap-4">
                    <span className="text-xs text-foreground w-16 shrink-0">{label}</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={value}
                      onChange={e => set(clamp(e.target.value))}
                      onBlur={e => set(clamp(e.target.value))}
                      className="w-24 bg-surface-2 border border-border rounded-md px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <span className="text-xs text-muted">max 1,000</span>
                  </div>
                ))}
              </div>

              <div className="border-t border-border pt-4 space-y-2.5">
                <p className="text-xs font-medium text-foreground">Linking</p>

                <label className={`flex items-start gap-2.5 cursor-pointer ${!selectedTarget?.a_link_field ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  <input
                    type="checkbox"
                    checked={linkAtoP}
                    disabled={!selectedTarget?.a_link_field}
                    onChange={e => setLinkAtoP(e.target.checked)}
                    className="mt-0.5 accent-primary"
                  />
                  <div>
                    <span className="text-xs text-foreground">Randomly link each Asset to a Product</span>
                    {!selectedTarget?.a_link_field && (
                      <p className="text-xs text-muted mt-0.5">No link field configured — set one in step 2</p>
                    )}
                  </div>
                </label>

                <label className={`flex items-start gap-2.5 cursor-pointer ${!selectedTarget?.w_link_field ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  <input
                    type="checkbox"
                    checked={linkWtoA}
                    disabled={!selectedTarget?.w_link_field}
                    onChange={e => setLinkWtoA(e.target.checked)}
                    className="mt-0.5 accent-primary"
                  />
                  <div>
                    <span className="text-xs text-foreground">Randomly link each Work item to an Asset</span>
                    {!selectedTarget?.w_link_field && (
                      <p className="text-xs text-muted mt-0.5">No link field configured — set one in step 2</p>
                    )}
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* ── Step 4: Confirm + Generate ── */}
          {step === 4 && (
            <div className="space-y-4">
              {!result && !generating && (
                <>
                  <div className="bg-surface-2 border border-border rounded-lg p-4 space-y-2">
                    <p className="text-xs font-medium text-foreground">{selectedTarget?.name}</p>
                    <p className="text-xs text-muted font-mono">{selectedTarget?.base_id}</p>
                    <div className="grid grid-cols-3 gap-3 pt-2">
                      {[
                        ['Products', pCount, selectedTarget?.p_table, Object.values(pCheckedFields).filter(Boolean).length],
                        ['Assets',   aCount, selectedTarget?.a_table, Object.values(aCheckedFields).filter(Boolean).length],
                        ['Work',     wCount, selectedTarget?.w_table, Object.values(wCheckedFields).filter(Boolean).length],
                      ].map(([label, count, table, extraCount]) => (
                        <div key={label} className="text-center">
                          <div className="text-lg font-semibold text-foreground">{count}</div>
                          <div className="text-xs text-muted">{label}</div>
                          <div className="text-xs text-muted italic">{table}</div>
                          {extraCount > 0 && (
                            <div className="text-xs text-primary mt-0.5">+{extraCount} fields</div>
                          )}
                        </div>
                      ))}
                    </div>
                    {(linkAtoP || linkWtoA) && (
                      <div className="pt-2 border-t border-border text-xs text-muted space-y-0.5">
                        {linkAtoP && <p>Assets → randomly linked to Products</p>}
                        {linkWtoA && <p>Work items → randomly linked to Assets</p>}
                      </div>
                    )}
                  </div>

                  {(pCount + aCount + wCount) > 300 && (
                    <p className="text-xs text-muted border border-border rounded-md px-3 py-2">
                      {pCount + aCount + wCount} records — may take 1–2 minutes due to Airtable rate limits.
                    </p>
                  )}
                </>
              )}

              {generating && (
                <div className="flex flex-col items-center gap-3 py-8">
                  <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs text-muted">Generating records in Airtable…</p>
                  {(pCount + aCount + wCount) > 300 && (
                    <p className="text-xs text-muted">This may take a minute.</p>
                  )}
                </div>
              )}

              {result && !generating && (
                result.error ? (
                  <div className="border border-error/40 bg-error/5 rounded-lg p-4 space-y-2">
                    <p className="text-xs font-medium text-error">Generation error</p>
                    <p className="text-xs text-muted">{result.error}</p>
                    {(result.products > 0 || result.assets > 0 || result.work > 0) && (
                      <p className="text-xs text-muted border-t border-border/40 pt-2">
                        Partial: {result.products} products, {result.assets} assets, {result.work} work items written.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="border border-border rounded-lg p-4">
                    <p className="text-xs font-medium text-foreground mb-3">Done</p>
                    <div className="grid grid-cols-3 gap-3">
                      {[['Products', result.products], ['Assets', result.assets], ['Work', result.work]].map(([label, count]) => (
                        <div key={label} className="text-center">
                          <div className="text-lg font-semibold text-foreground">{count}</div>
                          <div className="text-xs text-muted">{label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border shrink-0">
          <div>
            {step > 1 && !generating && !result && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="px-3 py-1.5 rounded-md text-xs text-muted hover:text-foreground"
              >
                ← Back
              </button>
            )}
          </div>

          <div>
            {step === 1 && selectedId && !showNewForm && (
              <button
                onClick={handleNextFromStep1}
                className="px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90"
              >
                Next →
              </button>
            )}

            {step === 2 && schema && !schemaLoading && (
              <button
                onClick={handleSaveMapping}
                disabled={!pTableId || !aTableId || !wTableId || !pPrimaryField || !aPrimaryField || !wPrimaryField || mappingSaving}
                className="px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {mappingSaving ? 'Saving…' : 'Save & Next →'}
              </button>
            )}

            {step === 3 && (
              <button
                onClick={() => setStep(4)}
                className="px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90"
              >
                Next →
              </button>
            )}

            {step === 4 && !result && !generating && (
              <button
                onClick={handleGenerate}
                className="px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90"
              >
                Generate
              </button>
            )}
            {step === 4 && result && (
              <button
                onClick={onClose}
                className="px-4 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90"
              >
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
