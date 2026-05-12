import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'

export default function AdminPanel() {
  const [settings, setSettings]   = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [saving, setSaving]       = useState(false)
  const [saveMsg, setSaveMsg]     = useState(null) // 'ok' | 'err'

  // Local edit state
  const [inviteRequired, setInviteRequired] = useState(false)
  const [inviteCode, setInviteCode]         = useState('')

  useEffect(() => {
    apiFetch('/api/admin/settings')
      .then(data => {
        setSettings(data)
        setInviteRequired(data.registration_invite_required ?? false)
        setInviteCode(data.registration_invite_code ?? '')
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setSaveMsg(null)
    try {
      const updated = await apiFetch('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          registration_invite_required: inviteRequired,
          registration_invite_code:     inviteCode,
        }),
      })
      setSettings(updated)
      setSaveMsg('ok')
    } catch (err) {
      console.error(err)
      setSaveMsg('err')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 3000)
    }
  }

  const inputCls = 'bg-surface-2 border border-border rounded-lg px-3 py-2 text-foreground text-sm outline-none focus:border-accent font-mono tracking-widest uppercase'
  const btnPrimary = 'px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-50'

  return (
    <main className="flex-1 overflow-auto p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-8">
        <div>
          <h1 className="text-foreground text-xl font-semibold">Platform settings</h1>
          <p className="text-muted text-sm mt-1">Visible only to platform admins.</p>
        </div>

        {loading && <p className="text-muted text-sm">Loading…</p>}
        {error   && <p className="text-error text-sm">Failed to load settings: {error}</p>}

        {settings && (
          <form onSubmit={handleSave} className="flex flex-col gap-6">

            {/* Registration gate */}
            <section className="flex flex-col gap-4 p-5 rounded-xl border border-border bg-surface">
              <div>
                <h2 className="text-foreground text-sm font-semibold">Registration gate</h2>
                <p className="text-muted text-xs mt-0.5">
                  When enabled, new users must enter this code to proceed through sign-up.
                </p>
              </div>

              <label className="flex items-center gap-3 cursor-pointer select-none">
                <div
                  onClick={() => setInviteRequired(v => !v)}
                  className={`relative w-9 h-5 rounded-full transition-colors cursor-pointer ${inviteRequired ? 'bg-accent' : 'bg-surface-3 border border-border'}`}
                >
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${inviteRequired ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <span className="text-foreground text-sm">
                  {inviteRequired ? 'Invite code required to register' : 'Open registration (no code required)'}
                </span>
              </label>

              {inviteRequired && (
                <div className="flex flex-col gap-1">
                  <label className="text-muted text-xs">Access code</label>
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={e => setInviteCode(e.target.value.toUpperCase())}
                    placeholder="e.g. ARTHOUND"
                    className={inputCls}
                  />
                  <p className="text-muted text-xs mt-0.5">
                    Share this code with users you want to allow to register.
                  </p>
                </div>
              )}
            </section>

            <div className="flex items-center gap-3">
              <button type="submit" disabled={saving} className={btnPrimary}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              {saveMsg === 'ok'  && <span className="text-success text-sm">Saved</span>}
              {saveMsg === 'err' && <span className="text-error text-sm">Failed to save — try again</span>}
            </div>

          </form>
        )}
      </div>
    </main>
  )
}
