import { useState, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { Workflow } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { getSupabase } from '../lib/supabase'
import { cn } from '../lib/utils'
import PageContainer from '../components/PageContainer'
import { Button, Field, Input, Modal, Pill, StatusDot, Spinner, EmptyState, PageHeader } from '../components/ui'
import { craftColor } from '../lib/statusColors'

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

  // Steps that (transitively) depend on the one being edited. Making the edited step depend on any
  // of them would close a cycle, so those choices are disabled. (Backend rejects it too.)
  const forbidden = useMemo(() => {
    const forbid = new Set()
    if (!editStep) return forbid
    const byId = Object.fromEntries(steps.map(s => [s.id, s]))
    const stack = [editStep.id]
    while (stack.length) {
      const cur = stack.pop()
      for (const follower of byId[cur]?.depended_by ?? []) {
        if (!forbid.has(follower.id)) { forbid.add(follower.id); stack.push(follower.id) }
      }
    }
    return forbid
  }, [steps, editStep])

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
    <Modal
      title={isEdit ? 'Edit Workflow Step' : 'Add Workflow Step'}
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" type="submit" form="workflow-step-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="workflow-step-form" onSubmit={handleSave} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            size="lg"
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </Field>

        <Field label="Craft">
          <Input
            size="lg"
            value={craft}
            onChange={e => setCraft(e.target.value)}
            placeholder="e.g. Animation, Lighting…"
          />
        </Field>

        {others.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Depends on</span>
            <div className="flex flex-col gap-1 max-h-40 overflow-y-auto">
              {others.map(s => {
                const blocked = forbidden.has(s.id)
                return (
                  <label
                    key={s.id}
                    title={blocked ? 'Would create a circular dependency' : undefined}
                    className={cn('flex items-center gap-2', blocked ? 'cursor-not-allowed opacity-40' : 'cursor-pointer')}
                  >
                    <input
                      type="checkbox"
                      checked={deps.has(s.id)}
                      disabled={blocked}
                      onChange={() => toggleDep(s.id)}
                      className="accent-accent"
                    />
                    <span className="text-foreground text-sm">{s.name}</span>
                    {blocked && <span className="text-faint text-xs ml-auto">cycle</span>}
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </form>
    </Modal>
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
    <Modal
      title="Confirm removal"
      onClose={onClose}
      width="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onClose}>Cancel</Button>
          <Button variant="danger" size="lg" onClick={handle} disabled={busy}>
            {busy ? 'Removing…' : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-foreground text-sm">{message}</p>
    </Modal>
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
    <PageContainer width="lg" className="p-6 gap-4">
      <PageHeader
        title="Workflow Steps"
        actions={
          <>
            <Button onClick={() => setModal('add')}>+ Add</Button>
            <Button onClick={() => setModal('edit')} disabled={selected.size !== 1}>
              Edit
            </Button>
            <Button onClick={() => setModal('remove')} disabled={noneSelected}>
              {removeLabel}
            </Button>
            <Button variant="ghost" onClick={downloadCsv}>Download CSV</Button>
          </>
        }
      />

      {/* List */}
      {loading && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {!loading && steps.length === 0 && (
        <EmptyState
          icon={Workflow}
          title="No workflow steps yet"
          hint="Click + Add to create one."
        />
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
                  {craft === '—' ? (
                    <span className="text-foreground text-sm font-medium">Unassigned</span>
                  ) : (
                    <StatusDot
                      label={craft}
                      color={craftColor(craft)}
                      className="text-foreground text-sm font-medium"
                    />
                  )}
                  <span className="text-faint text-xs tabular-nums">{groupSteps.length} step{groupSteps.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {groupSteps.map(s => (
                    <div
                      key={s.id}
                      onClick={e => toggleSelect(s.id, e)}
                      className={cn(
                        'flex items-start gap-3 px-4 py-3 rounded-lg border cursor-pointer transition-colors',
                        selected.has(s.id)
                          ? 'border-accent bg-accent-tint'
                          : 'border-border bg-surface hover:bg-surface-2'
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
                            <span className="text-faint text-xs">Needs</span>
                            {s.depends_on.map(d => (
                              <Pill key={d.id} tone="neutral">{d.name}</Pill>
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
    </PageContainer>
  )
}
