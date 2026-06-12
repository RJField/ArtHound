import { useState, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import { Button, Modal, Pill, Select, Spinner } from './ui'

const STEP_LABELS = ['Variables', 'Values', 'Matrix', 'Options', 'Create']

function StepNav({ step }) {
  return (
    <div className="sticky top-0 z-20 flex items-center px-5 py-3 border-b border-border-soft bg-surface shrink-0 overflow-x-auto">
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
                active ? 'bg-accent text-white' : done ? 'bg-accent-tint text-accent' : 'bg-surface-2 text-muted'
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
    const controller = new AbortController()
    apiFetch('/api/setup/fields', { signal: controller.signal })
      .then(data => { setWiz(w => ({ ...w, fields: data.fields })); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false) } })
    return () => controller.abort()
  }, [])

  function toggleField(name) {
    setWiz(w => {
      const next = new Set(w.selected)
      next.has(name) ? next.delete(name) : next.add(name)
      return { ...w, selected: next }
    })
  }

  if (loading) return <div className="flex items-center gap-2 text-muted text-sm p-5"><Spinner size={14} /> Loading fields…</div>
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
        <p className="text-faint text-xs">These fields' combinations determine which estimate to use (e.g. Item Type, Team, Priority).</p>
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
            <span className="text-faint text-xs font-mono">{typeLabel(f.type)}</span>
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

  function fetchCombos(signal) {
    const qs = fields.map(f => `field=${encodeURIComponent(f)}`).join('&')
    apiFetch(`/api/setup/asset-combinations?${qs}`, signal ? { signal } : {})
      .then(data => { setWiz(w => ({ ...w, existingCombos: data.combinations })); setCombosData(data); setLoadingCombos(false) })
      .catch(e => { if (e.name !== 'AbortError') { setCombosError(e.message); setLoadingCombos(false) } })
  }

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const missing = fields.filter(f => !wiz.values[f])
    if (!missing.length) { setLoadingCombos(false); fetchCombos(signal); return () => controller.abort() }

    Promise.all(missing.map(f =>
      apiFetch(`/api/setup/field-values?field=${encodeURIComponent(f)}`, { signal }).then(d => [f, d.values])
    )).then(pairs => {
      const vals = { ...wiz.values }
      pairs.forEach(([f, v]) => { vals[f] = v })
      setWiz(w => ({ ...w, values: vals }))
      fetchCombos(signal)
    }).catch(e => { if (e.name !== 'AbortError') setLoadingCombos(false) })
    return () => controller.abort()
  }, [])

  return (
    <div className="flex flex-col gap-4 p-5">
      {fields.map(f => {
        const vals = wiz.values[f] || []
        return (
          <div key={f}>
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-foreground text-sm font-medium">{f}</span>
              <span className="text-faint text-xs tabular-nums">{vals.length}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {vals.map(v => (
                <Pill key={v.name} tone="neutral">{v.name}</Pill>
              ))}
            </div>
          </div>
        )
      })}

      <div className="border-t border-border-soft pt-4">
        <p className="text-foreground text-sm font-medium mb-1">Existing Asset Combinations</p>
        <p className="text-faint text-xs mb-3">Unique combinations currently present in the Assets table</p>
        {loadingCombos && <div className="flex items-center gap-2 text-muted text-xs"><Spinner size={12} /> Loading…</div>}
        {combosError   && <p className="text-error text-xs">{combosError}</p>}
        {combosData && !combosData.combinations.length && (
          <p className="text-muted text-xs">No assets with all variable fields populated.</p>
        )}
        {combosData?.combinations.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  {fields.map(f => <th key={f} className="text-left text-faint font-normal pb-1.5 pr-4">{f}</th>)}
                  <th className="text-left text-faint font-normal pb-1.5">Assets</th>
                </tr>
              </thead>
              <tbody>
                {combosData.combinations.map((c, i) => (
                  <tr key={i} className="border-b border-border-soft">
                    {fields.map(f => <td key={f} className="py-1.5 pr-4 text-foreground">{c.values[f] ?? '—'}</td>)}
                    <td className="py-1.5">
                      <Pill tone="neutral">{c.count}</Pill>
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
          'flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border cursor-pointer transition-colors',
          allSel ? 'border-border text-muted' : 'border-accent text-accent bg-accent-tint'
        )}
      >
        <span>{field}</span>
        <span className="text-faint">{allSel ? `All (${values.length})` : `${sel}/${values.length}`}</span>
        <span>▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-10 bg-surface border border-border rounded-lg shadow-(--ah-shadow-md) min-w-36 py-1">
          <div className="flex gap-1 px-2 py-1 border-b border-border-soft">
            <button type="button" onClick={() => { onChange(new Set(values.map(v => v.name))); setOpen(false) }}
              className="text-xs text-muted hover:text-foreground cursor-pointer">All</button>
            <span className="text-border">·</span>
            <button type="button" onClick={() => { onChange(new Set()); setOpen(false) }}
              className="text-xs text-muted hover:text-foreground cursor-pointer">None</button>
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
  const [combos] = useState(() => {
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
                <span className="ml-2 text-faint tabular-nums">{gIndices.length}</span>
              </td>
            </tr>
            {gIndices.map(i => {
              const c = combos[i]
              const excl = excluded.has(i)
              return (
                <tr key={i} className={cn('border-b border-border-faint', excl && 'opacity-40')}>
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
            <td colSpan={fields.length + 1} className="py-1.5 px-3 text-[11px] text-faint font-medium uppercase tracking-wider">
              {label}
              <span className="ml-2 tabular-nums">{indices.length}</span>
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
                  <tr key={i} className={cn('border-b border-border-faint', excl && 'opacity-40')}>
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
        <Select size="sm" value={groupBy} onChange={e => setGroupBy(e.target.value)}>
          <option value="">Group by: none</option>
          {fields.map(f => <option key={f} value={f}>{f}</option>)}
        </Select>
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
          <Button size="sm" onClick={() => setExcluded(prev => { const next = new Set(prev); visible.forEach(i => next.delete(i)); return next })}>
            Select visible
          </Button>
          <Button size="sm" onClick={() => setExcluded(prev => { const next = new Set(prev); visible.forEach(i => next.add(i)); return next })}>
            Deselect visible
          </Button>
        </div>
      </div>

      <p className="text-muted text-xs">
        {selectedCount} of {combos.length} combination{combos.length !== 1 ? 's' : ''} selected — will be included in the ArtHound matrix.
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
              {fields.map(f => <th key={f} className="py-2 pr-3 text-left text-faint font-normal">{f}</th>)}
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
  return (
    <div className="flex flex-col gap-5 p-5">
      <div>
        <p className="text-foreground text-sm font-medium mb-0.5">Reset matrix</p>
        <p className="text-faint text-xs mb-2">
          If enabled, all existing estimate values for this studio will be cleared before writing new rows.
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={wiz.clearExisting}
            onChange={e => setWiz(w => ({ ...w, clearExisting: e.target.checked }))}
            className="accent-accent"
          />
          <span className="text-sm text-foreground">Clear existing matrix</span>
        </label>
      </div>
      <div>
        <p className="text-foreground text-sm font-medium mb-0.5">Prefill from Default</p>
        <p className="text-faint text-xs mb-2">
          If enabled, new combination rows will be seeded with each step's current Default column value instead of zero.
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={wiz.prefillFromDefault}
            onChange={e => setWiz(w => ({ ...w, prefillFromDefault: e.target.checked }))}
            className="accent-accent"
          />
          <span className="text-sm text-foreground">Prefill from Default</span>
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

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const variables = fields.map(field => ({
      field,
      type: wiz.fields.find(f => f.name === field)?.type ?? 'unknown',
    }))

    apiFetch('/api/setup/create-matrix-pg', {
      method: 'POST',
      body: JSON.stringify({
        variables,
        combinations: activeCombos,
        clearExisting: wiz.clearExisting,
        prefillFromDefault: wiz.prefillFromDefault,
      }),
    })
      .then(data => { setResult(data); setStatus('success'); onCreated?.() })
      .catch(e => { setErrMsg(e.message); setStatus('error') })
  }, [])

  if (status === 'pending') {
    return (
      <div className="p-8 flex items-center justify-center gap-2">
        <Spinner size={14} />
        <p className="text-muted text-sm">
          {`Syncing ${activeCombos.length} combination${activeCombos.length !== 1 ? 's' : ''} to ArtHound Matrix…`}
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
        <Pill tone="neutral">{result.stepsUpserted} workflow steps</Pill>
        <Pill tone="neutral">{result.matrixRows} matrix rows</Pill>
        {result.cleared && <span className="text-muted text-xs">previous matrix cleared</span>}
      </div>
      <p className="text-faint text-xs text-center max-w-xs">
        Estimates are stored in ArtHound. Edit day values directly in the matrix view.
      </p>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function EstimateWizardModal({ onClose, onComplete }) {
  const [wiz, setWiz] = useState({
    step: 1,
    fields: [],
    selected: new Set(),
    values: {},
    combos: [],
    excluded: new Set(),
    existingCombos: null,
    filters: {},
    groupBy: '',
    result: null,
    clearExisting: false,
    prefillFromDefault: false,
  })

  async function goNext() {
    if (wiz.step === 1 && !wiz.selected.size) return toast.error('Select at least one variable field')
    if (wiz.step === 3 && wiz.combos.filter((_, i) => !wiz.excluded.has(i)).length === 0) return toast.error('Select at least one combination')
    setWiz(w => ({ ...w, step: w.step === 3 ? 4 : w.step + 1 }))
  }

  function goBack() {
    setWiz(w => ({ ...w, step: w.step === 4 ? 3 : w.step - 1 }))
  }

  return (
    <Modal
      title="ArtHound Matrix Setup"
      onClose={onClose}
      width="max-w-2xl"
      bodyClassName="p-0"
      footer={
        <>
          {wiz.step > 1 && wiz.step < 5 && (
            <Button size="lg" className="mr-auto" onClick={goBack}>← Back</Button>
          )}
          {wiz.step < 5 && (
            <Button variant="primary" size="lg" onClick={goNext}>
              {wiz.step === 4 ? 'Create' : 'Next →'}
            </Button>
          )}
          {wiz.step === 5 && (
            <Button size="lg" onClick={onClose}>Close</Button>
          )}
        </>
      }
    >
      {/* Step nav */}
      <StepNav step={wiz.step} />

      {/* Step body */}
      {wiz.step === 1 && <Step1 wiz={wiz} setWiz={setWiz} />}
      {wiz.step === 2 && <Step2 wiz={wiz} setWiz={setWiz} />}
      {wiz.step === 3 && <Step3 wiz={wiz} setWiz={setWiz} />}
      {wiz.step === 4 && <Step4 wiz={wiz} setWiz={setWiz} />}
      {wiz.step === 5 && <Step5 wiz={wiz} onCreated={onComplete} />}
    </Modal>
  )
}
