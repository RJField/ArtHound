import { cn } from '../../lib/utils'

// Dense data-table primitives. Fixed density: 30px rows, 11px uppercase headers,
// tabular numerals. Selection = accent tint + 2px left rail.
//
// <Table>
//   <thead><tr><Th>Name</Th>…</tr></thead>
//   <tbody><Tr selected={…} onClick={…}><Td primary>…</Td>…</Tr></tbody>
// </Table>

export function Table({ className, ...props }) {
  return <table className={cn('w-full border-collapse text-xs', className)} {...props} />
}

export function Th({ className, ...props }) {
  return (
    <th
      className={cn(
        'sticky top-0 z-10 bg-surface text-left font-medium text-[11px] uppercase tracking-wider text-faint',
        'px-2.5 h-[30px] border-b border-border whitespace-nowrap',
        className
      )}
      {...props}
    />
  )
}

export function Tr({ selected, className, ...props }) {
  return (
    <tr
      className={cn(
        'transition-colors',
        props.onClick && 'cursor-pointer',
        selected
          ? 'bg-accent-tint shadow-[inset_2px_0_0_var(--color-accent)]'
          : 'hover:bg-surface-2',
        className
      )}
      {...props}
    />
  )
}

export function Td({ primary, className, ...props }) {
  return (
    <td
      className={cn(
        'px-2.5 h-[30px] border-b border-border-soft whitespace-nowrap overflow-hidden text-ellipsis max-w-[260px] tabular-nums',
        primary ? 'text-foreground font-medium' : 'text-muted',
        className
      )}
      {...props}
    />
  )
}
