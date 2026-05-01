import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import { apiFetch } from '../lib/api'
import { cn } from '../lib/utils'
import EstimateWizardModal from '../components/EstimateWizardModal'

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
    setLoading(true)
    setError(null)
    apiFetch('/api/setup/matrix-table-pg')
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
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

  const { variableFields = [], combinations = [], tasks = [], attributeFields = [] } = data

  if (!combinations.length) {
    return <p className="text-muted text-sm py-4">No estimate combinations configured — run the Setup wizard first.</p>
  }
  if (!tasks.length) {
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
          {tasks.map(t => (
            <tr key={t.name} className="border-b border-border/30 hover:bg-surface-2/40">
              <td className={cn(fixedCls, 'py-1.5 px-2 text-muted text-center')}>{t.step}</td>
              <td className={cn(fixedCls, 'py-1.5 px-3 text-foreground font-medium')}>{t.name}</td>
              {attributeFields.map(f => (
                <td key={f} className={cn(fixedCls, 'py-1.5 px-3')}>{renderTags((t.linkedValues || {})[f])}</td>
              ))}
              <td className={cn(fixedCls, 'py-1.5 px-3 text-muted')}>
                {t.dependsOn?.length ? t.dependsOn.join(', ') : '—'}
              </td>
              {combinations.map(c => {
                const val = t.estimates[c.colName]
                return (val != null && val !== 0)
                  ? <td key={c.colName} className="py-1.5 px-3 text-foreground text-center">{val}d</td>
                  : <td key={c.colName} className="py-1.5 px-3 text-muted text-center">—</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Estimates Page ────────────────────────────────────────────────────────────

export default function Estimates() {
  const [showWizard, setShowWizard] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  function handleComplete() {
    setShowWizard(false)
    setReloadKey(k => k + 1)
  }

  const btn = 'px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer border transition-colors'

  return (
    <main className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <h1 className="text-foreground text-sm font-semibold mr-2">Estimates</h1>
        <button
          onClick={() => setShowWizard(true)}
          className={cn(btn, 'border-accent text-accent hover:bg-accent/10')}
        >
          Setup
        </button>
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
