import { cn } from '../../lib/utils'

const TONES = {
  success: 'bg-success-tint text-success',
  info: 'bg-info-tint text-info',
  warning: 'bg-warning-tint text-warning',
  error: 'bg-error-tint text-error',
  accent: 'bg-accent-tint text-accent-hover',
  neutral: 'bg-surface-2 text-muted border border-border-soft',
}

// Small rounded badge for org roles, sync state, dispatch state, counts.
// For statuses inside data tables prefer <StatusDot /> (dot + plain text).
export default function Pill({ tone = 'neutral', className, ...props }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-px rounded-full text-[11px] font-medium whitespace-nowrap leading-normal',
        TONES[tone] || TONES.neutral,
        className
      )}
      {...props}
    />
  )
}
