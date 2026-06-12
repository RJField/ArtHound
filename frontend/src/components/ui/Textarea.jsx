import { cn } from '../../lib/utils'
import { inputBase } from './Input'

export default function Textarea({ className, ...props }) {
  return <textarea className={cn(inputBase, 'px-2.5 py-2 text-sm leading-relaxed', className)} {...props} />
}
