import { cn } from '../../lib/utils'

// Standard page header: display title left, actions right, optional subtitle.
export default function PageHeader({ title, subtitle, actions, className }) {
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold text-foreground tracking-tight">{title}</h1>
        {subtitle && <p className="text-xs text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}
