import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

// Generic anchored popover (column pickers, filter menus, account menus).
// `trigger` is a render prop receiving ({ open, toggle }).
export default function Dropdown({ trigger, align = 'right', width = 'w-52', panelClassName, className, children }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={cn(
            'absolute top-full mt-1 z-30 bg-surface border border-border rounded-lg shadow-(--ah-shadow-md) py-1',
            align === 'right' ? 'right-0' : 'left-0',
            width,
            panelClassName
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}
