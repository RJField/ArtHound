import { cn } from '../../lib/utils'

export default function EmptyState({ icon: Icon, title, hint, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center gap-1.5 py-10 px-4', className)}>
      {Icon && <Icon size={20} className="text-faint mb-1" />}
      <p className="text-sm text-muted">{title}</p>
      {hint && <p className="text-xs text-faint max-w-sm">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}
