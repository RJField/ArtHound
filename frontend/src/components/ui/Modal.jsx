import { useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'

// Standard modal: overlay + panel + header (title, lucide X) + scrollable body + optional footer.
// Parent controls mounting (render conditionally); onClose wires the X, Escape, and overlay click.
export default function Modal({
  title,
  onClose,
  footer,
  width = 'max-w-lg',
  closeOnOverlay = true,
  className,
  bodyClassName,
  children,
}) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onMouseDown={closeOnOverlay && onClose ? (e) => e.target === e.currentTarget && onClose() : undefined}
    >
      <div
        className={cn(
          'bg-surface border border-border rounded-lg shadow-(--ah-shadow-lg) w-full max-h-[85vh] flex flex-col',
          width,
          className
        )}
      >
        {(title || onClose) && (
          <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border-soft shrink-0">
            <h2 className="text-[15px] font-semibold text-foreground truncate">{title}</h2>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-muted hover:text-foreground cursor-pointer p-1 -m-1 rounded-md transition-colors"
              >
                <X size={16} />
              </button>
            )}
          </div>
        )}
        <div className={cn('flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-border-soft shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
