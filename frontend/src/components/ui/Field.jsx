import { cn } from '../../lib/utils'

// Label + control + optional hint/error wrapper for forms.
export default function Field({ label, hint, error, className, children }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      {label && <span className="text-xs text-muted">{label}</span>}
      {children}
      {error ? (
        <span className="text-xs text-error">{error}</span>
      ) : hint ? (
        <span className="text-xs text-faint">{hint}</span>
      ) : null}
    </label>
  )
}
