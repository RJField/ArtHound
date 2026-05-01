import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'

const STEP_LABELS = ['Variables', 'Values', 'Matrix', 'Options', 'Create']

function StepNav({ step }) {
  return (
    <div className="flex items-center px-5 py-3 border-b border-border shrink-0 overflow-x-auto">
      {STEP_LABELS.map((label, i) => {
        const n = i + 1
        const done = n < step
        const active = n === step
        return (
          <div key={n} className="flex items-center shrink-0">
            {i > 0 && <div className={cn('w-6 h-px mx-1', done ? 'bg-accent' : 'bg-border')} />}
            <div className={cn('flex items-center gap-1.5 text-xs', active ? 'text-foreground' : done ? 'text-accent' : 'text-muted')}>
              <span className={cn(
                'w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium shrink-0',
                active ? 'bg-accent text-white' : done ? 'bg-accent/20 text-accent' : 'bg-surface-2 text-muted'
              )}>
                {done ? '✓' : n}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Step 1: Variable field selection ─────────────────────────────────────────

function Step1({ wiz, setWiz }) {
  const [loading, setLoading] = useState(!wiz.fields.length)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (wiz.fields.length) { setLoading(false); return }
    apiFetch('/api/setup/fields')
      .then(data => { setWiz(w => ({ ...w, fields: data.fields })); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [])

  function toggleField(name) {
    setWiz(w => {
      const next = new Set(w.selected)
      next.has(name) ? next.delete(name) : next.add(name)
      return { ...w, selected: next }
    })
  }

  if (loading) return <p className="text-muted text-sm p-5">Loading fields…</p>
  if (error)   return <p className="text-error text-sm p-5">{error}</p>

  const typeLabel = t => {
    if (t === 'multipleRecordLinks') return 'link'
    if (t === 'singleSelect' || t === 'multipleSelects') return 'select'
    return t ?? 'other'
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      <div>
        <p className="text-foreground text-sm font-medium mb-1">Select variable fields</p>
        <p className="text-muted text-xs">These fields' combinations determine which estimate to use (e.g. Item Type, Team, Priority).</p>
      </div>
      <div className="flex flex-col gap-1.5">
        {wiz.fields.map(f => (
          <label key={f.name} className="flex items-center gap-2 cursor-pointer py-1">
            <input
              type="checkbox"
              checked={wiz.selected.has(f.name)}
              onChange={() => toggleField(f.name)}
              className="accent-accent"
            />
            <span className="text-foreground text-sm flex-1">{f.name}</span>
            <span className="text-muted text-xs font-mono">{typeLabel(f.type)}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

// ── Step 2: Review values + existing asset combinations ───────────────────────

function Step2({ wiz, setWiz }) {
  const [loadingCombos, setLoadingCombos] = useState(true)
  const [combosData, setCombosData] = useState(null)
  const [combosError, setCombosError] = useState(null)
  const fields = [...wiz.selected]

  useEffect(() => {
    const missing = fields.filter(f => !wiz.values[f])
    if (!missing.length) { setLoadingCombos(false); fetchCombos(); return }

    Promise.all(missing.map(f =>
      apiFetch(`/api/setup/field-values?field=${encodeURIComponent(f)}`).then(d => [f, d.values])
    )).then(pairs => {
      const vals = { ...wiz.values }
      pairs.forEach(([f, v]) => { vals[f] = v })
      setWiz(w => ({ ...w, values: vals }))
      fetchCombos()
    }).catch(() => { setLoadingCombos(false) })
  }, [])

  function fetchCombos() {
    const qs = fields.map(f => `field=${encodeURIComponent(f)}`).join('&')
    apiFetch(`/api/setup/asset-combinations?${qs}`)
      .then(data => { setWiz(w => ({ ...w, existingCombos: data.combinations })); setCombosData(data); setLoadingCombos(false) })
      .catch(e => { setCombosError(e.message); setLoadingCombos(false) })
  }

  return (
    <div className="flex flex-col gap-4 p-5">
      {fields.map(f => {
        const vals = wiz.values[f] || []
        return (
          <div key={f}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-foreground text-sm font-medium">{f}</span>
              <span className="text-muted text-xs bg-surface-2 px-1.5 py-0.5 rounded-full">{vals.length}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {vals.map(v => (
                <span key={v.name} className="text-xs bg-surface-2 text-foreground px-2 py-0.5 rounded-full border border-border">{v.name}</span>
              ))}
            </div>
          </div>
        )
      })}

      <div className="border-t border-border pt-4">
        <p className="text-foreground text-sm font-medium mb-1">Existing Asset Combinations</p>
        <p className="text-muted text-xs mb-3">Unique combinations currently present in the Assets table</p>
        {loadingCombos && <p className="text-muted text-xs">Loading…</p>}
        {combosError   && <p className="text-error text-xs">{combosError}</p>}
        {combosData && !combosData.combinations.length && (
          <p className="text-muted text-xs">No assets with all variable fields populated.</p>
        )}
        {combosData?.combinations.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  {fields.map(f => <th key={f} className="text-left text-muted font-normal pb-1.5 pr-4">{f}</th>)}
                  <th className="text-left text-muted font-normal pb-1.5">Assets</th>
                </tr>
              </thead>
              <tbody>
                {combosData.combinations.map((c, i) => (
                  <tr key={i} className="border-b border-border/40">
                    {fields.map(f => <td key={f} className="py-1.5 pr-4 text-foreground">{c.values[f] ?? '—'}</td>)}
                    <td className="py-1.5">
                      <span className="bg-surface-2 text-foreground text-xs px-1.5 py-0.5 rounded-full">{c.count}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Step 3: Matrix preview with filtering, grouping, selection ────────────────

function buildCombinations(fields, values) {
  const valueSets = fields.map(f => values[f] || [])
  let combos = [{}]
  fields.forEach((field, i) => {
    combos = combos.flatMap(partial =>
      valueSets[i].map(v => ({ ...partial, [field]: v }))
    )
  })
  return combos.map(vals => ({
    label: fields.map(f => vals[f]?.name ?? '?').join(' | '),
    values: vals,
  }))
}

function FilterDropdown({ field, values, filter, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const sel = values.filter(v => filter.has(v.name)).length
  const allSel = sel === values.length

  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border transition-colors',
          allSel ? 'border-border text-muted' : 'border-accent text-accent bg-accent/10'
        )}
      >
        <span>{field}</span>
        <span className="text-muted">{allSel ? `All (${values.length})` : `${sel}/${values.length}`}</span>
        <span>▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-10 bg-surface border border-border rounded-lg shadow-lg min-w-36 py-1">
          <div className="flex gap-1 px-2 py-1 border-b border-border">
            <button type="button" onClick={() => { onChange(new Set(values.map(v => v.name))); setOpen(false) }}
              className="text-xs text-muted hover:text-foreground">All</button>
            <span className="text-border">·</span>
            <button type="button" onClick={() => { onChange(new Set()); setOpen(false) }}
              className="text-xs text-muted hover:text-foreground">None</button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {values.map(v => (
              <label key={v.name} className="flex items-center gap-2 px-2 py-1 hover:bg-surface-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={filter.has(v.name)}
                  onChange={e => {
                    const next = new Set(filter)
                    e.target.checked ? next.add(v.name) : next.delete(v.name)
                    onChange(next)
                  }}
                  className="accent-accent"
                />
                <span className="text-sm text-foreground">{v.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Step3({ wiz, setWiz }) {
  const fields = [...wiz.selected]

  // Build combos + compute existing indices once on mount
  const [combos, setCombos] = useState(() => {
    const built = buildCombinations(fields, wiz.values)
    return built
  })

  const [existingIndices] = useState(() => {
    const built = buildCombinations(fields, wiz.values)
    const set = new Set()
    if (wiz.existingCombos?.length) {
      built.forEach((combo, i) => {
        if (wiz.existingCombos.some(ec => fields.every(f => combo.values[f]?.name === ec.values[f]))) {
          set.add(i)
        }
      })
    }
    return set
  })

  const [excluded, setExcluded] = useState(() => {
    const built = buildCombinations(fields, wiz.values)
    const set = new Set()
    const existing = new Set()
    if (wiz.existingCombos?.length) {
      built.forEach((combo, i) => {
        if (wiz.existingCombos.some(ec => fields.every(f => combo.values[f]?.name === ec.values[f]))) {
          existing.add(i)
        }
      })
    }
    built.forEach((_, i) => { if (!existing.has(i)) set.add(i) })
    return set
  })

  const [filters, setFilters] = useState(() => {
    const f = {}
    fields.forEach(field => {
      f[field] = new Set((wiz.values[field] || []).map(v => v.name))
    })
    return f
  })
  const [groupBy, setGroupBy] = useState('')

  // Sync excluded + combos back to wiz when navigating
  useEffect(() => {
    setWiz(w => ({ ...w, combos, excluded, filters, groupBy }))
  }, [combos, excluded, filters, groupBy])

  function getVisible() {
    return combos.reduce((acc, c, i) => {
      if (fields.every(f => {
        const v = c.values[f]?.name ?? ''
        return !filters[f] || filters[f].has(v)
      })) acc.push(i)
      return acc
    }, [])
  }

  const visible = getVisible()
  const selectedCount = combos.length - excluded.size
  const existVis = visible.filter(i => existingIndices.has(i))
  const otherVis = visible.filter(i => !existingIndices.has(i))

  function allCbState() {
    if (!visible.length) return { checked: false, indeterminate: false }
    const excl = visible.filter(i => excluded.has(i)).length
    return { checked: excl === 0, indeterminate: excl > 0 && excl < visible.length }
  }

  const allCb = allCbState()
  const allCbRef = useRef(null)
  useEffect(() => {
    if (allCbRef.current) allCbRef.current.indeterminate = allCb.indeterminate
  }, [allCb.indeterminate])

  function toggleRow(i, checked) {
    setExcluded(prev => {
      const next = new Set(prev)
      checked ? next.delete(i) : next.add(i)
      return next
    })
  }

  function renderSection(indices, label) {
    if (!indices.length) return null

    function buildGrouped() {
      const groupMap = new Map()
      indices.forEach(i => {
        const key = combos[i].values[groupBy]?.name ?? '—'
        if (!groupMap.has(key)) groupMap.set(key, [])
        groupMap.get(key).push(i)
      })
      return [...groupMap.entries()].map(([gkey, gIndices]) => {
        const allExcl = gIndices.every(i => excluded.has(i))
        const noneExcl = gIndices.every(i => !excluded.has(i))
        return (
          <tbody key={gkey}>
            <tr className="bg-surface-2/60">
              <td className="py-1 pl-3">
                <input
                  type="checkbox"
                  checked={noneExcl}
                  ref={el => { if (el) el.indeterminate = !noneExcl && !allExcl }}
                  onChange={e => setExcluded(prev => {
                    const next = new Set(prev)
                    gIndices.forEach(i => e.target.checked ? next.delete(i) : next.add(i))
                    return next
                  })}
                  className="accent-accent"
                />
              </td>
              <td colSpan={fields.length} className="py-1 text-xs text-muted font-medium">
                <strong className="text-foreground">{groupBy}: {gkey}</strong>
                <span className="ml-2 bg-surface-3 text-muted text-xs px-1.5 py-0.5 rounded-full">{gIndices.length}</span>
              </td>
            </tr>
            {gIndices.map(i => {
              const c = combos[i]
              const excl = excluded.has(i)
              return (
                <tr key={i} className={cn('border-b border-border/30', excl && 'opacity-40')}>
                  <td className="py-1 pl-3">
                    <input type="checkbox" checked={!excl} onChange={e => toggleRow(i, e.target.checked)} className="accent-accent" />
                  </td>
                  {fields.map(f => <td key={f} className="py-1 pr-3 text-xs text-foreground">{c.values[f]?.name ?? '—'}</td>)}
                </tr>
              )
            })}
          </tbody>
        )
      })
    }

    return (
      <>
        <tbody>
          <tr className="bg-surface-3/40">
            <td colSpan={fields.length + 1} className="py-1.5 px-3 text-xs text-muted font-medium uppercase tracking-wide">
              {label}
              <span className="ml-2 bg-surface-2 px-1.5 py-0.5 rounded-full">{indices.length}</span>
            </td>
          </tr>
        </tbody>
        {groupBy
          ? buildGrouped()
          : (
            <tbody>
              {indices.map(i => {
                const c = combos[i]
                const excl = excluded.has(i)
                return (
                  <tr key={i} className={cn('border-b border-border/30', excl && 'opacity-40')}>
                    <td className="py-1 pl-3">
                      <input type="checkbox" checked={!excl} onChange={e => toggleRow(i, e.target.checked)} className="accent-accent" />
                    </td>
                    {fields.map(f => <td key={f} className="py-1 pr-3 text-xs text-foreground">{c.values[f]?.name ?? '—'}</td>)}
                  </tr>
                )
              })}
            </tbody>
          )
        }
      </>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={groupBy}
          onChange={e => setGroupBy(e.target.value)}
          className="text-xs bg-surface-2 border border-border rounded-md px-2 py-1 text-foreground"
        >
          <option value="">Group by: none</option>
          {fields.map(f => <option key={f} value={f}>{f}</option>)}
        </select>
        <div className="flex gap-1.5 flex-wrap">
          {fields.map(f => (
            <FilterDropdown
              key={f}
              field={f}
              values={wiz.values[f] || []}
              filter={filters[f] || new Set()}
              onChange={next => setFilters(prev => ({ ...prev, [f]: next }))}
            />
          ))}
        </div>
        <div className="flex gap-1.5 ml-auto">
          <button type="button" onClick={() => setExcluded(prev => { const next = new Set(prev); visible.forEach(i => next.delete(i)); return next })}
            className="text-xs text-muted hover:text-foreground px-2 py-1 rounded-md border border-border">Select visible</button>
          <button type="button" onClick={() => setExcluded(prev => { const next = new Set(prev); visible.forEach(i => next.add(i)); return next })}
            className="text-xs text-muted hover:text-foreground px-2 py-1 rounded-md border border-border">Deselect visible</button>
        </div>
      </div>

      <p className="text-muted text-xs">
        {selectedCount} of {combos.length} combination{combos.length !== 1 ? 's' : ''} selected — will be added as columns to <strong className="text-foreground">Task Templates</strong>.
      </p>

      <div className="overflow-x-auto max-h-72 overflow-y-auto border border-border rounded-lg">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-surface z-10">
            <tr className="border-b border-border">
              <th className="py-2 pl-3 w-8">
                <input
                  ref={allCbRef}
                  type="checkbox"
                  checked={allCb.checked}
                  onChange={e => setExcluded(prev => {
                    const next = new Set(prev)
                    visible.forEach(i => e.target.checked ? next.delete(i) : next.add(i))
                    return next
                  })}
                  className="accent-accent"
                />
              </th>
              {fields.map(f => <th key={f} className="py-2 pr-3 text-left text-muted font-normal">{f}</th>)}
            </tr>
          </thead>
          {!visible.length
            ? <tbody><tr><td colSpan={fields.length + 1} className="py-6 text-center text-muted text-xs">No combinations match current filters</td></tr></tbody>
            : <>
                {renderSection(existVis, 'Existing Asset Combinations')}
                {renderSection(otherVis, 'All Other Combinations')}
              </>
          }
        </table>
      </div>
    </div>
  )
}

// ── Step 4: Options ───────────────────────────────────────────────────────────

function Step4({ wiz, setWiz }) {
  const [colsWithData, setColsWithData] = useState([])

  useEffect(() => {
    apiFetch('/api/setup/matrix-table')
      .then(data => {
        setColsWithData((data.combinations || []).filter(c =>
          (data.tasks || []).some(t => t.estimates[c.colName] != null)
        ))
      })
      .catch(() => {})
  }, [])

  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <p className="text-foreground text-sm font-medium mb-0.5">Prefill new columns from</p>
        <p className="text-muted text-xs mb-2">Copy estimate values from an existing column into all newly created columns.</p>
        <select
          value={wiz.prefillCol}
          onChange={e => setWiz(w => ({ ...w, prefillCol: e.target.value }))}
          className="text-sm bg-surface-2 border border-border rounded-md px-2 py-1.5 text-foreground w-full"
        >
          <option value="">— None —</option>
          {colsWithData.map(c => <option key={c.colName} value={c.colName}>{c.label}</option>)}
        </select>
      </div>

      <div>
        <p className="text-foreground text-sm font-medium mb-0.5">
          {wiz.mode === 'arthound' ? 'Reset matrix' : 'Previously generated columns'}
        </p>
        <p className="text-muted text-xs mb-2">
          {wiz.mode === 'arthound'
            ? 'If enabled, all existing estimate values for this studio will be cleared before writing new rows.'
            : 'If enabled, all columns from the previous setup run will be deleted from Task Templates before creating new ones.'}
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={wiz.clearExisting}
            onChange={e => setWiz(w => ({ ...w, clearExisting: e.target.checked }))}
            className="accent-accent"
          />
          <span className="text-sm text-foreground">
            {wiz.mode === 'arthound' ? 'Clear existing matrix' : 'Delete previously generated columns'}
          </span>
        </label>
      </div>
    </div>
  )
}

// ── Step 5: Create ────────────────────────────────────────────────────────────

function Step5({ wiz, onCreated }) {
  const [status, setStatus] = useState('pending') // pending | success | error
  const [result, setResult] = useState(null)
  const [errMsg, setErrMsg] = useState('')
  const ran = useRef(false)

  const fields = [...wiz.selected]
  const activeCombos = wiz.combos.filter((_, i) => !wiz.excluded.has(i))
  const isPg = wiz.mode === 'arthound'

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const variables = fields.map(field => ({
      field,
      type: wiz.fields.find(f => f.name === field)?.type ?? 'unknown',
    }))
    const endpoint = isPg ? '/api/setup/create-matrix-pg' : '/api/setup/create-matrix'

    apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        variables,
        combinations: activeCombos,
        prefillCol: wiz.prefillCol,
        clearExisting: wiz.clearExisting,
      }),
    })
      .then(data => { setResult(data); setStatus('success'); onCreated?.() })
      .catch(e => { setErrMsg(e.message); setStatus('error') })
  }, [])

  if (status === 'pending') {
    return (
      <div className="p-8 flex items-center justify-center">
        <p className="text-muted text-sm">
          {isPg
            ? `Syncing ${activeCombos.length} combination${activeCombos.length !== 1 ? 's' : ''} to ArtHound Matrix…`
            : `Adding ${activeCombos.length} column${activeCombos.length !== 1 ? 's' : ''} to Task Templates…`}
        </p>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="p-8 flex flex-col items-center gap-2">
        <span className="text-error text-2xl">✗</span>
        <p className="text-foreground text-sm font-medium">Creation failed</p>
        <p className="text-error text-xs">{errMsg}</p>
      </div>
    )
  }

  return (
    <div className="p-8 flex flex-col items-center gap-3">
      <span className="text-success text-2xl">✓</span>
      <p className="text-foreground text-sm font-medium">Done</p>
      <div className="flex flex-wrap items-center gap-2 justify-center">
        {isPg ? (
          <>
            <span className="bg-surface-2 text-foreground text-xs px-2 py-1 rounded-full">{result.stepsUpserted} workflow steps</span>
            <span className="bg-surface-2 text-foreground text-xs px-2 py-1 rounded-full">{result.matrixRows} matrix rows</span>
            {result.cleared && <span className="text-muted text-xs">previous matrix cleared</span>}
            {result.prefillPending && <span className="text-muted text-xs">Prefilling from <strong>{wiz.prefillCol}</strong> in background</span>}
          </>
        ) : (
          <>
            <strong className="text-foreground text-xs">{result.templatesTable}</strong>
            <span className="bg-surface-2 text-foreground text-xs px-2 py-1 rounded-full">{result.created} added</span>
            {result.skipped > 0 && <span className="text-muted text-xs">{result.skipped} already existed</span>}
            {result.deleted > 0  && <span className="text-muted text-xs">{result.deleted} deleted</span>}
            {result.prefillPending && <span className="text-muted text-xs">Prefilling from <strong>{wiz.prefillCol}</strong> in background</span>}
          </>
        )}
      </div>
      <p className="text-muted text-xs text-center max-w-xs">
        {isPg
          ? 'Estimates are stored in ArtHound. Edit day values directly in the matrix view.'
          : 'estimates.config.js has been updated. Download the CSV to fill in day estimates offline.'}
      </p>
      {!isPg && (
        <a
          href="/api/setup/export-csv"
          download="estimate-matrix.csv"
          className="text-xs text-accent hover:text-accent-hover border border-accent/40 px-3 py-1.5 rounded-md mt-1"
        >
          ⬇ Download CSV
        </a>
      )}
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function EstimateWizardModal({ mode, onClose, onComplete }) {
  const [wiz, setWiz] = useState({
    step: 1,
    mode,
    fields: [],
    selected: new Set(),
    values: {},
    combos: [],
    excluded: new Set(),
    existingCombos: null,
    filters: {},
    groupBy: '',
    result: null,
    prefillCol: '',
    clearExisting: false,
  })

  const title = mode === 'arthound' ? 'ArtHound Matrix Setup' : 'Estimation Engine Setup'

  async function goNext() {
    if (wiz.step === 1 && !wiz.selected.size) return toast.error('Select at least one variable field')
    if (wiz.step === 3 && wiz.combos.filter((_, i) => !wiz.excluded.has(i)).length === 0) return toast.error('Select at least one combination')
    setWiz(w => ({ ...w, step: w.step === 3 ? 4 : w.step + 1 }))
  }

  function goBack() {
    setWiz(w => ({ ...w, step: w.step === 4 ? 3 : w.step - 1 }))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <h2 className="text-foreground text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="text-muted hover:text-foreground text-xl cursor-pointer leading-none">×</button>
        </div>

        {/* Step nav */}
        <StepNav step={wiz.step} />

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {wiz.step === 1 && <Step1 wiz={wiz} setWiz={setWiz} />}
          {wiz.step === 2 && <Step2 wiz={wiz} setWiz={setWiz} />}
          {wiz.step === 3 && <Step3 wiz={wiz} setWiz={setWiz} />}
          {wiz.step === 4 && <Step4 wiz={wiz} setWiz={setWiz} />}
          {wiz.step === 5 && <Step5 wiz={wiz} onCreated={onComplete} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border shrink-0">
          <div>
            {wiz.step > 1 && wiz.step < 5 && (
              <button onClick={goBack} className="text-xs text-muted hover:text-foreground px-3 py-1.5 rounded-md border border-border cursor-pointer">← Back</button>
            )}
          </div>
          <div>
            {wiz.step < 5 && (
              <button onClick={goNext} className="text-xs bg-accent text-white px-3 py-1.5 rounded-md font-medium hover:bg-accent-hover cursor-pointer">
                {wiz.step === 4 ? 'Create' : 'Next →'}
              </button>
            )}
            {wiz.step === 5 && (
              <button onClick={onClose} className="text-xs text-muted hover:text-foreground px-3 py-1.5 rounded-md border border-border cursor-pointer">Close</button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
