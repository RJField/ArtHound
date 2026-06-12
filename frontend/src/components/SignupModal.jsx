import { useState, useEffect } from 'react'
import { apiFetch } from '../lib/api'
import { Button, Field, Input, Modal, Pill } from './ui'

const STEP = {
  SYSTEM_INVITE:   -1, // ArtHound-level gate (shown only when required)
  CHOICE:           0, // create new org vs join existing
  ROLE:             1, // studio or vendor (create path)
  CREDENTIALS:      2, // org name + email + password (create path)
  HANDLE:           3, // vendor handle (create path)
  JOIN_CODE:        4, // invite code entry + live validation (join path)
  JOIN_CREDENTIALS: 5, // email + password (join path)
  SUCCESS:          6,
}

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{2,31}$/
const HANDLE_HINT = 'Lowercase letters, numbers, hyphens and underscores only. 3–32 characters.'

function handleErrorMessage(detail) {
  if (detail === 'HANDLE_TAKEN')          return 'That handle is already taken — try a different one.'
  if (detail === 'HANDLE_INVALID')        return HANDLE_HINT
  if (detail === 'INVITE_CODE_INVALID')   return 'Invite code not found. Check the code and try again.'
  if (detail === 'ROLE_ORG_MISMATCH')     return 'This invite code is for a different account type.'
  if (detail === 'SYSTEM_INVITE_INVALID') return 'Invalid access code. Contact ArtHound to get one.'
  return detail
}

function BackRow({ onBack, children }) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={onBack}>←</Button>
      {children}
    </div>
  )
}

