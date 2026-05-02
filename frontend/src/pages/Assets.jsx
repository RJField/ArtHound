import { useState, useEffect, useRef, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch, makeRecordResolver } from '../lib/api'
import { fmtDate, formatRawFields, fieldDisplayString, LINKED_TABLE_MAP } from '../lib/fields'
import { useAppState } from '../contexts/AppContext'
import DetailModal from '../components/DetailModal'
import SendVendorModal from '../components/SendVendorModal'
import SchemaModal from '../components/SchemaModal'
import FieldSettingsModal, {
  BUILTIN_FIELDS, DEFAULT_BUILTINS, loadFieldSettings,
} from '../components/FieldSettingsModal'
import { cn } from '../lib/utils'

// ── Meta field helpers ────────────────────────────────────────────────────

function getBuiltinValue(asset, key) {
  if (key === 'priority')    return asset.priority != null ? `P${asset.priority}` : null
  if (key === 'projectDate') return asset.projectDate ? fmtDate(asset.projectDate.slice(0, 10)) : null
  return asset[key] ?? null
}

function buildMetaFields(asset) {
  if (!asset) return []
  const settings       = loadFieldSettings()
  const enabledBuiltins = settings ? settings.builtins : DEFAULT_BUILTINS
  const extras         = settings ? (settings.extras || []) : []

  return [
    ...BUILTIN_FIELDS
      .filter(f => enabledBuiltins.includes(f.key))
      .map(f => {
        const value = getBuiltinValue(asset, f.key)
        if (f.key === 'product' && asset.productId && value) {
          return { label: f.label, value, type: 'linked-record', resolve: makeRecordResolver('products', asset.productId, value) }
        }
        return { label: f.label, value }
      })
      .filter(f => f.value != null && f.value !== ''),
    ...extras.flatMap(fname => {
      const v = asset.rawFields?.[fname]
      if (v == null || v === '') return []
      return formatRawFields({ [fname]: v })
    }),
  ]
}

// ── Task detail ───────────────────────────────────────────────────────────

