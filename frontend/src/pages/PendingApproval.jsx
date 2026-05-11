import { useAuth } from '../contexts/AuthContext'

export default function PendingApproval() {
  const { pendingOrg, signOut } = useAuth()

  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-6 px-4">
      <div className="flex flex-col items-center gap-4 max-w-sm text-center">
        <div className="w-12 h-12 rounded-full bg-surface-2 border border-border flex items-center justify-center">
          <svg className="w-6 h-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2m6-2a10 10 0 11-20 0 10 10 0 0120 0z" />
          </svg>
        </div>

        <div className="flex flex-col gap-1">
          <h1 className="text-foreground text-lg font-semibold">Awaiting approval</h1>
          {pendingOrg?.org_name ? (
            <p className="text-muted text-sm">
              Your request to join <span className="text-foreground font-medium">{pendingOrg.org_name}</span> is pending.
              An admin needs to accept your request before you can access the app.
            </p>
          ) : (
            <p className="text-muted text-sm">
              Your membership request is pending admin approval.
            </p>
          )}
        </div>

        <p className="text-muted text-xs">
          There's nothing else you need to do — just check back after an admin has reviewed your request.
        </p>

        <button
          onClick={signOut}
          className="mt-2 px-4 py-2 rounded-lg border border-border text-muted text-sm hover:text-foreground hover:border-foreground transition-colors cursor-pointer"
        >
          Sign out
        </button>
      </div>
    </div>
  )
}
