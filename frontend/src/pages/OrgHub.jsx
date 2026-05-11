import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '../lib/api'
import { useAuth } from '../contexts/AuthContext'

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', user: 'Member' }
const ROLE_ORDER  = { owner: 0, admin: 1, user: 2 }

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

export default function OrgHub() {
  const { isAdmin, profile } = useAuth()
  const myUserId = profile?.id

  const [hub, setHub]           = useState(null)
  const [loading, setLoading]   = useState(true)
  const [copied, setCopied]     = useState(false)
  const [regen, setRegen]       = useState(false)

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

  if (loading) {
    return (
      <div className="flex items-center justify-center flex-1 py-24">
        <p className="text-muted text-sm">Loading…</p>
      </div>
    )
  }

  if (!hub) return null

  const { org, members, pending_requests } = hub
  const myRole = members.find(m => m.user_id === myUserId)?.member_role

  return (
    <div className="flex flex-col gap-6 p-6 max-w-2xl mx-auto w-full">

      {/* Org info + invite code */}
      <div className="flex flex-col gap-4 p-5 rounded-xl bg-surface border border-border">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-foreground text-lg font-semibold">{org.name}</h1>
            <p className="text-muted text-xs capitalize mt-0.5">{org.handle ? `@${org.handle} · ` : ''}{hub.members.length} member{hub.members.length !== 1 ? 's' : ''}</p>
          </div>
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

      {/* Pending join requests — admin/owner only */}
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
                  <button
                    onClick={() => acceptRequest(req.id)}
                    className="px-3 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors cursor-pointer"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => declineRequest(req.id)}
                    className="px-3 py-1.5 rounded-md border border-border text-muted text-xs hover:text-foreground hover:border-foreground transition-colors cursor-pointer"
                  >
                    Decline
                  </button>
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

    </div>
  )
}
