import { useState, useEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

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
  { type: 'product',   label: 'Product',   parent: null,      desc: 'Top-level grouping (e.g. Film, Game, Season)' },
  { type: 'asset',     label: 'Asset',     parent: 'product', desc: 'Individual piece of output.' },
  { type: 'work',      label: 'Work',      parent: 'asset',   desc: 'Unit of work attached to an asset' },
  { type: 'item_type', label: 'Item Type', parent: null,      optional: true, desc: 'Asset categories (e.g. Character, Prop, Vehicle). Use a separate lookup table or a select field on your asset table.' },
]

const OPERATORS = [
  { value: 'eq',       label: 'equals' },
  { value: 'neq',      label: 'does not equal' },
  { value: 'contains', label: 'contains' },
]

const SOURCES = [
  { id: 'airtable', label: 'Airtable',   live: true  },
  { id: 'jira',     label: 'JIRA',       live: true  },
  { id: 'shotgrid', label: 'ShotGrid',   live: false },
  { id: 'csv',      label: 'CSV Import', live: false },
]

const SOURCE_LABELS = { airtable: 'Airtable', jira: 'JIRA' }


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


// ── Step 0: Choose source ─────────────────────────────────────────────────────

function StepSelectSource({ onSelect }) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted text-sm">
        Choose the tool you want to connect as your project data source.
      </p>
      <div className="grid grid-cols-2 gap-3">
        {SOURCES.map(src => (
          <button
            key={src.id}
            onClick={src.live ? () => onSelect(src.id) : undefined}
            disabled={!src.live}
            className={`flex flex-col items-center justify-center gap-2 px-4 py-8 rounded-xl border text-sm font-medium transition-colors ${
              src.live
                ? 'border-border bg-surface-2 text-foreground hover:border-accent/60 hover:bg-surface-3 cursor-pointer'
                : 'border-border bg-surface-2 text-foreground opacity-40 cursor-not-allowed'
            }`}
          >
            <span>{src.label}</span>
            {!src.live && <span className="text-xs font-normal text-muted">Coming soon</span>}
          </button>
        ))}
      </div>
    </div>
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


// ── Step 1 (Airtable): Credentials ───────────────────────────────────────────

function StepCredentials({ onSuccess, onBack }) {
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
          source_type: 'airtable',
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
      <div className="flex gap-2 mt-2">
        {onBack && (
          <button type="button" onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        )}
        <button
          type="submit"
          disabled={loading || !apiToken || !baseId}
          className="flex-1 px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          {loading ? 'Testing connection…' : 'Test & Save'}
        </button>
      </div>
    </form>
  )
}


// ── Step 1 (Jira): OAuth ──────────────────────────────────────────────────────

