import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import SyntheticDataModal from '../components/SyntheticDataModal'
import { Button, Card, Field, Input, PageHeader, Spinner } from '../components/ui'

export default function AdminPanel() {
  const [settings, setSettings]   = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [saving, setSaving]       = useState(false)
  const [saveMsg, setSaveMsg]     = useState(null) // 'ok' | 'err'

  // Local edit state
  const [inviteRequired, setInviteRequired] = useState(false)
  const [inviteCode, setInviteCode]         = useState('')

  const [syntheticOpen, setSyntheticOpen] = useState(false)

  // Maintenance actions
  const [reconciling, setReconciling]       = useState(false)
  const [reconcileMsg, setReconcileMsg]     = useState(null) // 'ok' | 'err'
  const [purging, setPurging]               = useState(false)
  const [purgeResult, setPurgeResult]       = useState(null)
  const [purgeError, setPurgeError]         = useState(null)

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

  async function handleReconcile() {
    setReconciling(true)
    setReconcileMsg(null)
    try {
      await apiFetch('/api/schedule/reconcile-work', { method: 'POST' })
      setReconcileMsg('ok')
    } catch (err) {
      console.warn('Reconcile error:', err)
      setReconcileMsg('err')
    } finally {
      setReconciling(false)
      setTimeout(() => setReconcileMsg(null), 4000)
    }
  }

  async function handlePurgeAttachments() {
    setPurging(true)
    setPurgeResult(null)
    setPurgeError(null)
    try {
      const result = await apiFetch('/api/attachments/admin/purge', { method: 'POST' })
      setPurgeResult(result)
    } catch (err) {
      setPurgeError(err.message)
    } finally {
      setPurging(false)
    }
  }

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

  return (
    <main className="flex-1 overflow-auto p-8">
      <div className="max-w-lg mx-auto flex flex-col gap-8">
        <PageHeader
          title="Platform settings"
          subtitle="Visible only to platform admins."
        />

        {loading && (
          <div className="flex items-center gap-2 text-muted text-sm">
            <Spinner size={14} />
            Loading…
          </div>
        )}
        {error && <p className="text-error text-sm">Failed to load settings: {error}</p>}

        {/* Maintenance actions — available regardless of settings load state */}
        <Card title="Maintenance" className="flex flex-col">
          <p className="text-muted text-xs -mt-2 mb-4">One-off admin operations.</p>

          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <Button onClick={handleReconcile} disabled={reconciling}>
                {reconciling ? 'Reconciling…' : 'Reconcile work'}
              </Button>
              {reconcileMsg === 'ok'  && <span className="text-success text-sm">Done</span>}
              {reconcileMsg === 'err' && <span className="text-error text-sm">Failed</span>}
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-3">
                <Button onClick={handlePurgeAttachments} disabled={purging}>
                  {purging ? 'Purging…' : 'Purge orphaned attachments'}
                </Button>
              </div>
              {purgeResult && (
                <p className="text-xs text-muted">
                  Deleted {purgeResult.deleted}, kept {purgeResult.kept}
                  {purgeResult.errors > 0 && `, ${purgeResult.errors} errors`}
                </p>
              )}
              {purgeError && <p className="text-xs text-error">{purgeError}</p>}
            </div>
          </div>
        </Card>

        {/* Synthetic data */}
        <Card title="Synthetic data" className="flex flex-col">
          <p className="text-muted text-xs -mt-2 mb-4">Generate test records in an Airtable base.</p>
          <Button onClick={() => setSyntheticOpen(true)} className="self-start">
            Open wizard
          </Button>
        </Card>

        {settings && (
          <form onSubmit={handleSave} className="flex flex-col gap-6">

            {/* Registration gate */}
            <Card title="Registration gate" className="flex flex-col">
              <p className="text-muted text-xs -mt-2 mb-4">
                When enabled, new users must enter this code to proceed through sign-up.
              </p>

              <div className="flex flex-col gap-4">
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
                  <Field
                    label="Access code"
                    hint="Share this code with users you want to allow to register."
                  >
                    <Input
                      size="lg"
                      type="text"
                      value={inviteCode}
                      onChange={e => setInviteCode(e.target.value.toUpperCase())}
                      placeholder="e.g. ARTHOUND"
                      className="font-mono tracking-widest uppercase"
                    />
                  </Field>
                )}
              </div>
            </Card>

            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" size="lg" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {saveMsg === 'ok'  && <span className="text-success text-sm">Saved</span>}
              {saveMsg === 'err' && <span className="text-error text-sm">Failed to save — try again</span>}
            </div>

          </form>
        )}
      </div>
      {syntheticOpen && <SyntheticDataModal onClose={() => setSyntheticOpen(false)} />}
    </main>
  )
}
