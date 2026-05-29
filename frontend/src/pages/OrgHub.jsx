import { useState, useEffect, useRef, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { getSupabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { cn } from '../lib/utils'
import EstimateWizardModal from '../components/EstimateWizardModal'
import FieldMappingModal from '../components/FieldMappingModal'

// ── Shared primitives ─────────────────────────────────────────────────────────

const TABS = ['Members', 'Estimates', 'Workflows', 'Settings']

function TabBar({ active, onChange }) {
  return (
    <div className="flex gap-1 border-b border-border shrink-0 px-6">
      {TABS.map(t => (
        <button
          key={t}
          onClick={() => onChange(t)}
          className={cn(
            'px-3 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            active === t
              ? 'border-accent text-foreground'
              : 'border-transparent text-muted hover:text-foreground',
          )}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

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
    <div className="flex flex-col gap-3 p-5 rounded-xl bg-surface border border-border">
      <button
        onClick={toggle}
        className="flex items-center justify-between text-left w-full"
      >
        <h2 className="text-foreground text-sm font-semibold">Activity log</h2>
        <span className="text-muted text-xs">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="flex flex-col">
          {loading && <p className="text-muted text-xs py-2">Loading…</p>}
          {!loading && entries?.length === 0 && (
            <p className="text-muted text-xs py-2">No activity recorded yet.</p>
          )}
          {!loading && entries?.map(e => (
            <div key={e.id} className="flex items-start justify-between gap-4 py-2.5 border-t border-border first:border-t-0">
              <div className="flex flex-col min-w-0">
                <span className="text-foreground text-sm">{auditLabel(e)}</span>
                <span className="text-muted text-xs mt-0.5">by {e.actor_email || e.actor_id.slice(0, 8) + '…'}</span>
              </div>
              <span className="text-muted text-xs shrink-0 mt-0.5">
                {new Date(e.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RoleBadge({ role }) {
  const colours = {
    owner: 'bg-accent/10 text-accent border-accent/20',
    admin: 'bg-surface-2 text-foreground border-border',
    user:  'bg-surface-2 text-muted border-border',
  }
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${colours[role] ?? colours.user}`}>
      {ROLE_LABELS[role] ?? role}
    </span>
  )
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

  if (loading) return <div className="flex items-center justify-center py-24"><p className="text-muted text-sm">Loading…</p></div>
  if (!hub) return null

  const { org, members, pending_requests } = hub
  const myRole = members.find(m => m.user_id === myUserId)?.member_role

  return (
    <div className="flex flex-col gap-6 p-6 max-w-2xl mx-auto w-full">

      {/* Org info + invite code */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-surface border border-border">
        <div>
          <h2 className="text-foreground text-base font-semibold">{org.name}</h2>
          <p className="text-muted text-xs capitalize mt-0.5">
            {org.handle ? `@${org.handle} · ` : ''}{members.length} member{members.length !== 1 ? 's' : ''}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-muted text-xs">Invite code</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 rounded-lg bg-surface-2 border border-border text-foreground text-sm font-mono tracking-widest">
              {org.invite_code}
            </code>
            <button
              onClick={copyCode}
              className="px-3 py-2 rounded-lg border border-border text-muted text-xs hover:text-foreground hover:border-foreground transition-colors cursor-pointer shrink-0"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
            {isAdmin && (
              <button
                onClick={regenerateCode}
                disabled={regen}
                className="px-3 py-2 rounded-lg border border-border text-muted text-xs hover:text-foreground hover:border-foreground transition-colors cursor-pointer shrink-0 disabled:opacity-40"
              >
                {regen ? 'Regenerating…' : 'Regenerate'}
              </button>
            )}
          </div>
          <p className="text-muted text-xs">Share this code with people you want to invite. They'll request access and an admin must approve them.</p>
        </div>
      </div>

      {/* Pending join requests */}
      {isAdmin && pending_requests.length > 0 && (
        <div className="flex flex-col gap-3 p-5 rounded-xl bg-surface border border-border">
          <h2 className="text-foreground text-sm font-semibold">
            Pending requests
            <span className="ml-2 text-xs px-1.5 py-0.5 rounded-full bg-surface-2 text-muted">{pending_requests.length}</span>
          </h2>
          <div className="flex flex-col gap-2">
            {pending_requests.map(req => (
              <div key={req.id} className="flex items-center justify-between gap-3 py-2 border-t border-border first:border-t-0">
                <div className="flex flex-col min-w-0">
                  <span className="text-foreground text-sm truncate">{req.email || req.user_id}</span>
                  <span className="text-muted text-xs">{new Date(req.created_at).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => acceptRequest(req.id)} className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors cursor-pointer">Accept</button>
                  <button onClick={() => declineRequest(req.id)} className="px-3 py-1.5 rounded-md border border-border text-muted text-xs hover:text-foreground hover:border-foreground transition-colors cursor-pointer">Decline</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Members list */}
      <div className="flex flex-col gap-3 p-5 rounded-xl bg-surface border border-border">
        <h2 className="text-foreground text-sm font-semibold">Members</h2>
        <div className="flex flex-col">
          {members.map(m => {
            const canChange = isAdmin && !m.is_self && m.member_role !== 'owner'
            const canRemove = isAdmin && !m.is_self && m.member_role !== 'owner'
              && (myRole === 'owner' || m.member_role === 'user')
            return (
              <div key={m.user_id} className="flex items-center gap-3 py-3 border-t border-border first:border-t-0">
                <div className="flex flex-col flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground text-sm truncate">{m.email || m.user_id}</span>
                    {m.is_self && <span className="text-muted text-xs">(you)</span>}
                  </div>
                  <span className="text-muted text-xs">{new Date(m.joined_at).toLocaleDateString()}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {canChange ? (
                    <select
                      value={m.member_role}
                      onChange={e => changeRole(m.user_id, e.target.value)}
                      className="bg-surface-2 border border-border rounded-md px-2 py-1 text-xs text-foreground outline-none focus:border-accent cursor-pointer"
                    >
                      <option value="user">Member</option>
                      <option value="admin">Admin</option>
                      {myRole === 'owner' && <option value="owner">Owner (transfer)</option>}
                    </select>
                  ) : (
                    <RoleBadge role={m.member_role} />
                  )}
                  {canRemove && (
                    <button
                      onClick={() => removeMember(m.user_id, m.email)}
                      className="px-2 py-1 rounded-md border border-border text-muted text-xs hover:text-error hover:border-error transition-colors cursor-pointer"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

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

  if (!combinations.length) return <p className="text-muted text-sm py-4">No estimate combinations configured — run Setup first.</p>
  if (!work.length)         return <p className="text-muted text-sm py-4">No workflow steps found — add steps in Workflows first.</p>

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

function EstimatesTab() {
  const { isAdmin } = useAuth()
  const [showWizard, setShowWizard] = useState(false)
  const [reloadKey, setReloadKey]   = useState(0)
  const [randomizing, setRandomizing] = useState(false)

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

  const btn = 'px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer border transition-colors'

  return (
    <div className="flex flex-col gap-4 p-4 flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <button onClick={handleSetupClick} className={cn(btn, 'border-accent text-accent hover:bg-accent/10')}>
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
      <div className="flex-1 overflow-auto">
        <MatrixTable reloadKey={reloadKey} />
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

function ConfirmModal({ message, onClose, onConfirm }) {
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
            {busy ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </Overlay>
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
    <div className="flex flex-col gap-4 p-6">
      {/* Toolbar */}
      <div className="flex items-center gap-2">
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
      <TabBar active={activeTab} onChange={setTab} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'Members'   && <MembersTab />}
        {activeTab === 'Estimates' && <EstimatesTab />}
        {activeTab === 'Workflows' && <WorkflowsTab />}
        {activeTab === 'Settings'  && <SettingsTab />}
      </div>
    </div>
  )
}