function StepJiraOAuth({ onSuccess, onBack }) {
  const [searchParams] = useSearchParams()
  const [connected, setConnected] = useState(searchParams.get('jira') === 'connected')
  const [deployment, setDeployment] = useState('cloud')
  const [instanceUrl, setInstanceUrl] = useState('')
  const [dcClientId, setDcClientId] = useState('')
  const [dcClientSecret, setDcClientSecret] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // Instance picker — Cloud only, shown when > 1 accessible resource
  const [instances, setInstances] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [pickLoading, setPickLoading] = useState(false)
  const [disconnectLoading, setDisconnectLoading] = useState(false)

  useEffect(() => {
    if (!connected) {
      // Back-navigation: credentials may already be stored from a previous OAuth round
      apiFetch('/api/init/credentials', {
        method: 'POST',
        body: JSON.stringify({ source_type: 'jira', credentials: {} }),
      })
        .then(() => setConnected(true))
        .catch(() => {})
    }
  }, [])

  // After OAuth callback lands us here, fetch available instances for Cloud flows
  useEffect(() => {
    if (!connected) return
    apiFetch('/api/connectors/jira/oauth/instances')
      .then(res => {
        if (res.deployment !== 'cloud') return   // DC always single-instance, skip
        setInstances(res.instances)
        setSelectedId(res.selected_cloud_id)
        // Auto-select if only one — no picker needed
        if (res.instances.length <= 1 && res.instances[0]) {
          setSelectedId(res.instances[0].id)
        }
      })
      .catch(() => {}) // non-fatal — can still continue with whatever was stored
  }, [connected])

  async function initiateOAuth() {
    setLoading(true)
    setError(null)
    try {
      const body = { deployment }
      if (deployment === 'datacenter') {
        if (!instanceUrl.trim()) { setError('Jira instance URL is required'); setLoading(false); return }
        if (!dcClientId.trim())   { setError('Client ID is required');         setLoading(false); return }
        if (!dcClientSecret.trim()) { setError('Client Secret is required');   setLoading(false); return }
        body.instance_url    = instanceUrl.trim().replace(/\/$/, '')
        body.dc_client_id    = dcClientId.trim()
        body.dc_client_secret = dcClientSecret.trim()
      }
      const res = await apiFetch('/api/connectors/jira/oauth/initiate', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      window.location.href = res.url
    } catch (e) {
      setError(e.message)
      setLoading(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 rounded-md bg-surface border border-border text-foreground text-sm placeholder-muted focus:outline-none focus:border-accent'

  return (
    <div className="flex flex-col gap-5">
      {!connected ? (
        <>
          {/* Deployment selector */}
          <div className="flex flex-col gap-1.5">
            <span className="text-foreground text-sm font-medium">Jira deployment type</span>
            <div className="flex gap-2">
              {[
                { id: 'cloud',      label: 'Cloud',       sub: 'Hosted by Atlassian' },
                { id: 'datacenter', label: 'Data Center',  sub: 'Self-hosted instance' },
              ].map(opt => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDeployment(opt.id)}
                  className={`flex-1 flex flex-col items-start px-3 py-2.5 rounded-md border text-left transition-colors cursor-pointer
                    ${deployment === opt.id ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'}`}
                >
                  <span className={`text-sm font-medium ${deployment === opt.id ? 'text-accent' : 'text-foreground'}`}>{opt.label}</span>
                  <span className="text-muted text-xs">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          {deployment === 'cloud' && (
            <p className="text-muted text-sm">
              You will be redirected to Atlassian to authorise ArtHound using OAuth 2.0.
            </p>
          )}

          {deployment === 'datacenter' && (
            <div className="flex flex-col gap-3">
              <p className="text-muted text-sm">
                Create an Application Link on your Jira instance (<span className="text-foreground">Settings → Applications → Application Links</span>),
                then paste the credentials below.
              </p>
              <div className="flex flex-col gap-1">
                <label className="text-foreground text-xs font-medium">Jira instance URL</label>
                <input
                  className={inputCls}
                  placeholder="https://jira.yourstudio.com"
                  value={instanceUrl}
                  onChange={e => setInstanceUrl(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-foreground text-xs font-medium">Client ID</label>
                <input
                  className={inputCls}
                  placeholder="From Application Link → OAuth 2.0"
                  value={dcClientId}
                  onChange={e => setDcClientId(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-foreground text-xs font-medium">Client Secret</label>
                <input
                  type="password"
                  className={inputCls}
                  placeholder="Client secret"
                  value={dcClientSecret}
                  onChange={e => setDcClientSecret(e.target.value)}
                />
              </div>
            </div>
          )}

          {error && <p className="text-error text-sm">{error}</p>}
          <button
            onClick={initiateOAuth}
            disabled={loading}
            className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
          >
            {loading ? 'Redirecting…' : `Connect with JIRA ${deployment === 'datacenter' ? 'Data Center' : 'Cloud'}`}
          </button>
          <button type="button" onClick={onBack} className="self-start text-muted text-sm hover:text-foreground cursor-pointer">← Back</button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between px-3 py-2 bg-accent/10 border border-accent/30 rounded-md">
            <div className="flex items-center gap-2">
              <span className="text-accent text-sm">✓</span>
              <span className="text-foreground text-sm">Jira workspace connected</span>
            </div>
            <button
              type="button"
              disabled={disconnectLoading}
              onClick={async () => {
                setDisconnectLoading(true)
                setError(null)
                try {
                  await apiFetch('/api/connectors/jira/oauth/disconnect', { method: 'DELETE' })
                  setConnected(false)
                  setInstances([])
                  setSelectedId(null)
                } catch (e) {
                  setError(e.message)
                } finally {
                  setDisconnectLoading(false)
                }
              }}
              className="text-xs text-muted hover:text-error transition-colors cursor-pointer disabled:opacity-40"
            >
              {disconnectLoading ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </div>

          {/* Instance picker — only shown for Cloud with multiple sites */}
          {instances.length > 1 && (
            <div className="flex flex-col gap-2">
              <span className="text-foreground text-sm font-medium">Select your Jira site</span>
              <div className="flex flex-col gap-1.5">
                {instances.map(inst => (
                  <button
                    key={inst.id}
                    type="button"
                    onClick={() => setSelectedId(inst.id)}
                    className={`flex items-center justify-between px-3 py-2.5 rounded-md border text-left transition-colors cursor-pointer
                      ${selectedId === inst.id ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'}`}
                  >
                    <div>
                      <div className={`text-sm font-medium ${selectedId === inst.id ? 'text-accent' : 'text-foreground'}`}>{inst.name}</div>
                      <div className="text-muted text-xs">{inst.url}</div>
                    </div>
                    {selectedId === inst.id && <span className="text-accent text-sm">✓</span>}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-error text-sm">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
            <button
              disabled={instances.length > 1 && !selectedId || pickLoading}
              onClick={async () => {
                // If multi-instance and selection differs from stored, confirm it first
                if (instances.length > 1 && selectedId) {
                  setPickLoading(true)
                  setError(null)
                  try {
                    await apiFetch('/api/connectors/jira/oauth/select-instance', {
                      method: 'POST',
                      body: JSON.stringify({ cloud_id: selectedId }),
                    })
                  } catch (e) {
                    setError(e.message)
                    setPickLoading(false)
                    return
                  }
                }
                onSuccess()
              }}
              className="flex-1 px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
            >
              {pickLoading ? 'Saving…' : 'Continue'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}


// ── Step 2: Discover schema ───────────────────────────────────────────────────

function StepDiscover({ sourceType, onSuccess, onBack }) {
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
      const res = await apiFetch(`/api/init/discover?source_type=${sourceType}`, { method: 'POST' })
      setTables(res.tables)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const entityLabel = sourceType === 'jira' ? 'projects' : 'tables'
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
            Found <strong className="text-foreground">{tables.length} {entityLabel}</strong> and <strong className="text-foreground">{totalFields} fields</strong>.
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


// ── Step 3 (Airtable): EntityPanel ────────────────────────────────────────────

function EntityPanel({ entity, tables, definitions, onChange }) {
  const def = definitions[entity.type] || {}
  const parentDef = entity.parent ? definitions[entity.parent] : null
  const parentTableId = parentDef?.table_id || null

  const tableFields = tables.find(t => t.id === def.table_id)?.fields || []
  const validLinkFields = parentTableId ? linkFields(tableFields, parentTableId) : []

  const supportsFieldMode = entity.type !== 'asset'
  const mode = supportsFieldMode ? (def.mode || 'table') : 'table'
  const assetTableId = definitions.asset?.table_id
  const assetTableFields = assetTableId ? (tables.find(t => t.id === assetTableId)?.fields || []) : []

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
          source_type: 'airtable',
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

  const isComplete = entity.type === 'item_type'
    ? (mode === 'select_field' ? !!def.select_field_id : !!def.table_id)
    : !!def.table_id

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-4 transition-colors ${isComplete ? 'border-accent/40' : 'border-border'}`}>

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

      {supportsFieldMode && (
        <div className="flex rounded-md overflow-hidden border border-border text-xs">
          {[['table', 'Separate table'], ['select_field', 'Select field on assets']].map(([m, label]) => (
            <button
              key={m}
              onClick={() => update({ mode: m, table_id: '', table_name: '', filters: [], select_field_id: '', select_field_name: '' })}
              className={`flex-1 px-3 py-1.5 cursor-pointer transition-colors ${
                mode === m ? 'bg-accent text-white' : 'bg-surface-2 text-muted hover:bg-surface-3'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {supportsFieldMode && mode === 'select_field' && (
        <label className="flex flex-col gap-1.5">
          <span className="text-muted text-xs">Field on asset table</span>
          {!assetTableId ? (
            <p className="text-warning text-xs">Define the Asset entity first to see its fields.</p>
          ) : (
            <select
              value={def.select_field_id || ''}
              onChange={e => {
                const f = assetTableFields.find(f => f.id === e.target.value)
                update({ select_field_id: e.target.value, select_field_name: f?.name || '' })
              }}
              className="bg-surface-2 border border-border rounded-md px-2 py-1.5 text-foreground text-sm outline-none focus:border-accent"
            >
              <option value="">— select field —</option>
              {assetTableFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
        </label>
      )}

      {(!supportsFieldMode || mode === 'table') && (
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
      )}

      {def.table_id && mode === 'table' && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-muted text-xs">Filters <span className="opacity-60">(optional)</span></span>
            <button onClick={addFilter} className="text-xs text-accent hover:text-accent-hover cursor-pointer">+ Add filter</button>
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

      {def.table_id && mode === 'table' && (
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


// ── Step 3 (Jira): JiraEntityPanel ────────────────────────────────────────────

function JiraEntityPanel({ entity, projects, definitions, onChange }) {
  const saved = definitions[entity.type] || {}

  const [projectKey, setProjectKey] = useState(saved.table_id || '')
  const [issueType, setIssueType]   = useState(() => {
    const m = (saved.jql_filter || '').match(/issuetype\s*=\s*["']?([^"'\s),]+)["']?/i)
    return m ? m[1] : ''
  })
  const [advanced, setAdvanced]     = useState(false)
  const [jql, setJql]               = useState(saved.jql_filter || '')
  const [preview, setPreview]       = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewErr, setPreviewErr] = useState(null)

  const selectedProject = projects.find(p => p.id === projectKey)
  const issueTypes      = selectedProject?.issue_types || []
  const projectName     = selectedProject?.name || projectKey

  function buildJql(pk, it) {
    if (!pk) return ''
    return it ? `project = "${pk}" AND issuetype = "${it}"` : `project = "${pk}"`
  }

  function handleProjectChange(key) {
    setProjectKey(key)
    const proj = projects.find(p => p.id === key)
    const name = proj?.name || key
    if (!advanced) {
      const q = buildJql(key, issueType)
      setJql(q)
      onChange(entity.type, { table_id: key, table_name: name, jql_filter: q })
    } else {
      onChange(entity.type, { table_id: key, table_name: name, jql_filter: jql })
    }
  }

  function handleIssueTypeChange(it) {
    setIssueType(it)
    if (!advanced) {
      const q = buildJql(projectKey, it)
      setJql(q)
      onChange(entity.type, { table_id: projectKey, table_name: projectName, jql_filter: q })
    }
  }

  function handleAdvancedToggle() {
    if (advanced) {
      const q = buildJql(projectKey, issueType)
      setJql(q)
      onChange(entity.type, { table_id: projectKey, table_name: projectName, jql_filter: q })
    }
    setAdvanced(!advanced)
  }

  function handleJqlChange(q) {
    setJql(q)
    onChange(entity.type, { table_id: projectKey, table_name: projectName, jql_filter: q })
  }

  async function runPreview() {
    if (!jql.trim()) return
    setPreviewing(true)
    setPreviewErr(null)
    try {
      const res = await apiFetch('/api/init/preview-entity', {
        method: 'POST',
        body: JSON.stringify({
          source_type: 'jira',
          entity_type: entity.type,
          table_id:    projectKey || '',
          filters:     [],
          jql_filter:  jql,
        }),
      })
      setPreview(res)
    } catch (e) {
      setPreviewErr(e.message)
    } finally {
      setPreviewing(false)
    }
  }

  const isComplete = !!jql.trim()

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-4 transition-colors ${isComplete ? 'border-accent/40' : 'border-border'}`}>

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

      <label className="flex flex-col gap-1.5">
        <span className="text-muted text-xs">Project</span>
        <select
          value={projectKey}
          onChange={e => handleProjectChange(e.target.value)}
          className="bg-surface-2 border border-border rounded-md px-2 py-1.5 text-foreground text-sm outline-none focus:border-accent"
        >
          <option value="">— select project —</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>

      {!advanced && (
        <label className="flex flex-col gap-1.5">
          <span className="text-muted text-xs">Issue type <span className="opacity-60">(optional)</span></span>
          <select
            value={issueType}
            onChange={e => handleIssueTypeChange(e.target.value)}
            disabled={!projectKey}
            className="bg-surface-2 border border-border rounded-md px-2 py-1.5 text-foreground text-sm outline-none focus:border-accent disabled:opacity-50"
          >
            <option value="">— all issue types —</option>
            {issueTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        </label>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-muted text-xs">JQL</span>
          <button
            onClick={handleAdvancedToggle}
            className="text-xs text-accent hover:text-accent-hover cursor-pointer"
          >
            {advanced ? 'Guided mode' : 'Edit JQL'}
          </button>
        </div>
        <textarea
          value={jql}
          onChange={e => advanced && handleJqlChange(e.target.value)}
          readOnly={!advanced}
          rows={2}
          placeholder={`project = "KEY" AND issuetype = "Story"`}
          className={`bg-surface-2 border rounded-md px-3 py-2 text-sm font-mono outline-none resize-none ${
            advanced
              ? 'border-accent text-foreground focus:border-accent-hover'
              : 'border-border text-muted cursor-default'
          }`}
        />
        {advanced && (
          <span className="text-muted text-xs">
            Standard JQL. Example: <code className="font-mono">project = "GAME" AND issuetype = Story AND status != Done</code>
          </span>
        )}
      </div>

      {jql.trim() && (
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
              issue{preview.count !== 1 ? 's' : ''}
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


// ── Work field mapping ────────────────────────────────────────────────────────

const WORK_FIELD_SLOTS = [
  { key: 'work_name',       label: 'Work name',   required: true  },
  { key: 'work_status',     label: 'Status',      required: false },
  { key: 'work_start_date', label: 'Start date',  required: false },
  { key: 'work_end_date',   label: 'End date',    required: false },
  { key: 'work_estimate',   label: 'Estimate',    required: false },
]

const _WORK_NAME_HINTS     = /^(task|shot|work item|title|name)/i
const _WORK_STATUS_HINTS   = /status|state/i
const _WORK_START_HINTS    = /start/i
const _WORK_END_HINTS      = /end|finish|due/i
const _WORK_ESTIMATE_HINTS = /estimate|duration|days/i

function suggestWorkFields(fields) {
  const s = {}
  for (const f of fields) {
    const n = f.name
    if (!s.work_name       && _WORK_NAME_HINTS.test(n))     s.work_name       = f
    if (!s.work_status     && _WORK_STATUS_HINTS.test(n))   s.work_status     = f
    if (!s.work_start_date && _WORK_START_HINTS.test(n))    s.work_start_date = f
    if (!s.work_end_date   && _WORK_END_HINTS.test(n))      s.work_end_date   = f
    if (!s.work_estimate   && _WORK_ESTIMATE_HINTS.test(n)) s.work_estimate   = f
  }
  return s
}

function WorkFieldMappings({ tableFields, workFieldMap, onChange }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-muted text-xs">Work field mappings</span>
        <span className="text-muted text-xs opacity-60">* required</span>
      </div>
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <tbody>
            {WORK_FIELD_SLOTS.map(slot => (
              <tr key={slot.key} className="border-b border-border/50 last:border-0">
                <td className="px-3 py-2 text-foreground w-1/3">
                  {slot.label}{slot.required && <span className="text-error ml-0.5">*</span>}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={workFieldMap[slot.key]?.field_id || ''}
                    onChange={e => {
                      const f = tableFields.find(f => f.id === e.target.value)
                      onChange(slot.key, f ? { field_id: f.id, field_name: f.name } : null)
                    }}
                    className={`w-full bg-surface-2 border rounded-md px-2 py-1 text-foreground outline-none focus:border-accent ${
                      slot.required && !workFieldMap[slot.key] ? 'border-error/60' : 'border-border'
                    }`}
                  >
                    <option value="">— unmapped —</option>
                    {tableFields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}


// ── Auto-suggest utilities ────────────────────────────────────────────────────

const _PRODUCT_HINTS = /product|project|show|film|game|title|episode|series|season/
const _WORK_HINTS    = /task|work|shot|subtask|step|ticket/
const _TYPE_HINTS    = /type|category|kind|class/

function suggestEntitiesFromAsset(assetTableId, tables) {
  const assetTable = tables.find(t => t.id === assetTableId)
  if (!assetTable) return {}
  const s = {}
  for (const field of assetTable.fields) {
    if (field.type === 'multipleRecordLinks') {
      const linkedTableId = field.options?.linkedTableId
      const linkedTable = tables.find(t => t.id === linkedTableId)
      if (!linkedTable) continue
      const combined = (linkedTable.name + ' ' + field.name).toLowerCase()
      if (!s.product && _PRODUCT_HINTS.test(combined))
        s.product = { mode: 'table', table_id: linkedTableId, table_name: linkedTable.name, filters: [], rel_field_id: field.id, rel_field_name: field.name, rel_direction: 'child_holds_link' }
      if (!s.work && _WORK_HINTS.test(combined)) {
        // The link field we found is on the ASSET side. Find the symmetric field on
        // the work table that points back to the asset table (child_holds_link direction).
        // Airtable always creates a symmetric counterpart, so this almost always succeeds.
        const symField = linkedTable.fields?.find(
          f => f.type === 'multipleRecordLinks' && f.options?.linkedTableId === assetTableId
        )
        s.work = {
          mode: 'table',
          table_id:       linkedTableId,
          table_name:     linkedTable.name,
          filters:        [],
          rel_field_id:   symField ? symField.id   : field.id,
          rel_field_name: symField ? symField.name : field.name,
          rel_direction:  symField ? 'child_holds_link' : 'parent_holds_link',
        }
      }
    }
    if (field.type === 'singleSelect') {
      const fl = field.name.toLowerCase()
      if (!s.item_type && _TYPE_HINTS.test(fl))
        s.item_type = { mode: 'select_field', select_field_id: field.id, select_field_name: field.name }
      if (!s.product && _PRODUCT_HINTS.test(fl))
        s.product = { mode: 'select_field', select_field_id: field.id, select_field_name: field.name }
    }
  }
  return s
}


// ── Step 3 (Airtable): Define asset ──────────────────────────────────────────

const ASSET_ENTITY   = ENTITIES.find(e => e.type === 'asset')
const OTHER_ENTITIES = ENTITIES.filter(e => e.type !== 'asset')
const PARENT_ENTITIES = OTHER_ENTITIES.filter(e => e.type !== 'work')
const CHILD_ENTITIES  = OTHER_ENTITIES.filter(e => e.type === 'work')

function StepDefineAsset({ tables, initialDefs, onSuccess, onBack }) {
  const [definitions, setDefinitions] = useState(
    { product: {}, asset: {}, work: {}, item_type: {}, ...initialDefs }
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  useEffect(() => {
    apiFetch('/api/init/entity-definitions?source_type=airtable')
      .then(data => {
        if (data.asset) setDefinitions(prev => ({ ...prev, asset: data.asset }))
      })
      .catch(() => {})
  }, [])

  const assetDef   = definitions.asset || {}
  const isComplete = !!assetDef.table_id

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await apiFetch('/api/init/entity-definitions', {
        method: 'PUT',
        body: JSON.stringify({
          source_type:    'airtable',
          entity_type:    'asset',
          table_id:       assetDef.table_id,
          table_name:     assetDef.table_name,
          filters:        (assetDef.filters || []).filter(f => f.field_id && f.value),
          rel_field_id:   null,
          rel_field_name: null,
          rel_direction:  null,
        }),
      })
      const suggestions = suggestEntitiesFromAsset(assetDef.table_id, tables)
      onSuccess(assetDef, suggestions)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted text-sm">
        Define how an Asset is tracked in your data. This will help us understand
        your data structure for the next steps and help us map this against
        ArtHound's structure.
      </p>
      <EntityPanel
        entity={ASSET_ENTITY}
        tables={tables}
        definitions={definitions}
        onChange={(type, def) => setDefinitions(prev => ({ ...prev, [type]: def }))}
      />
      {error && <p className="text-error text-sm">{error}</p>}
      <div className="flex items-center justify-between pt-1">
        <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        <button
          onClick={save}
          disabled={saving || !isComplete}
          className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}


// ── Step 4 (Airtable): Define other entities ──────────────────────────────────

function StepDefineEntities({ tables, initialDefs, onSuccess, onBack }) {
  const [definitions, setDefinitions] = useState(
    { product: {}, asset: {}, work: {}, item_type: {}, ...initialDefs }
  )
  const [workSkipped,  setWorkSkipped]  = useState(false)
  const [workFieldMap, setWorkFieldMap] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  const hasSuggestions = OTHER_ENTITIES.some(e => {
    const def = initialDefs?.[e.type]
    return def?.table_id || def?.select_field_id
  })

  useEffect(() => {
    apiFetch('/api/init/entity-definitions?source_type=airtable')
      .then(data => {
        setDefinitions(prev => {
          const merged = { ...prev }
          for (const [k, v] of Object.entries(data)) {
            if (k !== 'asset') merged[k] = v
          }
          return merged
        })
        const w = data.work
        if (w) {
          setWorkFieldMap(prev => {
            const next = { ...prev }
            const pairs = [
              ['work_name',       w.work_name_field_id,       w.work_name_field_name],
              ['work_status',     w.work_status_field_id,     w.work_status_field_name],
              ['work_start_date', w.work_start_date_field_id, w.work_start_date_field_name],
              ['work_end_date',   w.work_end_date_field_id,   w.work_end_date_field_name],
              ['work_estimate',   w.work_estimate_field_id,   w.work_estimate_field_name],
            ]
            for (const [key, fid, fname] of pairs) {
              if (fid && !next[key]) next[key] = { field_id: fid, field_name: fname }
            }
            return next
          })
        }
      })
      .catch(() => {})
  }, [])

  function updateDef(type, def) {
    setDefinitions(prev => ({ ...prev, [type]: def }))
    if (type === 'work' && def.table_id) {
      const tableFields = tables.find(t => t.id === def.table_id)?.fields || []
      const suggestions = suggestWorkFields(tableFields)
      setWorkFieldMap(prev => {
        const next = { ...prev }
        for (const [key, f] of Object.entries(suggestions)) {
          if (!next[key]) next[key] = { field_id: f.id, field_name: f.name }
        }
        return next
      })
    }
  }

  const parentComplete = PARENT_ENTITIES.every(e => {
    if (e.optional) return true
    const def = definitions[e.type] || {}
    return def.mode === 'select_field' ? !!def.select_field_id : !!def.table_id
  })
  const workComplete = workSkipped || (
    !!(definitions.work?.table_id) && !!(workFieldMap.work_name?.field_id)
  )
  const allComplete  = parentComplete && workComplete

  async function save() {
    setSaving(true)
    setError(null)
    try {
      for (const entity of PARENT_ENTITIES) {
        const def = definitions[entity.type]
        if (def?.mode === 'select_field') continue
        if (!def?.table_id) continue
        await apiFetch('/api/init/entity-definitions', {
          method: 'PUT',
          body: JSON.stringify({
            source_type:    'airtable',
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
      if (!workSkipped) {
        const def = definitions.work
        if (def?.table_id) {
          const fm = workFieldMap
          await apiFetch('/api/init/entity-definitions', {
            method: 'PUT',
            body: JSON.stringify({
              source_type:                'airtable',
              entity_type:                'work',
              table_id:                   def.table_id,
              table_name:                 def.table_name,
              filters:                    (def.filters || []).filter(f => f.field_id && f.value),
              rel_field_id:               def.rel_field_id || null,
              rel_field_name:             def.rel_field_name || null,
              rel_direction:              def.rel_direction || null,
              work_name_field_id:         fm.work_name?.field_id        || null,
              work_name_field_name:       fm.work_name?.field_name      || null,
              work_status_field_id:       fm.work_status?.field_id      || null,
              work_status_field_name:     fm.work_status?.field_name    || null,
              work_start_date_field_id:   fm.work_start_date?.field_id  || null,
              work_start_date_field_name: fm.work_start_date?.field_name || null,
              work_end_date_field_id:     fm.work_end_date?.field_id    || null,
              work_end_date_field_name:   fm.work_end_date?.field_name  || null,
              work_estimate_field_id:     fm.work_estimate?.field_id    || null,
              work_estimate_field_name:   fm.work_estimate?.field_name  || null,
              field_mappings:             {},
            }),
          })
        }
      }
      onSuccess(definitions)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const assetTableName = definitions.asset?.table_name || 'Asset'

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted text-sm">
        {hasSuggestions
          ? 'We\'ve pre-filled suggestions based on your asset table — review and adjust as needed.'
          : 'Define what groups your assets and what work items live under them.'}
      </p>

      <div className="flex items-center gap-2 text-xs text-muted px-1">
        <span>Parent</span>
        <span className="text-border">↓</span>
        <span className="text-foreground font-medium px-1.5 py-0.5 rounded bg-surface-2 border border-border">{assetTableName}</span>
        <span className="text-border">↓</span>
        <span>Child</span>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted uppercase tracking-wide">Parent level</p>
        {PARENT_ENTITIES.map(entity => (
          <EntityPanel
            key={entity.type}
            entity={entity}
            tables={tables}
            definitions={definitions}
            onChange={updateDef}
          />
        ))}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted uppercase tracking-wide">Child level</p>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={workSkipped}
              onChange={e => setWorkSkipped(e.target.checked)}
              className="accent-accent"
            />
            <span className="text-xs text-muted">No work in source</span>
          </label>
        </div>
        {workSkipped ? (
          <p className="text-muted text-xs px-1">
            Work skipped — ArtHound-generated work will still work.
          </p>
        ) : (
          <>
            {CHILD_ENTITIES.map(entity => (
              <EntityPanel
                key={entity.type}
                entity={entity}
                tables={tables}
                definitions={definitions}
                onChange={updateDef}
              />
            ))}
            {definitions.work?.table_id && (() => {
              const workTableFields = tables.find(t => t.id === definitions.work.table_id)?.fields || []
              return (
                <WorkFieldMappings
                  tableFields={workTableFields}
                  workFieldMap={workFieldMap}
                  onChange={(key, val) => setWorkFieldMap(prev => ({ ...prev, [key]: val }))}
                />
              )
            })()}
          </>
        )}
      </div>

      {error && <p className="text-error text-sm">{error}</p>}
      <div className="flex items-center justify-between pt-1">
        <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        <div className="flex items-center gap-3">
          <p className="text-muted text-xs">
            {allComplete ? 'Structure defined' : 'Define required entities to continue'}
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


// ── Step 3 (Jira): Define asset ───────────────────────────────────────────────

function StepJiraDefineAsset({ tables, initialDefs, onSuccess, onBack }) {
  const [definitions, setDefinitions] = useState(
    { product: {}, asset: {}, work: {}, item_type: {}, ...initialDefs }
  )
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState(null)

  useEffect(() => {
    apiFetch('/api/init/entity-definitions?source_type=jira')
      .then(data => {
        if (data.asset) setDefinitions(prev => ({ ...prev, asset: data.asset }))
      })
      .catch(() => {})
  }, [])

  const assetDef   = definitions.asset || {}
  const isComplete = !!(assetDef.jql_filter || assetDef.table_id)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      await apiFetch('/api/init/entity-definitions', {
        method: 'PUT',
        body: JSON.stringify({
          source_type:    'jira',
          entity_type:    'asset',
          table_id:       assetDef.table_id || '',
          table_name:     assetDef.table_name || '',
          filters:        [],
          jql_filter:     assetDef.jql_filter || null,
          rel_field_id:   null,
          rel_field_name: null,
          rel_direction:  null,
        }),
      })
      onSuccess(assetDef)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted text-sm">
        Define which Jira issues represent assets using a project and issue type, or write a custom JQL query.
      </p>
      <JiraEntityPanel
        entity={ASSET_ENTITY}
        projects={tables}
        definitions={definitions}
        onChange={(type, def) => setDefinitions(prev => ({ ...prev, [type]: def }))}
      />
      {error && <p className="text-error text-sm">{error}</p>}
      <div className="flex items-center justify-between pt-1">
        <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        <button
          onClick={save}
          disabled={saving || !isComplete}
          className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </div>
  )
}


// ── Step 4 (Jira): Item type panel ───────────────────────────────────────────
// Item types in Jira are almost always field values (Components, Priority, etc.)
// rather than a separate issue type. This panel offers both modes.

function JiraItemTypePanel({ tables, definitions, onChange }) {
  const saved  = definitions['item_type'] || {}
  const fields = (tables[0]?.fields || [])
    .filter(f => !f.id.startsWith('_jira_'))
    .sort((a, b) => a.name.localeCompare(b.name))

  const [mode,      setMode]      = useState(saved.item_type_source || 'field_values')
  const [fieldId,   setFieldId]   = useState(saved.item_type_field_id   || '')
  const [fieldName, setFieldName] = useState(saved.item_type_field_name || '')

  // Issues-mode state (mirrors JiraEntityPanel for the inline branch)
  const [projectKey, setProjectKey] = useState(saved.table_id && saved.table_id !== '_field' ? saved.table_id : '')
  const [issueType,  setIssueType]  = useState(() => {
    const m = (saved.jql_filter || '').match(/issuetype\s*=\s*["']?([^"'\s),]+)["']?/i)
    return m ? m[1] : ''
  })
  const [advanced, setAdvanced] = useState(false)
  const [jql, setJql] = useState(saved.jql_filter || '')
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewErr, setPreviewErr] = useState(null)

  const projects     = tables
  const selProject   = projects.find(p => p.id === projectKey)
  const issueTypes   = selProject?.issue_types || []
  const projectName  = selProject?.name || projectKey

  function buildJql(pk, it) {
    if (!pk) return ''
    return it ? `project = "${pk}" AND issuetype = "${it}"` : `project = "${pk}"`
  }

  function handleModeSwitch(m) {
    setMode(m)
    if (m === 'field_values') {
      onChange('item_type', { item_type_source: 'field_values', item_type_field_id: fieldId, item_type_field_name: fieldName, table_id: '_field', table_name: fieldName })
    } else {
      onChange('item_type', { item_type_source: 'issues', table_id: projectKey, table_name: projectName, jql_filter: jql })
    }
  }

  function handleFieldChange(id) {
    const f = fields.find(f => f.id === id)
    const name = f?.name || id
    setFieldId(id)
    setFieldName(name)
    onChange('item_type', { item_type_source: 'field_values', item_type_field_id: id, item_type_field_name: name, table_id: '_field', table_name: name })
  }

  function handleProjectChange(key) {
    setProjectKey(key)
    const proj = projects.find(p => p.id === key)
    const name = proj?.name || key
    if (!advanced) {
      const q = buildJql(key, issueType)
      setJql(q)
      onChange('item_type', { item_type_source: 'issues', table_id: key, table_name: name, jql_filter: q })
    } else {
      onChange('item_type', { item_type_source: 'issues', table_id: key, table_name: name, jql_filter: jql })
    }
  }

  function handleIssueTypeChange(it) {
    setIssueType(it)
    if (!advanced) {
      const q = buildJql(projectKey, it)
      setJql(q)
      onChange('item_type', { item_type_source: 'issues', table_id: projectKey, table_name: projectName, jql_filter: q })
    }
  }

  function handleJqlChange(q) {
    setJql(q)
    onChange('item_type', { item_type_source: 'issues', table_id: projectKey, table_name: projectName, jql_filter: q })
  }

  async function runPreview() {
    if (!jql.trim()) return
    setPreviewing(true); setPreviewErr(null)
    try {
      const res = await apiFetch('/api/init/preview-entity', {
        method: 'POST',
        body: JSON.stringify({ source_type: 'jira', entity_type: 'item_type', table_id: projectKey || '', filters: [], jql_filter: jql }),
      })
      setPreview(res)
    } catch (e) { setPreviewErr(e.message) }
    finally { setPreviewing(false) }
  }

  const isComplete = mode === 'field_values' ? !!fieldId : !!jql.trim()
  const selCls = 'bg-surface-2 border border-border rounded-md px-2 py-1.5 text-foreground text-sm outline-none focus:border-accent'

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-4 transition-colors ${isComplete ? 'border-accent/40' : 'border-border'}`}>
      <div>
        <p className="text-foreground text-sm font-semibold flex items-center gap-2">
          Item Type
          {!isComplete && <span className="text-muted text-xs font-normal">(optional)</span>}
          {isComplete  && <span className="text-accent text-xs">✓</span>}
        </p>
        <p className="text-muted text-xs">Asset categories (e.g. Character, Prop, Vehicle).</p>
      </div>

      <div className="flex gap-2">
        {[
          { id: 'field_values', label: 'Field on assets', sub: 'e.g. Components, Priority' },
          { id: 'issues',       label: 'Jira issues',     sub: 'Separate issue type via JQL' },
        ].map(opt => (
          <button key={opt.id} type="button" onClick={() => handleModeSwitch(opt.id)}
            className={`flex-1 flex flex-col items-start px-3 py-2 rounded-md border text-left transition-colors cursor-pointer
              ${mode === opt.id ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50'}`}
          >
            <span className={`text-xs font-medium ${mode === opt.id ? 'text-accent' : 'text-foreground'}`}>{opt.label}</span>
            <span className="text-muted text-xs">{opt.sub}</span>
          </button>
        ))}
      </div>

      {mode === 'field_values' ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-muted text-xs">Field</span>
          <select value={fieldId} onChange={e => handleFieldChange(e.target.value)} className={selCls}>
            <option value="">— select field —</option>
            {fields.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {fieldId && (
            <p className="text-muted text-xs">
              Distinct values of <span className="text-foreground">{fieldName || fieldId}</span> will become item types at sync time.
            </p>
          )}
        </label>
      ) : (
        <>
          <label className="flex flex-col gap-1.5">
            <span className="text-muted text-xs">Project</span>
            <select value={projectKey} onChange={e => handleProjectChange(e.target.value)} className={selCls}>
              <option value="">— select project —</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {!advanced && (
            <label className="flex flex-col gap-1.5">
              <span className="text-muted text-xs">Issue type <span className="opacity-60">(optional)</span></span>
              <select value={issueType} onChange={e => handleIssueTypeChange(e.target.value)} disabled={!projectKey} className={selCls + ' disabled:opacity-50'}>
                <option value="">— all types —</option>
                {issueTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
              </select>
            </label>
          )}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-muted text-xs">JQL</span>
              <button type="button" onClick={() => { setAdvanced(!advanced); if (advanced) { const q = buildJql(projectKey, issueType); setJql(q); handleJqlChange(q) } }} className="text-accent text-xs cursor-pointer hover:underline">
                {advanced ? 'Simple' : 'Edit JQL'}
              </button>
            </div>
            <textarea
              value={jql}
              readOnly={!advanced}
              onChange={e => handleJqlChange(e.target.value)}
              rows={2}
              className={`w-full px-3 py-2 rounded-md bg-surface-2 border border-border text-foreground text-xs font-mono outline-none focus:border-accent resize-none ${!advanced ? 'text-muted' : ''}`}
            />
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={runPreview} disabled={!jql.trim() || previewing}
              className="px-3 py-1.5 rounded-md bg-surface-2 border border-border text-foreground text-xs hover:border-accent/50 transition-colors cursor-pointer disabled:opacity-40">
              {previewing ? 'Previewing…' : 'Preview'}
            </button>
            {preview && !previewErr && (
              <span className="text-muted text-xs">{preview.count} record{preview.count !== 1 ? 's' : ''}{preview.has_more ? '+' : ''}{preview.samples?.length ? ` — ${preview.samples.join(', ')}` : ''}</span>
            )}
            {previewErr && <span className="text-error text-xs">{previewErr}</span>}
          </div>
        </>
      )}
    </div>
  )
}


// ── Step 4 (Jira): Define other entities ──────────────────────────────────────

function StepJiraDefineEntities({ tables, initialDefs, onSuccess, onBack }) {
  const [definitions, setDefinitions] = useState(
    { product: {}, asset: {}, work: {}, item_type: {}, ...initialDefs }
  )
  const [workSkipped, setWorkSkipped] = useState(false)
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  useEffect(() => {
    apiFetch('/api/init/entity-definitions?source_type=jira')
      .then(data => {
        setDefinitions(prev => {
          const merged = { ...prev }
          for (const [k, v] of Object.entries(data)) {
            merged[k] = v
          }
          return merged
        })
      })
      .catch(() => {})
  }, [])

  function updateDef(type, def) {
    setDefinitions(prev => ({ ...prev, [type]: def }))
  }

  const productDef  = definitions.product   || {}
  const workDef     = definitions.work      || {}
  const itemTypeDef = definitions.item_type || {}

  const productComplete  = !!(productDef.jql_filter || productDef.table_id)
  const workComplete     = workSkipped || !!(workDef.jql_filter || workDef.table_id)
  const allComplete      = productComplete && workComplete

  async function save() {
    setSaving(true)
    setError(null)
    try {
      if (productDef.table_id || productDef.jql_filter) {
        await apiFetch('/api/init/entity-definitions', {
          method: 'PUT',
          body: JSON.stringify({
            source_type:    'jira',
            entity_type:    'product',
            table_id:       productDef.table_id  || '',
            table_name:     productDef.table_name || '',
            filters:        [],
            jql_filter:     productDef.jql_filter || null,
            rel_field_id:   null,
            rel_field_name: null,
            rel_direction:  null,
          }),
        })
        // Update asset entity to record that its "parent" field links up to the product
        const assetDef = definitions.asset || {}
        if (assetDef.table_id || assetDef.jql_filter) {
          await apiFetch('/api/init/entity-definitions', {
            method: 'PUT',
            body: JSON.stringify({
              source_type:    'jira',
              entity_type:    'asset',
              table_id:       assetDef.table_id   || '',
              table_name:     assetDef.table_name || '',
              filters:        [],
              jql_filter:     assetDef.jql_filter || null,
              rel_field_id:   'parent',
              rel_field_name: 'Parent',
              rel_direction:  'child_holds_link',
            }),
          })
        }
      }
      if (!workSkipped && (workDef.table_id || workDef.jql_filter)) {
        await apiFetch('/api/init/entity-definitions', {
          method: 'PUT',
          body: JSON.stringify({
            source_type:    'jira',
            entity_type:    'work',
            table_id:       workDef.table_id  || '',
            table_name:     workDef.table_name || '',
            filters:        [],
            jql_filter:     workDef.jql_filter || null,
            rel_field_id:   null,
            rel_field_name: 'parent',
            rel_direction:  'child_holds_link',
          }),
        })
      }
      const hasItemType = itemTypeDef.item_type_source === 'field_values'
        ? !!itemTypeDef.item_type_field_id
        : !!(itemTypeDef.table_id || itemTypeDef.jql_filter)
      if (hasItemType) {
        await apiFetch('/api/init/entity-definitions', {
          method: 'PUT',
          body: JSON.stringify({
            source_type:          'jira',
            entity_type:          'item_type',
            table_id:             itemTypeDef.table_id   || '',
            table_name:           itemTypeDef.table_name || '',
            filters:              [],
            jql_filter:           itemTypeDef.jql_filter || null,
            rel_field_id:         null,
            rel_field_name:       null,
            rel_direction:        null,
            item_type_source:     itemTypeDef.item_type_source     || 'issues',
            item_type_field_id:   itemTypeDef.item_type_field_id   || null,
            item_type_field_name: itemTypeDef.item_type_field_name || null,
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
    <div className="flex flex-col gap-5">
      <p className="text-muted text-sm">
        Map Products, Work, and Item Types to Jira issue types using JQL queries.
      </p>

      <div className="flex flex-col gap-3">
        <p className="text-xs text-muted uppercase tracking-wide">Parent level</p>
        <JiraEntityPanel
          entity={ENTITIES.find(e => e.type === 'product')}
          projects={tables}
          definitions={definitions}
          onChange={updateDef}
        />
        <JiraItemTypePanel
          tables={tables}
          definitions={definitions}
          onChange={updateDef}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted uppercase tracking-wide">Child level</p>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={workSkipped}
              onChange={e => setWorkSkipped(e.target.checked)}
              className="accent-accent"
            />
            <span className="text-xs text-muted">No work in source</span>
          </label>
        </div>
        {workSkipped ? (
          <p className="text-muted text-xs px-1">Work skipped — ArtHound-generated work will still work.</p>
        ) : (
          <JiraEntityPanel
            entity={ENTITIES.find(e => e.type === 'work')}
            projects={tables}
            definitions={definitions}
            onChange={updateDef}
          />
        )}
      </div>

      {error && <p className="text-error text-sm">{error}</p>}
      <div className="flex items-center justify-between pt-1">
        <button onClick={onBack} className="px-4 py-2 rounded-md bg-surface-2 text-foreground text-sm font-medium hover:bg-surface-3 transition-colors cursor-pointer">Back</button>
        <div className="flex items-center gap-3">
          <p className="text-muted text-xs">
            {allComplete ? 'Structure defined' : 'Define required entities to continue'}
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


// ── Step 5: Map fields ────────────────────────────────────────────────────────

function StepMapFields({ sourceType, sourceFields, presetSlotFields, onSuccess, onBack }) {
  const [assignments, setAssignments] = useState({})
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState(null)

  useEffect(() => {
    apiFetch(`/api/init/field-mappings?source_type=${sourceType}`)
      .then(data => {
        const a = {}
        for (const m of data.mappings) {
          if (m.arthound_slot) a[m.arthound_slot] = m.source_field_id
        }
        for (const [slot, fieldId] of Object.entries(presetSlotFields || {})) {
          if (fieldId && !a[slot]) a[slot] = fieldId
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
        body: JSON.stringify({ source_type: sourceType, mappings }),
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


// ── Step 6: Review ────────────────────────────────────────────────────────────

function StepReview({ sourceType, definitions, isReset, onStart, onBack }) {
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  async function start() {
    setLoading(true)
    setError(null)
    try {
      const endpoint = isReset ? '/api/init/reset' : '/api/init/start'
      const res = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify({ source_type: sourceType }),
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
          <span className="text-foreground text-sm font-medium">{SOURCE_LABELS[sourceType] || sourceType}</span>
        </div>
        {ENTITIES.map(e => {
          const def = definitions[e.type]
          const isSelectField = e.type !== 'asset' && def?.mode === 'select_field'
          const isJql = sourceType === 'jira' && def?.jql_filter
          return (
            <div key={e.type} className="flex justify-between px-4 py-3">
              <span className="text-muted text-sm">{e.label}</span>
              <span className="text-foreground text-sm font-medium">
                {isJql
                  ? <span className="font-mono text-xs">{def.jql_filter.length > 40 ? def.jql_filter.slice(0, 40) + '…' : def.jql_filter}</span>
                  : isSelectField
                  ? <>{def.select_field_name || '—'} <span className="text-muted text-xs font-normal">(field)</span></>
                  : def?.table_name || '—'
                }
                {!isJql && !isSelectField && def?.filters?.length > 0 && (
                  <span className="text-muted text-xs ml-1">({def.filters.length} filter{def.filters.length > 1 ? 's' : ''})</span>
                )}
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
          This will delete all replicated assets, products, and work items and re-import from scratch.
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


// ── Step 7: Progress ──────────────────────────────────────────────────────────

function StepProgress({ jobId, onComplete, onBack }) {
  const [job, setJob]   = useState(null)
  const intervalRef     = useRef(null)

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


// ── Step 8: Done ──────────────────────────────────────────────────────────────

function StepDone({ sourceType, recordCount, isReset }) {
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
          {recordCount} asset{recordCount !== 1 ? 's' : ''} synced from {SOURCE_LABELS[sourceType] || sourceType}.
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
  'Choose source',
  'Connect source',
  'Discover schema',
  'Define assets',
  'Define structure',
  'Map fields',
  'Review',
  'Syncing',
  'Done',
]
const TOTAL_STEPS = STEP_TITLES.length

export default function ProjectInit() {
  const [searchParams]  = useSearchParams()
  const isReset = searchParams.get('reset') === '1'

  const [sourceType, setSourceType] = useState(
    () => searchParams.get('jira') === 'connected' ? 'jira' : 'airtable'
  )
  const [step, setStep]               = useState(() => {
    if (isReset) return 2
    if (searchParams.get('jira') === 'connected') return 2
    return 1
  })
  const [tables, setTables]           = useState([])
  const [definitions, setDefinitions] = useState({ product: {}, asset: {}, work: {}, item_type: {} })
  const [sourceFields, setSourceFields] = useState([])
  const [jobId, setJobId]             = useState(null)
  const [recordCount, setRecordCount] = useState(0)

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
          onNavigate={step < 8 ? setStep : undefined}
        />

        <div className="bg-surface border border-border rounded-xl p-6">
          {step === 1 && (
            <StepSelectSource onSelect={id => { setSourceType(id); setStep(2) }} />
          )}
          {step === 2 && sourceType === 'airtable' && (
            <StepCredentials
              onSuccess={() => setStep(3)}
              onBack={() => setStep(1)}
            />
          )}
          {step === 2 && sourceType === 'jira' && (
            <StepJiraOAuth
              onSuccess={() => setStep(3)}
              onBack={() => setStep(1)}
            />
          )}
          {step === 3 && (
            <StepDiscover
              sourceType={sourceType}
              onSuccess={t => { setTables(t); setSourceFields(t[0]?.fields || []); setStep(4) }}
              onBack={() => setStep(2)}
            />
          )}
          {step === 4 && sourceType === 'airtable' && (
            <StepDefineAsset
              tables={tables}
              initialDefs={definitions}
              onSuccess={(assetDef, suggestions) => {
                setDefinitions(prev => ({ ...prev, asset: assetDef, ...suggestions }))
                setStep(5)
              }}
              onBack={() => setStep(3)}
            />
          )}
          {step === 4 && sourceType === 'jira' && (
            <StepJiraDefineAsset
              tables={tables}
              initialDefs={definitions}
              onSuccess={assetDef => {
                setDefinitions(prev => ({ ...prev, asset: assetDef }))
                setStep(5)
              }}
              onBack={() => setStep(3)}
            />
          )}
          {step === 5 && sourceType === 'airtable' && (
            <StepDefineEntities
              tables={tables}
              initialDefs={definitions}
              onSuccess={defs => { setDefinitions(defs); setStep(6) }}
              onBack={() => setStep(4)}
            />
          )}
          {step === 5 && sourceType === 'jira' && (
            <StepJiraDefineEntities
              tables={tables}
              initialDefs={definitions}
              onSuccess={defs => { setDefinitions(defs); setStep(6) }}
              onBack={() => setStep(4)}
            />
          )}
          {step === 6 && (
            <StepMapFields
              sourceType={sourceType}
              sourceFields={getAssetFields()}
              presetSlotFields={sourceType === 'airtable' ? Object.fromEntries(
                ['item_type', 'product'].flatMap(slot => {
                  const def = definitions[slot]
                  if (def?.mode === 'select_field' && def.select_field_id)
                    return [[slot, def.select_field_id]]
                  if ((!def?.mode || def.mode === 'table') && def?.rel_field_id)
                    return [[slot, def.rel_field_id]]
                  return []
                })
              ) : {}}
              onSuccess={() => setStep(7)}
              onBack={() => setStep(5)}
            />
          )}
          {step === 7 && (
            <StepReview
              sourceType={sourceType}
              definitions={definitions}
              isReset={isReset}
              onStart={id => { setJobId(id); setStep(8) }}
              onBack={() => setStep(6)}
            />
          )}
          {step === 8 && (
            <StepProgress
              jobId={jobId}
              onComplete={count => { setRecordCount(count); setStep(9) }}
              onBack={() => setStep(7)}
            />
          )}
          {step === 9 && (
            <StepDone sourceType={sourceType} recordCount={recordCount} isReset={isReset} />
          )}
        </div>
      </div>
    </div>
  )
}
