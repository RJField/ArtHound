import { cn } from '../../lib/utils'

const SIZES = {
  sm: 'h-6 px-2 text-xs',
  md: 'h-7 px-2.5 text-xs',
  lg: 'h-8 px-3 text-sm',
}

export const inputBase =
  'bg-surface-2 border border-border rounded-md text-foreground placeholder:text-faint outline-none ' +
  'focus:border-accent focus:ring-2 focus:ring-accent/25 transition-colors ' +
  'disabled:opacity-45 disabled:cursor-not-allowed'

export default function Input({ size = 'md', className, ...props }) {
  return <input className={cn(inputBase, SIZES[size] || SIZES.md, className)} {...props} />
}
