import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { getSupabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { cn } from '../lib/utils'
import { Button, Input, Select, Field, Modal, Pill, Tabs, Card, EmptyState, Spinner } from '../components/ui'
import EstimateWizardModal from '../components/EstimateWizardModal'
import FieldMappingModal from '../components/FieldMappingModal'

const TABS = ['Members', 'Estimates', 'Workflows', 'Settings']

// ── Members tab ───────────────────────────────────────────────────────────────

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', user: 'Member' }
const ROLE_ORDER  = { owner: 0, admin: 1, user: 2 }

function auditLabel(entry) {
  const role = r => ROLE_LABELS[r] ?? r
  const tgt  = entry.target_email || (entry.target_user_id ? entry.target_user_id.slice(0, 8) + '…' : null)
  switch (entry.action) {
    case 'member_accepted':         return `Accepted ${tgt} as Member`
    case 'member_declined':         return `Declined join request from ${tgt}`
    case 'role_changed':            return `Changed ${tgt}'s role: ${role(entry.old_role)} → ${role(entry.new_role)}`
    case 'ownership_transferred':   return `Transferred ownership to ${tgt}`
    case 'member_removed':          return `Removed ${tgt} (was ${role(entry.old_role)})`
    case 'invite_code_regenerated': return 'Regenerated invite code'
    default:                        return entry.action
  }
}

function AuditLogSection() {
  const [open, setOpen]       = useState(false)
  const [entries, setEntries] = useState(null)
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await apiFetch('/api/org/audit-log')
      setEntries(data)
    } catch (err) {
      toast.error(err.message || 'Failed to load activity log')
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    if (!open && entries === null) load()
    setOpen(o => !o)
  }

  return (
    <Card className="flex flex-col gap-3">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center justify-between text-left w-full cursor-pointer"
      >
        <h3 className="text-foreground text-sm font-semibold">Activity log</h3>
        <span className="text-muted text-xs">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="flex flex-col">
          {loading && <div className="flex justify-center py-3"><Spinner /></div>}
          {!loading && entries?.length === 0 && (
            <EmptyState title="No activity recorded yet" className="py-6" />
          )}
          {!loading && entries?.map(e => (
            <div key={e.id} className="flex items-start justify-between gap-4 py-2.5 border-t border-border-soft first:border-t-0">
              <div className="flex flex-col min-w-0">
                <span className="text-foreground text-sm">{auditLabel(e)}</span>
                <span className="text-muted text-xs mt-0.5">by {e.actor_email || e.actor_id.slice(0, 8) + '…'}</span>
              </div>
              <span className="text-faint text-xs shrink-0 mt-0.5">
                {new Date(e.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function RoleBadge({ role }) {
  const tone = role === 'owner' || role === 'admin' ? 'accent' : 'neutral'
  return <Pill tone={tone}>{ROLE_LABELS[role] ?? role}</Pill>
}

function MembersTab() {
  const { isAdmin, profile } = useAuth()
  const myUserId = profile?.id

  const [hub, setHub]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const [regen, setRegen]   = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/api/org/hub')
      data.members.sort((a, b) => ROLE_ORDER[a.member_role] - ROLE_ORDER[b.member_role])
      setHub(data)
    } catch (err) {
      toast.error(err.message || 'Failed to load org hub')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function copyCode() {
    if (!hub?.org?.invite_code) return
    await navigator.clipboard.writeText(hub.org.invite_code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function regenerateCode() {
    setRegen(true)
    try {
      const data = await apiFetch('/api/org/invite-code/regenerate', { method: 'POST' })
      setHub(h => ({ ...h, org: { ...h.org, invite_code: data.invite_code } }))
      toast.success('Invite code regenerated')
    } catch (err) {
      toast.error(err.message || 'Failed to regenerate code')
    } finally {
      setRegen(false)
    }
  }

  async function acceptRequest(id) {
    try {
      await apiFetch(`/api/org/join-requests/${id}/accept`, { method: 'POST' })
      toast.success('Member accepted')
      load()
    } catch (err) {
      toast.error(err.message || 'Failed to accept')
    }
  }

  async function declineRequest(id) {
    try {
      await apiFetch(`/api/org/join-requests/${id}/decline`, { method: 'POST' })
      toast.success('Request declined')
      load()
    } catch (err) {
      toast.error(err.message || 'Failed to decline')
    }
  }

  async function changeRole(userId, newRole) {
    try {
      await apiFetch(`/api/org/members/${userId}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role: newRole }),
      })
      toast.success('Role updated')
      load()
    } catch (err) {
      toast.error(err.message || 'Failed to update role')
    }
  }

  async function removeMember(userId, email) {
    if (!confirm(`Remove ${email} from the organisation?`)) return
    try {
      await apiFetch(`/api/org/members/${userId}`, { method: 'DELETE' })
      toast.success('Member removed')
      load()
    } catch (err) {
      toast.error(err.message || 'Failed to remove member')
    }
  }

  if (loading) return <div className="flex items-center justify-center py-24"><Spinner /></div>
  if (!hub) return null

  const { org, members, pending_requests } = hub
  const myRole = members.find(m => m.user_id === myUserId)?.member_role

  return (
    <div className="flex flex-col gap-6 p-6 max-w-2xl mx-auto w-full">

      {/* Org info + invite code */}
      <Card className="flex flex-col gap-4">
        <div>
          <h2 className="text-foreground text-base font-semibold">{org.name}</h2>
          <p className="text-muted text-xs capitalize mt-0.5">
            {org.handle ? `@${org.handle} · ` : ''}{members.length} member{members.length !== 1 ? 's' : ''}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-muted text-xs">Invite code</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-1.5 rounded-md bg-surface-2 border border-border text-foreground text-sm font-mono tracking-widest">
              {org.invite_code}
            </code>
            <Button size="lg" onClick={copyCode} className="shrink-0">
              {copied ? 'Copied!' : 'Copy'}
            </Button>
            {isAdmin && (
              <Button size="lg" onClick={regenerateCode} disabled={regen} className="shrink-0">
                {regen ? 'Regenerating…' : 'Regenerate'}
              </Button>
            )}
          </div>
          <p className="text-faint text-xs">Share this code with people you want to invite. They'll request access and an admin must approve them.</p>
        </div>
      </Card>

      {/* Pending join requests */}
      {isAdmin && pending_requests.length > 0 && (
        <Card
          title={<>Pending requests <span className="ml-1 text-faint text-xs font-normal tabular-nums">{pending_requests.length}</span></>}
        >
          <div className="flex flex-col gap-2">
            {pending_requests.map(req => (
              <div key={req.id} className="flex items-center justify-between gap-3 py-2 border-t border-border-soft first:border-t-0">
                <div className="flex flex-col min-w-0">
                  <span className="text-foreground text-sm truncate">{req.email || req.user_id}</span>
                  <span className="text-faint text-xs">{new Date(req.created_at).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="primary" size="sm" onClick={() => acceptRequest(req.id)}>Accept</Button>
                  <Button variant="secondary" size="sm" onClick={() => declineRequest(req.id)}>Decline</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Members list */}
      <Card title="Members">
        <div className="flex flex-col">
          {members.map(m => {
            const canChange = isAdmin && !m.is_self && m.member_role !== 'owner'
            const canRemove = isAdmin && !m.is_self && m.member_role !== 'owner'
              && (myRole === 'owner' || m.member_role === 'user')
            return (
              <div key={m.user_id} className="flex items-center gap-3 py-3 border-t border-border-soft first:border-t-0">
                <div className="flex flex-col flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground text-sm truncate">{m.email || m.user_id}</span>
                    {m.is_self && <span className="text-muted text-xs">(you)</span>}
                  </div>
                  <span className="text-faint text-xs">{new Date(m.joined_at).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canChange ? (
                    <Select
                      size="sm"
                      value={m.member_role}
                      onChange={e => changeRole(m.user_id, e.target.value)}
                    >
                      <option value="user">Member</option>
                      <option value="admin">Admin</option>
                      {myRole === 'owner' && <option value="owner">Owner (transfer)</option>}
                    </Select>
                  ) : (
                    <RoleBadge role={m.member_role} />
                  )}
                  {canRemove && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeMember(m.user_id, m.email)}
                      className="hover:text-error hover:bg-error-tint"
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      {/* Activity log — admin only */}
      {isAdmin && <AuditLogSection />}
    </div>
  )
}

// ── Estimates tab ─────────────────────────────────────────────────────────────

function colNameToVariableValues(colName, variableFields) {
  if (colName === '__default__') return {}
  const parts = colName.split('|')
  return Object.fromEntries(variableFields.map((f, i) => [f, parts[i] ?? '']))
}

function MatrixCell({ stepId, colName, variableFields, initialValue, linkId = null, isOverride = false }) {
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
          // linkId set → write a per-link override instead of the base cell
          ...(linkId ? { link_id: linkId } : {}),
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
  }, [value, stepId, colName, variableFields, linkId])

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
          'w-14 text-center text-xs bg-transparent rounded-md px-1 py-1.5 outline-none',
          'border border-transparent hover:border-border focus:border-accent',
          'text-foreground placeholder:text-faint [appearance:textfield]',
          '[&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none',
          // per-link mode: accent ring on override cells, muted text on inherited (base) cells
          linkId && isOverride && 'bg-accent-tint text-accent ring-1 ring-inset ring-accent/40',
          linkId && !isOverride && 'text-muted',
          saving && 'opacity-40 cursor-wait',
        )}
      />
    </td>
  )
}

function renderTags(arr) {
  if (!arr?.length) return <span className="text-faint text-xs">—</span>
  return arr.map((v, i) => (
    <Pill key={i} tone="neutral" className="mr-0.5 mb-0.5">{v}</Pill>
  ))
}

function MatrixTable({ reloadKey, linkId = null }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const tableRef = useRef(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    const url = linkId
      ? `/api/setup/matrix-table-pg?linkId=${encodeURIComponent(linkId)}`
      : '/api/setup/matrix-table-pg'
    apiFetch(url, { signal: controller.signal })
      .then(d => { setData(d); setLoading(false) })
      .catch(e => { if (e.name !== 'AbortError') { setError(e.message); setLoading(false) } })
    return () => controller.abort()
  }, [reloadKey, linkId])

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

  if (loading) return <div className="flex justify-center py-6"><Spinner /></div>
  if (error)   return <p className="text-error text-sm py-4">{error}</p>
  if (!data)   return null

  const { variableFields = [], combinations = [], work = [], attributeFields = [] } = data

  if (!combinations.length) {
    return <EmptyState title="No estimate combinations configured" hint="Run Setup first." />
  }
  if (!work.length) {
    return <EmptyState title="No workflow steps found" hint="Add steps in Workflows first." />
  }

  const groupSpans = []
  if (variableFields.length > 1) {
    let prev = null, span = 0
    combinations.forEach((c, i) => {
      const topVal = c.key.split('|')[0]
      if (topVal !== prev) {
        if (prev !== null) groupSpans.push({ label: prev, span })
        prev = topVal; span = 1
      } else { span++ }
      if (i === combinations.length - 1) groupSpans.push({ label: prev, span })
    })
  }
  const hasGroups = groupSpans.length > 1
  const fixedCls = 'mat-fixed sticky bg-surface z-10 border-r border-border-soft'

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
                  <th key={i} colSpan={g.span} className="text-center font-medium text-foreground py-2 px-3 border-b border-border-soft">{g.label}</th>
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
            <tr key={t.name} className="border-b border-border-faint hover:bg-surface-2/40">
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
                  linkId={linkId}
                  isOverride={(t.overriddenKeys || []).includes(c.colName)}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function EstimatesTab() {
  const { isAdmin, role } = useAuth()
  const isVendor = role === 'vendor'
  const [showWizard, setShowWizard] = useState(false)
  const [reloadKey, setReloadKey]   = useState(0)
  const [randomizing, setRandomizing] = useState(false)
  const [links, setLinks] = useState([])
  const [selectedLinkId, setSelectedLinkId] = useState(null)   // null = base matrix

  useEffect(() => {
    if (!isVendor) return
    apiFetch('/api/handshake/links').then(setLinks).catch(() => {})
  }, [isVendor])

  function handleComplete() {
    setShowWizard(false)
    setReloadKey(k => k + 1)
  }

  async function handleSetupClick() {
    try {
      const steps = await apiFetch('/api/workflow-steps')
      if (!steps.length) {
        toast.warning('No workflow steps found. Add at least one step in Workflows before running Setup.')
        return
      }
    } catch { /* let wizard surface its own errors */ }
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

  return (
    <div className="flex flex-col gap-4 p-4 flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <Button variant="primary" onClick={handleSetupClick}>
          Setup
        </Button>
        {isAdmin && (
          <Button variant="secondary" onClick={handleRandomize} disabled={randomizing}>
            {randomizing ? 'Randomizing…' : 'Randomize'}
          </Button>
        )}
        {isVendor && links.length > 0 && (
          <Select
            value={selectedLinkId ?? ''}
            onChange={e => setSelectedLinkId(e.target.value || null)}
          >
            <option value="">Base matrix (all studios)</option>
            {links.map(l => (
              <option key={l.id} value={l.id}>{l.studio?.name || 'Studio'}</option>
            ))}
          </Select>
        )}
      </div>
      {selectedLinkId && (
        <p className="text-xs text-muted shrink-0 -mt-2">
          Editing per-studio overrides — <span className="text-accent">accent</span> cells override the base;
          others inherit it. Editing an inherited cell creates an override.
        </p>
      )}
      <div className="flex-1 overflow-auto">
        <MatrixTable reloadKey={reloadKey} linkId={selectedLinkId} />
      </div>
      {showWizard && (
        <EstimateWizardModal onClose={() => setShowWizard(false)} onComplete={handleComplete} />
      )}
    </div>
  )
}

// ── Workflows tab ─────────────────────────────────────────────────────────────

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
    <Modal
      title={isEdit ? 'Edit Workflow Step' : 'Add Workflow Step'}
      onClose={onClose}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="lg" type="submit" form="step-form" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="step-form" onSubmit={handleSave} className="flex flex-col gap-4">
        <Field label="Name">
          <Input
            autoFocus
            size="lg"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full"
          />
        </Field>

        <Field label="Craft">
          <Input
            size="lg"
            value={craft}
            onChange={e => setCraft(e.target.value)}
            placeholder="e.g. Animation, Lighting…"
            className="w-full"
          />
        </Field>

        {others.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Depends on</span>
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
          </div>
        )}
      </form>
    </Modal>
  )
}

function ConfirmModal({ message, onClose, onConfirm }) {
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
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" size="lg" onClick={handle} disabled={busy}>
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className="text-foreground text-sm">{message}</p>
    </Modal>
  )
}

function WorkflowsTab() {
  const [steps, setSteps]       = useState([])
  const [selected, setSelected] = useState(new Set())
  const [loading, setLoading]   = useState(true)
  const [modal, setModal]       = useState(null)

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
    <div className="flex flex-col gap-4 p-6 max-w-4xl mx-auto w-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={() => setModal('add')}>+ Add</Button>
        <Button variant="secondary" onClick={() => setModal('edit')} disabled={selected.size !== 1}>
          Edit
        </Button>
        <Button variant="secondary" onClick={() => setModal('remove')} disabled={noneSelected}>
          {removeLabel}
        </Button>
        <div className="flex-1" />
        <Button variant="ghost" onClick={downloadCsv}>Download CSV</Button>
      </div>

      {/* List */}
      {loading && <div className="flex justify-center py-10"><Spinner /></div>}

      {!loading && steps.length === 0 && (
        <EmptyState title="No workflow steps yet" hint="Click + Add to create one." />
      )}

      {!loading && steps.length > 0 && (
        <div className="flex flex-col gap-4">
          {[...groups.entries()].map(([craft, groupSteps]) => {
            const groupIds = groupSteps.map(s => s.id)
            const allIn    = groupIds.every(id => selected.has(id))
            const someIn   = groupIds.some(id => selected.has(id))

            return (
              <div key={craft}>
                <div className="flex items-center gap-3 mb-2">
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
                          ? 'border-accent bg-surface-2'
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
    </div>
  )
}

// ── Settings tab ─────────────────────────────────────────────────────────────

function SettingsTab() {
  return (
    <div className="max-w-2xl mx-auto w-full">
      <FieldMappingModal inline />
    </div>
  )
}

// ── OrgHub ────────────────────────────────────────────────────────────────────

export default function OrgHub() {
  const [searchParams, setSearchParams] = useSearchParams()
  const rawTab = searchParams.get('tab') || 'Members'
  const activeTab = TABS.find(t => t.toLowerCase() === rawTab.toLowerCase()) ?? 'Members'

  function setTab(t) {
    setSearchParams(t === 'Members' ? {} : { tab: t.toLowerCase() }, { replace: true })
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0">
        <span className="text-foreground font-semibold text-sm">Organisation</span>
      </div>
      <Tabs
        tabs={TABS.map(t => ({ id: t, label: t }))}
        active={activeTab}
        onChange={setTab}
        className="px-6 shrink-0"
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'Members'   && <MembersTab />}
        {activeTab === 'Estimates' && <EstimatesTab />}
        {activeTab === 'Workflows' && <WorkflowsTab />}
        {activeTab === 'Settings'  && <SettingsTab />}
      </div>
    </div>
  )
}
