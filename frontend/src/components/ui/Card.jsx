import { cn } from '../../lib/utils'

// Section card. With `title`, renders a header row (title left, actions right).
export default function Card({ title, actions, pad = true, className, children }) {
  return (
    <div className={cn('bg-surface border border-border rounded-lg', pad && 'p-4', className)}>
      {(title || actions) && (
        <div className={cn('flex items-center justify-between gap-3', pad ? 'mb-3' : 'px-4 pt-4 mb-3')}>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
