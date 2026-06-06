import { cn } from '../lib/utils'

// Standard page wrapper for ArtHound content pages.
//
// All standard content pages render their body inside <PageContainer>. It owns
// the one rule that every page must obey: the content column is horizontally
// centered (mx-auto) so it never hugs the left edge on wide screens. Picking a
// max width via the `width` prop keeps the line length readable; centering is
// non-negotiable and baked in here so no page can forget it.
//
// Full-bleed multi-panel tools (Assets, Reviews, Estimates, Scenario Planner)
// manage their own edge-to-edge layout and intentionally do NOT use this.
//
// Padding/gap stay per-page via `className` (pages differ: p-6/p-8, gap-4/6/8).

const WIDTHS = {
  sm: 'max-w-3xl',   // dense settings / connection hubs
  md: 'max-w-4xl',   // default — home dashboards, forms
  lg: 'max-w-6xl',   // list-heavy pages that want more horizontal room
}

export default function PageContainer({ width = 'md', className, children, ...props }) {
  return (
    <main className={cn('flex-1 w-full mx-auto flex flex-col', WIDTHS[width], className)} {...props}>
      {children}
    </main>
  )
}