export default function SignupModal({ onClose }) {
  // System invite gate state
  const [systemInviteCode, setSystemInviteCode]       = useState('')
  const [systemInviteError, setSystemInviteError]     = useState(null)
  const [systemInviteChecking, setSystemInviteChecking] = useState(false)

  // Create path state
  const [role, setRole]         = useState(null)
  const [orgName, setOrgName]   = useState('')
  const [handle, setHandle]     = useState('')
  const [handleError, setHandleError] = useState(null)

  // Join path state
  const [inviteCode, setInviteCode]       = useState('')
  const [resolvedOrg, setResolvedOrg]     = useState(null)  // {org_name, org_type}
  const [codeError, setCodeError]         = useState(null)
  const [codeChecking, setCodeChecking]   = useState(false)

  // Shared state
  const [step, setStep]         = useState(STEP.CHOICE)
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState(null)
  const [busy, setBusy]         = useState(false)
  const [successData, setSuccessData] = useState(null) // {emailConfirmRequired, pending, org_name}

  // Check whether the platform-level gate is enabled and set the initial step.
  useEffect(() => {
    apiFetch('/api/auth/config')
      .then(data => {
        if (data.registration_invite_required) setStep(STEP.SYSTEM_INVITE)
      })
      .catch(() => {}) // fail open — if we can't reach the config, show the normal flow
  }, [])

  // ── System invite gate ──────────────────────────────────────────────────────

  async function validateSystemInvite(e) {
    e.preventDefault()
    if (!systemInviteCode.trim()) return
    setSystemInviteError(null)
    setSystemInviteChecking(true)
    try {
      await apiFetch(`/api/auth/system-invite/${systemInviteCode.trim().toUpperCase()}/validate`)
      setStep(STEP.CHOICE)
    } catch (err) {
      setSystemInviteError(handleErrorMessage(err.message === 'Not Found' ? 'SYSTEM_INVITE_INVALID' : err.message))
    } finally {
      setSystemInviteChecking(false)
    }
  }

  // ── Create path ─────────────────────────────────────────────────────────────

  function advanceFromCredentials(e) {
    e.preventDefault()
    if (role === 'vendor') setStep(STEP.HANDLE)
    else submitCreate()
  }

  async function submitCreate(e) {
    if (e) e.preventDefault()
    if (role === 'vendor') {
      if (!HANDLE_RE.test(handle)) { setHandleError(HANDLE_HINT); return }
      setHandleError(null)
    }
    setError(null)
    setBusy(true)
    try {
      const body = { email, password, role, org_name: orgName }
      if (role === 'vendor') body.handle = handle
      if (systemInviteCode.trim()) body.system_invite_code = systemInviteCode.trim().toUpperCase()
      const data = await apiFetch('/api/auth/signup', { method: 'POST', body: JSON.stringify(body) })
      setSuccessData({ emailConfirmRequired: data.email_confirmation_required, pending: false })
      setStep(STEP.SUCCESS)
    } catch (err) {
      const msg = handleErrorMessage(err.message)
      if (err.message === 'HANDLE_TAKEN' || err.message === 'HANDLE_INVALID') {
        setHandleError(msg)
        setStep(STEP.HANDLE)
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  // ── Join path ───────────────────────────────────────────────────────────────

  async function resolveCode(e) {
    e.preventDefault()
    if (!inviteCode.trim()) return
    setCodeError(null)
    setResolvedOrg(null)
    setCodeChecking(true)
    try {
      const data = await apiFetch(`/api/invite-code/${inviteCode.trim().toUpperCase()}/resolve`)
      setResolvedOrg(data)
      setStep(STEP.JOIN_CREDENTIALS)
    } catch (err) {
      setCodeError(handleErrorMessage(err.message === 'Not Found' ? 'INVITE_CODE_INVALID' : err.message))
    } finally {
      setCodeChecking(false)
    }
  }

  async function submitJoin(e) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const body = {
        email,
        password,
        role:        resolvedOrg.org_type,
        invite_code: inviteCode.trim().toUpperCase(),
      }
      if (systemInviteCode.trim()) body.system_invite_code = systemInviteCode.trim().toUpperCase()
      const data = await apiFetch('/api/auth/signup', { method: 'POST', body: JSON.stringify(body) })
      setSuccessData({
        emailConfirmRequired: data.email_confirmation_required,
        pending: true,
        org_name: data.org_name,
      })
      setStep(STEP.SUCCESS)
    } catch (err) {
      setError(handleErrorMessage(err.message))
    } finally {
      setBusy(false)
    }
  }

  // ── Shared UI helpers ────────────────────────────────────────────────────────

  const TITLES = {
    [STEP.SYSTEM_INVITE]:    'Access code required',
    [STEP.CHOICE]:           'Get started',
    [STEP.ROLE]:             'What best describes you?',
    [STEP.CREDENTIALS]:      'Create account',
    [STEP.HANDLE]:           'Choose a handle',
    [STEP.JOIN_CODE]:        'Enter invite code',
    [STEP.JOIN_CREDENTIALS]: 'Create account',
    [STEP.SUCCESS]: successData
      ? (successData.emailConfirmRequired ? 'Check your email' : (successData.pending ? 'Request sent' : 'Account created'))
      : '',
  }

  const choiceCardCls = 'px-4 py-3 rounded-lg border border-border text-left text-foreground text-sm hover:border-accent hover:bg-surface-2 transition-colors cursor-pointer'

  return (
    <Modal title={TITLES[step]} onClose={onClose} width="max-w-sm" bodyClassName="flex flex-col gap-5 px-5 py-5">

      {/* SYSTEM_INVITE — platform-level access gate */}
      {step === STEP.SYSTEM_INVITE && (
        <form onSubmit={validateSystemInvite} className="flex flex-col gap-4">
          <p className="text-muted text-sm">
            ArtHound is currently invite-only. Enter your access code to continue.
          </p>
          <Field label="Access code" error={systemInviteError}>
            <Input
              size="lg"
              type="text"
              value={systemInviteCode}
              onChange={e => { setSystemInviteCode(e.target.value.toUpperCase()); setSystemInviteError(null) }}
              required
              autoFocus
              placeholder="XXXXXXXX"
              className="tracking-widest font-mono uppercase"
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" disabled={systemInviteChecking || !systemInviteCode.trim()}>
            {systemInviteChecking ? 'Checking…' : 'Continue →'}
          </Button>
          <button type="button" onClick={onClose} className="text-muted text-xs text-center hover:text-foreground cursor-pointer">
            Cancel
          </button>
        </form>
      )}

      {/* CHOICE — create vs join */}
      {step === STEP.CHOICE && (
        <>
          <div className="flex flex-col gap-3">
            <button onClick={() => setStep(STEP.ROLE)} className={choiceCardCls}>
              <div className="font-medium">Create a new organisation</div>
              <div className="text-muted text-xs mt-0.5">Set up a new studio or vendor account</div>
            </button>
            <button onClick={() => setStep(STEP.JOIN_CODE)} className={choiceCardCls}>
              <div className="font-medium">Join with an invite code</div>
              <div className="text-muted text-xs mt-0.5">Request access to an existing organisation</div>
            </button>
          </div>
          <button onClick={onClose} className="text-muted text-xs text-center hover:text-foreground cursor-pointer">
            Cancel
          </button>
        </>
      )}

      {/* ROLE — studio vs vendor (create path) */}
      {step === STEP.ROLE && (
        <>
          <BackRow onBack={() => setStep(STEP.CHOICE)} />
          <div className="flex flex-col gap-3">
            {['studio', 'vendor'].map(r => (
              <button
                key={r}
                onClick={() => { setRole(r); setStep(STEP.CREDENTIALS) }}
                className={`${choiceCardCls} capitalize`}
              >
                {r === 'studio' ? '🎬 Studio — I manage productions' : '🎨 Vendor — I deliver creative work'}
              </button>
            ))}
          </div>
        </>
      )}

      {/* CREDENTIALS — org name + email + password (create path) */}
      {step === STEP.CREDENTIALS && (
        <form onSubmit={advanceFromCredentials} className="flex flex-col gap-4">
          <BackRow onBack={() => setStep(STEP.ROLE)}>
            <Pill tone="neutral" className="ml-auto capitalize">{role}</Pill>
          </BackRow>
          <Field label={role === 'studio' ? 'Studio name' : 'Vendor / company name'}>
            <Input size="lg" type="text" value={orgName} onChange={e => setOrgName(e.target.value)}
              required autoFocus placeholder={role === 'studio' ? 'Acme Studio' : 'Acme VFX'} />
          </Field>
          <Field label="Email">
            <Input size="lg" type="text" inputMode="email" autoComplete="email" value={email}
              onChange={e => setEmail(e.target.value)} required />
          </Field>
          <Field label="Password">
            <Input size="lg" type="password" value={password} onChange={e => setPassword(e.target.value)}
              required minLength={8} />
          </Field>
          {error && <p className="text-error text-xs">{error}</p>}
          <Button type="submit" variant="primary" size="lg" disabled={busy || !orgName.trim()}>
            {role === 'vendor' ? 'Next →' : (busy ? 'Creating…' : 'Create account')}
          </Button>
        </form>
      )}

      {/* HANDLE — vendor only (create path) */}
      {step === STEP.HANDLE && (
        <form onSubmit={submitCreate} className="flex flex-col gap-4">
          <BackRow onBack={() => setStep(STEP.CREDENTIALS)} />
          <p className="text-muted text-sm">Studios use your handle to find and invite you.</p>
          <Field label="Handle" error={handleError} hint={HANDLE_HINT}>
            <div className="flex items-center h-8 bg-surface-2 border border-border rounded-md px-3 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25 transition-colors">
              <span className="text-muted text-sm select-none mr-0.5">@</span>
              <input type="text" value={handle}
                onChange={e => { setHandle(e.target.value.toLowerCase()); setHandleError(null) }}
                required autoFocus placeholder="acme-vfx"
                className="bg-transparent text-foreground text-sm outline-none flex-1 min-w-0 placeholder:text-faint" />
            </div>
          </Field>
          <Button type="submit" variant="primary" size="lg" disabled={busy || !handle.trim()}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      )}

      {/* JOIN_CODE — enter invite code (join path) */}
      {step === STEP.JOIN_CODE && (
        <form onSubmit={resolveCode} className="flex flex-col gap-4">
          <BackRow onBack={() => setStep(STEP.CHOICE)} />
          <p className="text-muted text-sm">
            Ask an admin at the organisation you're joining for their invite code.
          </p>
          <Field label="Invite code" error={codeError}>
            <Input
              size="lg"
              type="text"
              value={inviteCode}
              onChange={e => { setInviteCode(e.target.value.toUpperCase()); setCodeError(null) }}
              required autoFocus
              placeholder="ABCD1234"
              maxLength={8}
              className="tracking-widest font-mono uppercase"
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" disabled={codeChecking || !inviteCode.trim()}>
            {codeChecking ? 'Checking…' : 'Continue →'}
          </Button>
        </form>
      )}

      {/* JOIN_CREDENTIALS — email + password (join path) */}
      {step === STEP.JOIN_CREDENTIALS && resolvedOrg && (
        <form onSubmit={submitJoin} className="flex flex-col gap-4">
          <BackRow onBack={() => setStep(STEP.JOIN_CODE)} />
          <div className="px-3 py-2 rounded-lg bg-surface-2 border border-border">
            <p className="text-xs text-muted">Requesting access to</p>
            <p className="text-sm text-foreground font-medium">{resolvedOrg.org_name}</p>
            <p className="text-xs text-muted capitalize">{resolvedOrg.org_type}</p>
          </div>
          <Field label="Email">
            <Input size="lg" type="text" inputMode="email" autoComplete="email" value={email}
              onChange={e => setEmail(e.target.value)} required autoFocus />
          </Field>
          <Field label="Password">
            <Input size="lg" type="password" value={password} onChange={e => setPassword(e.target.value)}
              required minLength={8} />
          </Field>
          {error && <p className="text-error text-xs">{error}</p>}
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {busy ? 'Submitting…' : 'Request access'}
          </Button>
        </form>
      )}

      {/* SUCCESS */}
      {step === STEP.SUCCESS && successData && (
        <>
          <p className="text-muted text-sm">
            {successData.emailConfirmRequired ? (
              <>We sent a confirmation link to <span className="text-foreground">{email}</span>. Click it to activate your account, then sign in.</>
            ) : successData.pending ? (
              <>Your request to join <span className="text-foreground">{successData.org_name}</span> is pending admin approval. Sign in after you're approved.</>
            ) : (
              <>Your account is ready. Sign in with <span className="text-foreground">{email}</span>.</>
            )}
          </p>
          <Button variant="primary" size="lg" onClick={onClose}>
            {successData.emailConfirmRequired || successData.pending ? 'Back to sign in' : 'Sign in now'}
          </Button>
        </>
      )}

    </Modal>
  )
}
