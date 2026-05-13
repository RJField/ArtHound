import { useState, useEffect, useRef, useLayoutEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import EstimateWizardModal from '../components/EstimateWizardModal'
import { useAuth } from '../contexts/AuthContext'

// ── Helpers ───────────────────────────────────────────────────────────────────

function colNameToVariableValues(colName, variableFields) {
  if (colName === '__default__') return {}
  const parts = colName.split('|')
  return Object.fromEntries(variableFields.map((f, i) => [f, parts[i] ?? '']))
}

// ── MatrixCell ────────────────────────────────────────────────────────────────

function MatrixCell({ stepId, colName, variableFields, initialValue }) {
  const initStr = (initialValue != null && initialValue !== 0) ? String(initialValue) : ''
  const [value, setValue] = useState(initStr)
  const [saving, setSaving] = useState(false)
  const committed = useRef(initStr)

  useEffect(() => {
    const s = (initialValue != null && initialValue !== 0) ? String(initialValue) : ''
    setValue(s)
    committed.current = s
  }, [initialValue])

  const save = useCallback(async () => {
    const num = value === '' ? 0 : parseFloat(value)
    if (isNaN(num) || num < 0) { setValue(committed.current); return }
    const next = num === 0 ? '' : String(num)
    if (next === committed.current) return
    setSaving(true)
    try {
      await apiFetch('/api/setup/matrix-cell', {
        method: 'PATCH',
        body: JSON.stringify({
          workflow_step_id: stepId,
          variable_values: colNameToVariableValues(colName, variableFields),
          estimate_days: num,
        }),
      })
      committed.current = next
      setValue(next)
    } catch (e) {
      toast.error(`Save failed: ${e.message}`)
      setValue(committed.current)
    } finally {
      setSaving(false)
    }
  }, [value, stepId, colName, variableFields])

  function handleKeyDown(e) {
    if (e.key === 'Enter') e.currentTarget.blur()
    if (e.key === 'Escape') { setValue(committed.current); e.currentTarget.blur() }
  }

  return (
    <td className="py-0 px-1 text-center">
      <input
        type="number"
        min="0"
        step="0.5"
        value={value}
        placeholder="—"
        onChange={e => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        disabled={saving}
        className={cn(
          'w-14 text-center text-xs bg-transparent rounded px-1 py-1.5 outline-none',
          'border border-transparent hover:border-border focus:border-accent',
          'text-foreground placeholder:text-muted [appearance:textfield]',
          '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
          saving && 'opacity-40 cursor-wait',
        )}
      />
    </td>
  )
}

// ── Matrix Table ──────────────────────────────────────────────────────────────

function renderTags(arr) {
  if (!arr?.length) return <span className="text-muted text-xs">—</span>
  return arr.map((v, i) => (
    <span key={i} className="inline-block text-xs bg-surface-2 border border-border text-foreground px-1.5 py-0.5 rounded mr-0.5 mb-0.5">{v}</span>
  ))
}

function MatrixTable({ reloadKey }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const tableRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    apiFetch('/api/setup/matrix-table-pg', { signal: controller.signal })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false) } })
    return () => controller.abort()
  }, [reloadKey])

  // Apply sticky left offsets after table renders
  useEffect(() => {
    if (!tableRef.current || !data) return
    const raf = requestAnimationFrame(() => {
      const table = tableRef.current
      if (!table) return
      const firstRow = table.querySelector('thead tr')
      if (!firstRow) return
      const fixed = Array.from(firstRow.querySelectorAll('.mat-fixed'))
      let offset = 0
      const offsets = fixed.map(cell => {
        const o = offset
        offset += cell.getBoundingClientRect().width
        return o
      })
      table.querySelectorAll('tr').forEach(row => {
        Array.from(row.querySelectorAll('.mat-fixed')).forEach((cell, i) => {
          if (offsets[i] !== undefined) cell.style.left = offsets[i] + 'px'
        })
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [data])

  if (loading) return <p className="text-muted text-sm py-4">Loading…</p>
  if (error)   return <p className="text-error text-sm py-4">{error}</p>
  if (!data)   return null

  const { variableFields = [], combinations = [], work = [], attributeFields = [] } = data

  if (!combinations.length) {
    return <p className="text-muted text-sm py-4">No estimate combinations configured — run the Setup wizard first.</p>
  }
  if (!work.length) {
    return <p className="text-muted text-sm py-4">No workflow steps found — run the Setup wizard first.</p>
  }

  // Build two-row header groupSpans
  const groupSpans = []
  if (variableFields.length > 1) {
    let prev = null, span = 0
    combinations.forEach((c, i) => {
      const topVal = c.key.split('|')[0]
      if (topVal !== prev) {
        if (prev !== null) groupSpans.push({ label: prev, span })
        prev = topVal; span = 1
      } else {
        span++
      }
      if (i === combinations.length - 1) groupSpans.push({ label: prev, span })
    })
  }
  const hasGroups = groupSpans.length > 1

  const fixedCls = 'mat-fixed sticky bg-surface z-10 border-r border-border/40'

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table ref={tableRef} className="text-xs border-collapse w-full">
        <thead>
          {hasGroups ? (
            <>
              <tr className="border-b border-border bg-surface-2">
                <th className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-2 w-8')} rowSpan={2}>#</th>
                <th className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-3 min-w-36')} rowSpan={2}>Task</th>
                {attributeFields.map(f => (
                  <th key={f} className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-3')} rowSpan={2}>{f}</th>
                ))}
                <th className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-3 min-w-24')} rowSpan={2}>Depends On</th>
                {groupSpans.map((g, i) => (
                  <th key={i} colSpan={g.span} className="text-center font-medium text-foreground py-2 px-3 border-b border-border/60">{g.label}</th>
                ))}
              </tr>
              <tr className="border-b border-border bg-surface-2">
                {combinations.map(c => (
                  <th key={c.colName} className="text-left font-normal text-muted py-1.5 px-3 whitespace-nowrap">
                    {c.key.split('|').slice(1).join(' | ')}
                  </th>
                ))}
              </tr>
            </>
          ) : (
            <tr className="border-b border-border bg-surface-2">
              <th className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-2 w-8')}>#</th>
              <th className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-3 min-w-36')}>Task</th>
              {attributeFields.map(f => (
                <th key={f} className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-3')}>{f}</th>
              ))}
              <th className={cn(fixedCls, 'text-left font-normal text-muted py-2 px-3 min-w-24')}>Depends On</th>
              {combinations.map(c => (
                <th key={c.colName} className="text-left font-normal text-muted py-2 px-3 whitespace-nowrap" title={c.key}>{c.label}</th>
              ))}
            </tr>
          )}
        </thead>
        <tbody>
          {work.map(t => (
            <tr key={t.name} className="border-b border-border/30 hover:bg-surface-2/40">
              <td className={cn(fixedCls, 'py-1.5 px-2 text-muted text-center')}>{t.step}</td>
              <td className={cn(fixedCls, 'py-1.5 px-3 text-foreground font-medium')}>{t.name}</td>
              {attributeFields.map(f => (
                <td key={f} className={cn(fixedCls, 'py-1.5 px-3')}>{renderTags((t.linkedValues || {})[f])}</td>
              ))}
              <td className={cn(fixedCls, 'py-1.5 px-3 text-muted')}>
                {t.dependsOn?.length ? t.dependsOn.join(', ') : '—'}
              </td>
              {combinations.map(c => (
                <MatrixCell
                  key={c.colName}
                  stepId={t.id}
                  colName={c.colName}
                  variableFields={variableFields}
                  initialValue={t.estimates[c.colName]}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Estimates Page ────────────────────────────────────────────────────────────

export default function Estimates() {
  const { isAdmin } = useAuth()
  const [showWizard, setShowWizard] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [randomizing, setRandomizing] = useState(false)

  function handleComplete() {
    setShowWizard(false)
    setReloadKey(k => k + 1)
  }

  async function handleSetupClick() {
    try {
      const steps = await apiFetch('/api/workflow-steps')
      if (!steps.length) {
        toast.warning('No workflow steps found. Add at least one step in the Workflows page before running Setup.')
        return
      }
    } catch {
      // If the check fails, let the wizard open and surface its own errors
    }
    setShowWizard(true)
  }

  async function handleRandomize() {
    setRandomizing(true)
    try {
      const { updated } = await apiFetch('/api/setup/randomize-matrix', { method: 'POST' })
      toast.success(`Randomized ${updated} cell${updated !== 1 ? 's' : ''}`)
      setReloadKey(k => k + 1)
    } catch (e) {
      toast.error(`Failed: ${e.message}`)
    } finally {
      setRandomizing(false)
    }
  }

  const btn = 'px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer border transition-colors'

  return (
    <main className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <h1 className="text-foreground text-sm font-semibold mr-2">Estimates</h1>
        <button
          onClick={handleSetupClick}
          className={cn(btn, 'border-accent text-accent hover:bg-accent/10')}
        >
          Setup
        </button>
        {isAdmin && (
          <button
            onClick={handleRandomize}
            disabled={randomizing}
            className={cn(btn, 'border-border text-muted hover:text-foreground hover:border-foreground/40 disabled:opacity-40 disabled:cursor-wait')}
          >
            {randomizing ? 'Randomizing…' : 'Randomize'}
          </button>
        )}
      </div>

      {/* Matrix table */}
      <div className="flex-1 overflow-auto">
        <MatrixTable reloadKey={reloadKey} />
      </div>

      {showWizard && (
        <EstimateWizardModal
          onClose={() => setShowWizard(false)}
          onComplete={handleComplete}
        />
      )}
    </main>
  )
}
