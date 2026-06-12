import { cn } from '../../lib/utils'
import { statusColor } from '../../lib/statusColors'

// Status rendering for data tables: colored dot + plain text.
// Pass `color` (any CSS color) to override the keyword heuristic.
export default function StatusDot({ label, color, className }) {
  if (!label) return null
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap', className)}>
      <span
        className="w-1.5 h-1.5 rounded-full shrink-0"
        style={{ background: color || statusColor(label) }}
      />
      <span className="truncate">{label}</span>
    </span>
  )
}
