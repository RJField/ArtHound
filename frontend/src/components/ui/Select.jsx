import { cn } from '../../lib/utils'
import { inputBase } from './Input'

const SIZES = {
  sm: 'h-6 px-1.5 text-xs',
  md: 'h-7 px-2 text-xs',
  lg: 'h-8 px-2.5 text-sm',
}

export default function Select({ size = 'md', className, ...props }) {
  return <select className={cn(inputBase, 'cursor-pointer', SIZES[size] || SIZES.md, className)} {...props} />
}
