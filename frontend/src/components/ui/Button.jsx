import { cn } from '../../lib/utils'

const VARIANTS = {
  primary: 'bg-accent text-white border-transparent hover:bg-accent-hover',
  secondary: 'bg-surface-2 text-foreground border-border hover:bg-surface-3',
  ghost: 'bg-transparent text-muted border-transparent hover:text-foreground hover:bg-surface-2',
  danger: 'bg-error-tint text-error border-error/25 hover:bg-error/20',
}

const SIZES = {
  sm: 'h-6 px-2 text-xs',
  md: 'h-7 px-3 text-xs',
  lg: 'h-8 px-3.5 text-sm',
}

export default function Button({ variant = 'secondary', size = 'md', className, type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium border whitespace-nowrap cursor-pointer transition-colors',
        'disabled:opacity-45 disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55',
        VARIANTS[variant] || VARIANTS.secondary,
        SIZES[size] || SIZES.md,
        className
      )}
      {...props}
    />
  )
}
