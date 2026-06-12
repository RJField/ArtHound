import { cn } from '../../lib/utils'

// 11px uppercase section label for detail panels and form groups.
export default function SectionLabel({ className, ...props }) {
  return (
    <div
      className={cn('text-[11px] font-medium uppercase tracking-wider text-faint', className)}
      {...props}
    />
  )
}
