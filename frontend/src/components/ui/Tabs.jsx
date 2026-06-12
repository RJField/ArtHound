import { cn } from '../../lib/utils'

// Underline tab bar. tabs: [{ id, label, count? }]
export default function Tabs({ tabs, active, onChange, className }) {
  return (
    <div className={cn('flex border-b border-border overflow-x-auto', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn(
            'px-3 py-1.5 text-xs font-medium whitespace-nowrap cursor-pointer transition-colors border-b-2 -mb-px',
            active === tab.id
              ? 'border-accent text-foreground'
              : 'border-transparent text-muted hover:text-foreground'
          )}
        >
          {tab.label}
          {tab.count != null && <span className="ml-1.5 text-faint tabular-nums">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}
