import { cn } from '../../lib/utils'

// Key-value row for detail panels. Stack inside a plain div; rows draw their own hairline.
export default function KV({ label, labelWidth = 'w-28', className, children }) {
  return (
    <div className={cn('flex gap-3 py-1.5 border-b border-border-faint last:border-b-0 text-xs', className)}>
      <span className={cn('shrink-0 text-faint', labelWidth)}>{label}</span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  )
}