async function fetchTaskModalProps(taskId, taskName) {
  const { fields, displayFields = {} } = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}`)
  const SKIP = new Set(['Task'])
  const entries = []

  for (const [k, v] of Object.entries(fields)) {
    if (SKIP.has(k) || v == null || v === '') continue

    const isCanonical = Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && 'source_id' in v[0]
    const isRawRec    = !isCanonical && Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string' && x.startsWith('rec'))

    if (isCanonical || isRawRec) {
      const tableKey   = LINKED_TABLE_MAP[k]
      const sourceId   = isCanonical ? v[0].source_id : v[0]
      const resolved   = isCanonical ? v.map(x => x.display_name || '').filter(Boolean).join(', ') : null

      if (tableKey && v.length === 1) {
        const displayName = displayFields[k] || resolved || sourceId
        entries.push({ label: k, value: displayName, type: 'linked-record', resolve: makeRecordResolver(tableKey, sourceId, displayName) })
      } else {
        const display = displayFields[k] || resolved || (tableKey ? `${v.length} linked record${v.length !== 1 ? 's' : ''}` : v.join(', '))
        entries.push({ label: k, value: display })
      }
    } else {
      const display = (displayFields[k] != null && displayFields[k] !== '')
        ? displayFields[k]
        : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
          ? fmtDate(v.slice(0, 10))
          : fieldDisplayString(v)
      entries.push({ label: k, value: display })
    }
  }

  return { title: taskName, fields: entries.length ? entries : [{ label: 'No fields', value: null }] }
}

// ── Timeline ──────────────────────────────────────────────────────────────

function TasksTimeline({ tasks }) {
  const dated = tasks
    .filter(t => t.startDate && t.endDate)
    .map(t => ({ ...t, start: new Date(t.startDate), end: new Date(t.endDate) }))

  if (!dated.length) return <p className="text-muted text-xs p-3">No dated tasks to display.</p>

  const minMs   = Math.min(...dated.map(t => t.start.getTime()))
  const maxMs   = Math.max(...dated.map(t => t.end.getTime()))
  const rangeMs = maxMs - minMs || 1
  const pct     = ms    => ((ms - minMs) / rangeMs * 100).toFixed(2)
  const wPct    = (s, e) => ((e - s) / rangeMs * 100).toFixed(2)
  const now     = Date.now()

  // Month labels
  const months = []
  const cursor = new Date(new Date(minMs).getFullYear(), new Date(minMs).getMonth(), 1)
  while (cursor.getTime() <= maxMs) {
    months.push({ label: cursor.toLocaleString('default', { month: 'short', year: 'numeric' }), pct: Math.max(0, pct(cursor.getTime())) })
    cursor.setMonth(cursor.getMonth() + 1)
  }

  const showToday = now >= minMs && now <= maxMs

  return (
    <div className="overflow-x-auto">
      {/* Month header */}
      <div className="flex mb-1 relative h-5">
        <div className="w-32 shrink-0" />
        <div className="flex-1 relative">
          {months.map(m => (
            <span key={m.label} className="absolute text-muted text-xs" style={{ left: `${m.pct}%` }}>{m.label}</span>
          ))}
          {showToday && (
            <div className="absolute top-0 bottom-0 w-px bg-error opacity-60" style={{ left: `${pct(now)}%` }} />
          )}
        </div>
      </div>

      {/* Rows */}
      {dated.map(t => (
        <div key={t.id} className="flex items-center mb-1 min-h-7">
          <div className="w-32 shrink-0 pr-2 text-muted text-xs truncate" title={t.task}>{t.task}</div>
          <div className="flex-1 relative h-5">
            {showToday && (
              <div className="absolute top-0 bottom-0 w-px bg-error opacity-60" style={{ left: `${pct(now)}%` }} />
            )}
            <div
              className="absolute top-0 h-full rounded bg-accent/70 flex items-center px-1"
              style={{ left: `${pct(t.start.getTime())}%`, width: `${wPct(t.start, t.end)}%` }}
            >
              {t.estimate != null && <span className="text-white text-xs truncate">{t.estimate}d</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────

export default function Assets() {
  const { state, update } = useAppState()
  const { products, selectedProductId, assets, selectedAssetIds, focusedAssetId, focusedAsset, taskView, taskSource } = state

  const [productsLoading, setProductsLoading] = useState(false)
  const [assetsLoading, setAssetsLoading]     = useState(false)
  const [tasks, setTasks]                     = useState(null) // null = not loaded
  const [tasksLoading, setTasksLoading]       = useState(false)
  const [genBusy, setGenBusy]                 = useState(false)
  const [genResult, setGenResult]             = useState(null)
  const [taskModal, setTaskModal]             = useState(null)
  const [metaFields, setMetaFields]           = useState([])
  const [modal, setModal]                     = useState(null) // 'send' | 'schema' | 'fieldSettings'
  const [metaVersion, setMetaVersion]         = useState(0)   // bump to re-build meta after settings save

  // Load products on mount
  useEffect(() => {
    if (products.length) return
    setProductsLoading(true)
    apiFetch('/api/assets/products')
      .then(data => update({ products: data }))
      .catch(err => toast.error(err.message))
      .finally(() => setProductsLoading(false))
  }, [])

  // Rebuild meta fields when focused asset or settings change
  useEffect(() => {
    setMetaFields(buildMetaFields(focusedAsset))
  }, [focusedAsset, metaVersion])

  const NO_PRODUCT_ID = '__none__'

  async function selectProduct(id) {
    update({ selectedProductId: id, selectedAssetIds: new Set(), focusedAssetId: null, focusedAsset: null })
    setTasks(null)
    setGenResult(null)
    setAssetsLoading(true)
    try {
      const url = id === NO_PRODUCT_ID
        ? '/api/assets?unassigned=true'
        : `/api/assets?productId=${encodeURIComponent(id)}`
      const data = await apiFetch(url)
      update({ assets: data })
    } catch (err) {
      toast.error(err.message)
    } finally {
      setAssetsLoading(false)
    }
  }

  function toggleAsset(id, checked) {
    const next = new Set(selectedAssetIds)
    checked ? next.add(id) : next.delete(id)
    update({ selectedAssetIds: next })
    setGenResult(null)
  }

  function toggleSelectAll(checked) {
    update({ selectedAssetIds: checked ? new Set(assets.map(a => a.id)) : new Set() })
    setGenResult(null)
  }

  async function focusAsset(id) {
    const asset = assets.find(a => a.id === id) ?? null
    update({ focusedAssetId: id, focusedAsset: asset })
    await loadTasks(id, asset, taskSource)
  }

  const loadTasks = useCallback(async (assetId, asset, source) => {
    setTasksLoading(true)
    setTasks(null)
    try {
      let data
      if (source === 'arthound') {
        if (!asset?.canonicalId) { setTasks([]); setTasksLoading(false); return }
        data = await apiFetch(`/api/schedule/tasks-local?canonicalAssetId=${encodeURIComponent(asset.canonicalId)}`)
      } else {
        const nameQ = asset?.name ? `&assetName=${encodeURIComponent(asset.name)}` : ''
        data = await apiFetch(`/api/schedule/tasks?assetId=${encodeURIComponent(assetId)}${nameQ}`)
      }
      setTasks(data)
      update({ lastTasks: data })
    } catch (err) {
      toast.error(err.message)
      setTasks([])
    } finally {
      setTasksLoading(false)
    }
  }, [])

  function setView(v)   { update({ taskView: v }) }
  function setSource(s) {
    update({ taskSource: s })
    if (focusedAssetId) loadTasks(focusedAssetId, focusedAsset, s)
  }

  async function openTaskDetail(taskId, taskName) {
    if (taskSource === 'arthound') return
    setTaskModal({ title: taskName, fields: [], loading: true })
    try {
      const props = await fetchTaskModalProps(taskId, taskName)
      setTaskModal(props)
    } catch (err) {
      setTaskModal(null)
      toast.error(err.message)
    }
  }

  async function generate() {
    const assetIds = [...selectedAssetIds]
    if (!assetIds.length) return
    setGenBusy(true)
    setGenResult(null)
    try {
      const result = await apiFetch('/api/schedule/generate-bulk', {
        method: 'POST',
        body: JSON.stringify({ assetIds }),
      })
      setGenResult(result)
      toast.success(`${result.created} tasks created and synced`)
      if (focusedAssetId && assetIds.includes(focusedAssetId)) {
        await loadTasks(focusedAssetId, focusedAsset, taskSource)
      }
    } catch (err) {
      toast.error(err.message)
    } finally {
      setGenBusy(false)
    }
  }

  const selectedAssets = assets.filter(a => selectedAssetIds.has(a.id))
  const allSelected    = assets.length > 0 && assets.every(a => selectedAssetIds.has(a.id))
  const someSelected   = selectedAssetIds.size > 0 && !allSelected

  return (
    <main className="flex flex-1 overflow-hidden">

      {/* ── Products ── */}
      <div className="w-44 border-r border-border flex flex-col shrink-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <span className="text-muted text-xs font-medium">Products</span>
          <button onClick={() => setModal('schema')} className="text-muted text-xs hover:text-foreground cursor-pointer">Schema</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {productsLoading && <p className="text-muted text-xs p-3">Loading…</p>}
          {!productsLoading && products.length === 0 && <p className="text-muted text-xs p-3">No products</p>}
          {products.map(p => (
            <div
              key={p.id}
              onClick={() => selectProduct(p.id)}
              className={cn(
                'px-3 py-2 text-sm cursor-pointer border-b border-border/50 truncate transition-colors',
                selectedProductId === p.id ? 'bg-surface-2 text-foreground' : 'text-muted hover:bg-surface-2 hover:text-foreground'
              )}
            >
              {p.name}
            </div>
          ))}
          {!productsLoading && (
            <div
              onClick={() => selectProduct(NO_PRODUCT_ID)}
              className={cn(
                'px-3 py-2 text-sm cursor-pointer truncate transition-colors italic',
                selectedProductId === NO_PRODUCT_ID ? 'bg-surface-2 text-foreground' : 'text-muted hover:bg-surface-2 hover:text-foreground'
              )}
            >
              No product
            </div>
          )}
        </div>
      </div>

      {/* ── Assets ── */}
      <div className="w-64 border-r border-border flex flex-col shrink-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
          <input
            type="checkbox"
            checked={allSelected}
            ref={el => { if (el) el.indeterminate = someSelected }}
            onChange={e => toggleSelectAll(e.target.checked)}
            disabled={assets.length === 0}
            className="accent-accent"
          />
          <span className="text-muted text-xs font-medium flex-1 truncate">
            {selectedProductId === NO_PRODUCT_ID ? 'No product' : selectedProductId ? (products.find(p => p.id === selectedProductId)?.name ?? '') : 'Assets'}
          </span>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {!selectedProductId && <p className="text-muted text-xs p-3">Select a product</p>}
          {assetsLoading && <p className="text-muted text-xs p-3">Loading…</p>}
          {!assetsLoading && selectedProductId && assets.length === 0 && (
            <p className="text-muted text-xs p-3">No assets for this product</p>
          )}
          {assets.map(a => (
            <div
              key={a.id}
              onClick={() => focusAsset(a.id)}
              className={cn(
                'flex items-center gap-2 px-3 py-2 border-b border-border/50 cursor-pointer transition-colors',
                focusedAssetId === a.id ? 'bg-surface-2' : 'hover:bg-surface-2'
              )}
            >
              <input
                type="checkbox"
                checked={selectedAssetIds.has(a.id)}
                onClick={e => e.stopPropagation()}
                onChange={e => toggleAsset(a.id, e.target.checked)}
                className="accent-accent shrink-0"
              />
              <div className="flex flex-col min-w-0">
                <span className="text-foreground text-xs truncate">{a.name || '—'}</span>
                <div className="flex items-center gap-1.5">
                  {a.itemType && <span className="text-muted text-xs">{a.itemType}</span>}
                  {a.priority != null && <span className="text-muted text-xs">P{a.priority}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Generate bar */}
        <div className="border-t border-border px-3 py-2 flex flex-col gap-2 shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-muted text-xs flex-1">
              {selectedAssetIds.size === 0 ? 'No assets selected' : `${selectedAssetIds.size} selected`}
            </span>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={generate}
              disabled={genBusy || selectedAssetIds.size === 0}
              className="flex-1 px-2 py-1.5 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface-3 cursor-pointer disabled:opacity-40 transition-colors"
            >
              {genBusy ? 'Generating…' : 'Generate Work'}
            </button>
            <button
              onClick={() => setModal('send')}
              disabled={selectedAssetIds.size === 0}
              className="px-2 py-1.5 rounded-md bg-accent text-white text-xs hover:bg-accent-hover cursor-pointer disabled:opacity-40 transition-colors"
            >
              Send
            </button>
          </div>
          {genResult && (
            <div className="text-xs">
              <span className="text-success">✓ {genResult.created} tasks written</span>
              {genResult.failed?.length > 0 && <span className="text-error ml-2">· {genResult.failed.length} failed</span>}
              {genResult.warnings?.length > 0 && (
                <div className="text-muted mt-1">
                  {genResult.warnings.map((w, i) => <div key={i}>· {w}</div>)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: Tasks + Meta ── */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Tasks */}
        <div className="flex-1 flex flex-col border-b border-border overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
            <span className="text-muted text-xs font-medium mr-auto">Work Tasks</span>
            {/* Source toggle */}
            <div className="flex rounded-md overflow-hidden border border-border text-xs">
              {['airtable', 'arthound'].map(s => (
                <button key={s} onClick={() => setSource(s)} className={cn(
                  'px-2 py-1 cursor-pointer transition-colors capitalize',
                  taskSource === s ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground'
                )}>{s}</button>
              ))}
            </div>
            {/* View toggle */}
            <div className="flex rounded-md overflow-hidden border border-border text-xs">
              {['list', 'timeline'].map(v => (
                <button key={v} onClick={() => setView(v)} className={cn(
                  'px-2 py-1 cursor-pointer transition-colors capitalize',
                  taskView === v ? 'bg-surface-2 text-foreground' : 'text-muted hover:text-foreground'
                )}>{v}</button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {!focusedAssetId && <p className="text-muted text-xs">Select an asset to view its tasks.</p>}
            {focusedAssetId && tasksLoading && <p className="text-muted text-xs">Loading…</p>}
            {focusedAssetId && !tasksLoading && tasks !== null && tasks.length === 0 && (
              <p className="text-muted text-xs">
                {taskSource === 'arthound' && !focusedAsset?.canonicalId
                  ? 'No ArtHound record — asset may not have synced yet.'
                  : 'No tasks yet — use Generate Work to create them.'}
              </p>
            )}
            {tasks?.length > 0 && taskView === 'timeline' && <TasksTimeline tasks={tasks} />}
            {tasks?.length > 0 && taskView === 'list' && (
              <div className="flex flex-col gap-1">
                {tasks.map(t => (
                  <div
                    key={t.id}
                    onClick={() => openTaskDetail(t.id, t.task)}
                    className={cn(
                      'flex items-center justify-between gap-4 px-3 py-2 rounded-md',
                      taskSource !== 'arthound' ? 'cursor-pointer hover:bg-surface-2 transition-colors' : ''
                    )}
                  >
                    <div>
                      <p className="text-foreground text-xs">{t.task}</p>
                      <p className="text-muted text-xs">
                        {t.startDate ? fmtDate(t.startDate) : '—'} → {t.endDate ? fmtDate(t.endDate) : '—'}
                      </p>
                    </div>
                    <span className="text-muted text-xs shrink-0">{t.estimate != null ? `${t.estimate}d` : '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Meta */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <span className="text-muted text-xs font-medium">Asset Details</span>
            <button
              onClick={() => setModal('fieldSettings')}
              className="text-muted text-xs hover:text-foreground cursor-pointer"
            >
              Fields
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-3 py-2">
            {!focusedAsset && <p className="text-muted text-xs">Select an asset to view details.</p>}
            {focusedAsset && metaFields.length === 0 && <p className="text-muted text-xs">No fields configured.</p>}
            {metaFields.length > 0 && (
              <div className="flex flex-col divide-y divide-border/40">
                {metaFields.map((f, i) => {
                  const display  = f.value != null && f.value !== '' ? String(f.value) : '—'
                  const isLinked = f.type === 'linked-record' && f.resolve
                  return (
                    <div
                      key={i}
                      onClick={isLinked ? async () => {
                        setTaskModal({ title: 'Loading…', fields: [], loading: true })
                        try { setTaskModal(await f.resolve()) }
                        catch (err) { setTaskModal(null); toast.error(err.message) }
                      } : undefined}
                      className={cn('flex items-start gap-3 py-1.5', isLinked && 'cursor-pointer group')}
                    >
                      <span className="text-muted text-xs w-24 shrink-0 pt-0.5">{f.label}</span>
                      <span className={cn(
                        'text-xs flex-1',
                        display === '—' ? 'text-border' : 'text-foreground',
                        isLinked && display !== '—' ? 'text-p2 group-hover:underline' : ''
                      )}>
                        {display}{isLinked && display !== '—' && <span className="ml-1 text-muted">↗</span>}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modals */}
      {taskModal && <DetailModal {...taskModal} onClose={() => setTaskModal(null)} />}

      {modal === 'send' && (
        <SendVendorModal
          selectedAssets={selectedAssets}
          onClose={() => setModal(null)}
          onSent={() => setModal(null)}
        />
      )}
      {modal === 'schema' && <SchemaModal onClose={() => setModal(null)} />}
      {modal === 'fieldSettings' && (
        <FieldSettingsModal
          assets={assets}
          onClose={() => setModal(null)}
          onSaved={() => setMetaVersion(v => v + 1)}
        />
      )}
    </main>
  )
}
