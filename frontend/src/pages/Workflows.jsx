import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { getSupabase } from '../lib/supabase'
import { cn } from '../lib/utils'

// ── Helpers ────────────────────────────────────────────────────────────────

function topoSort(steps) {
  const byId      = Object.fromEntries(steps.map(s => [s.id, s]))
  const followers = new Map(steps.map(s => [s.id, []]))
  const inDegree  = new Map(steps.map(s => [s.id, 0]))
  for (const s of steps) {
    for (const dep of s.depends_on) {
      if (followers.has(dep.id)) {
        followers.get(dep.id).push(s.id)
        inDegree.set(s.id, inDegree.get(s.id) + 1)
      }
    }
  }
  const queue  = steps.filter(s => inDegree.get(s.id) === 0).map(s => s.id)
  const sorted = []
  while (queue.length) {
    const id = queue.shift()
    sorted.push(id)
    for (const next of followers.get(id) ?? []) {
      const deg = inDegree.get(next) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }
  for (const s of steps) if (!sorted.includes(s.id)) sorted.push(s.id)
  return sorted.map(id => byId[id]).filter(Boolean)
}

function groupByCraft(sorted) {
  const groups = new Map()
  for (const s of sorted) {
    const key = s.craft || '—'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(s)
  }
  return groups
}

// ── Sub-components ─────────────────────────────────────────────────────────

function StepFormModal({ steps, editStep, onClose, onSaved }) {
  const isEdit = !!editStep
  const others = steps.filter(s => s.id !== editStep?.id)

  const [name, setName]   = useState(editStep?.name ?? '')
  const [craft, setCraft] = useState(editStep?.craft ?? '')
  const [deps, setDeps]   = useState(new Set(editStep?.depends_on.map(d => d.id) ?? []))
  const [busy, setBusy]   = useState(false)

  function toggleDep(id) {
    setDeps(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  async function handleSave(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) { toast.error('Name is required'); return }
    setBusy(true)
    try {
      const body = { name: trimmed, craft: craft.trim(), depends_on: [...deps] }
      if (isEdit) {
        await apiFetch(`/api/workflow-steps/${editStep.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        toast.success('Step updated')
      } else {
        await apiFetch('/api/workflow-steps', { method: 'POST', body: JSON.stringify(body) })
        toast.success('Step added')
      }
      onSaved()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={handleSave} className="flex flex-col gap-4 w-full max-w-md">
        <h2 className="text-foreground text-base font-semibold">
          {isEdit ? 'Edit Workflow Step' : 'Add Workflow Step'}
        </h2>

        <Field label="Name">
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            className={input()}
          />
        </Field>

        <Field label="Craft">
          <input
            value={craft}
            onChange={e => setCraft(e.target.value)}
            placeholder="e.g. Animation, Lighting…"
            className={input()}
          />
        </Field>

        {others.length > 0 && (
          <Field label="Depends on">
            <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
              {others.map(s => (
                <label key={s.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deps.has(s.id)}
                    onChange={() => toggleDep(s.id)}
                    className="accent-accent"
                  />
                  <span className="text-foreground text-sm">{s.name}</span>
                </label>
              ))}
            </div>
          </Field>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className={btnGhost()}>Cancel</button>
          <button type="submit" disabled={busy} className={btnPrimary()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Overlay>
  )
}

function ConfirmModal({ message, confirmLabel = 'Remove', onClose, onConfirm }) {
  const [busy, setBusy] = useState(false)
  async function handle() {
    setBusy(true)
    try { await onConfirm() }
    finally { setBusy(false) }
  }
  return (
    <Overlay onClose={onClose}>
      <div className="flex flex-col gap-5 w-full max-w-sm">
        <p className="text-foreground text-sm">{message}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className={btnGhost()}>Cancel</button>
          <button onClick={handle} disabled={busy} className={btnDanger()}>
            {busy ? 'Removing…' : confirmLabel}
          </button>
        </div>
      </div>
    </Overlay>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function Workflows() {
  const [steps, setSteps]           = useState([])
  const [selected, setSelected]     = useState(new Set()) // multi-select
  const [loading, setLoading]       = useState(true)
  const [modal, setModal]           = useState(null) // null | 'add' | 'edit' | 'remove'

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [])

  async function load(signal) {
    setLoading(true)
    try {
      const data = await apiFetch('/api/workflow-steps', signal ? { signal } : {})
      setSteps(data)
      setSelected(new Set())
    } catch (err) {
      if (!signal || err.name !== 'AbortError') toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  function toggleSelect(id, e) {
    e.stopPropagation()
    setSelected(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll(groupIds) {
    setSelected(prev => {
      const next = new Set(prev)
      const allIn = groupIds.every(id => next.has(id))
      if (allIn) groupIds.forEach(id => next.delete(id))
      else groupIds.forEach(id => next.add(id))
      return next
    })
  }

  async function handleRemove() {
    const ids = [...selected]
    if (ids.length === 0) return
    try {
      if (ids.length === 1) {
        await apiFetch(`/api/workflow-steps/${ids[0]}`, { method: 'DELETE' })
      } else {
        await apiFetch('/api/workflow-steps/bulk', {
          method: 'DELETE',
          body: JSON.stringify({ ids }),
        })
      }
      toast.success(ids.length === 1 ? 'Step removed' : `${ids.length} steps removed`)
    } catch (err) {
      toast.error(err.message)
    }
    setModal(null)
    await load()
  }

  async function downloadCsv() {
    try {
      const sb = await getSupabase()
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch('/api/workflow-steps/csv', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = Object.assign(document.createElement('a'), { href: url, download: 'workflow_steps.csv' })
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(err.message)
    }
  }

  const sorted       = topoSort(steps)
  const groups       = groupByCraft(sorted)
  const selectedStep = selected.size === 1 ? steps.find(s => s.id === [...selected][0]) : null
  const noneSelected = selected.size === 0

  const removeLabel = selected.size > 1
    ? `Remove ${selected.size} steps`
    : 'Remove'

  const confirmMessage = selected.size > 1
    ? `Remove ${selected.size} steps? This cannot be undone.`
    : selectedStep
      ? `Remove "${selectedStep.name}"? This cannot be undone.`
      : ''

  return (
    <main className="flex-1 flex flex-col p-6 gap-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <h1 className="text-foreground text-lg font-semibold mr-2">Workflow Steps</h1>
        <button onClick={() => setModal('add')} className={btnSecondary()}>+ Add</button>
        <button
          onClick={() => setModal('edit')}
          disabled={selected.size !== 1}
          className={btnSecondary()}
        >
          Edit
        </button>
        <button
          onClick={() => setModal('remove')}
          disabled={noneSelected}
          className={btnSecondary()}
        >
          {removeLabel}
        </button>
        <div className="flex-1" />
        <button onClick={downloadCsv} className={btnGhost()}>Download CSV</button>
      </div>

      {/* List */}
      {loading && <p className="text-muted text-sm">Loading…</p>}

      {!loading && steps.length === 0 && (
        <p className="text-muted text-sm">No workflow steps yet — click + Add to create one.</p>
      )}

      {!loading && steps.length > 0 && (
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([craft, groupSteps]) => {
            const groupIds  = groupSteps.map(s => s.id)
            const allIn     = groupIds.every(id => selected.has(id))
            const someIn    = groupIds.some(id => selected.has(id))

            return (
              <div key={craft}>
                <div className="flex items-center gap-3 mb-2">
                  {/* Group checkbox */}
                  <input
                    type="checkbox"
                    checked={allIn}
                    ref={el => { if (el) el.indeterminate = someIn && !allIn }}
                    onChange={() => toggleAll(groupIds)}
                    className="accent-accent cursor-pointer"
                  />
                  <span className="text-foreground text-sm font-medium">
                    {craft === '—' ? 'Unassigned' : craft}
                  </span>
                  <span className="text-muted text-xs">{groupSteps.length} step{groupSteps.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {groupSteps.map(s => (
                    <div
                      key={s.id}
                      onClick={e => toggleSelect(s.id, e)}
                      className={cn(
                        'flex items-start gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors',
                        selected.has(s.id)
                          ? 'border-accent bg-surface-2'
                          : 'border-border bg-surface hover:border-border hover:bg-surface-2'
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={e => toggleSelect(s.id, e)}
                        onClick={e => e.stopPropagation()}
                        className="accent-accent cursor-pointer mt-0.5 shrink-0"
                      />
                      <div className="flex flex-col min-w-0">
                        <span className="text-foreground text-sm font-medium">{s.name}</span>
                        {s.depends_on.length > 0 && (
                          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                            <span className="text-muted text-xs">Needs</span>
                            {s.depends_on.map(d => (
                              <span key={d.id} className="px-2 py-0.5 rounded-full bg-surface-3 text-muted text-xs">
                                {d.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Modals */}
      {(modal === 'add' || modal === 'edit') && (
        <StepFormModal
          steps={steps}
          editStep={modal === 'edit' ? selectedStep : null}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load() }}
        />
      )}
      {modal === 'remove' && !noneSelected && (
        <ConfirmModal
          message={confirmMessage}
          onClose={() => setModal(null)}
          onConfirm={handleRemove}
        />
      )}
    </main>
  )
}

// ── Shared primitives (local to this file) ─────────────────────────────────

function Overlay({ onClose, children }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-surface border border-border rounded-xl p-6 w-full max-w-md">
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-muted text-xs">{label}</label>
      {children}
    </div>
  )
}

const input        = () => 'bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent w-full'
const btnPrimary   = () => 'px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-40'
const btnDanger    = () => 'px-3 py-1.5 rounded-md bg-error text-white text-xs font-medium hover:opacity-80 transition-opacity cursor-pointer disabled:opacity-40'
const btnSecondary = () => 'px-3 py-1.5 rounded-md bg-surface-2 text-foreground text-xs hover:bg-surface-3 transition-colors cursor-pointer disabled:opacity-40'
const btnGhost     = () => 'px-3 py-1.5 rounded-md text-muted text-xs hover:text-foreground transition-colors cursor-pointer'
