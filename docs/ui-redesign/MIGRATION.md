# UI migration guide — component library adoption

Authoritative rules for migrating screens onto `frontend/src/components/ui/`.
Read fully before editing. The goal is **visual/structural consolidation only** —
zero behavior change. Do not alter data fetching, handlers, props contracts,
state logic, or routing.

## Library

Import from the barrel: `import { Button, Input, Select, Textarea, Field, Modal, Pill, StatusDot, Tabs, Card, KV, Table, Th, Tr, Td, EmptyState, Spinner, Skeleton, Dropdown, PageHeader, SectionLabel } from '../components/ui'` (adjust relative path; from `pages/` it is `../components/ui`, from `components/` it is `./ui`, from `components/assets/` it is `../ui`).

Colors for statuses/priorities/crafts: `import { statusColor, statusTone, priorityColor, craftColor, TONES } from '../lib/statusColors'`.

### Component APIs

- `<Button variant="primary|secondary|ghost|danger" size="sm|md|lg">` — sm=24px (inline/dense bars), md=28px (default toolbars), lg=32px (forms, modal footers). Default variant `secondary`, size `md`. `type="button"` is the default.
- `<Input size="sm|md|lg" />`, `<Select size />`, `<Textarea />` — all standard props pass through.
- `<Field label="Email" hint error>` — wraps a control with label + hint/error. Use in forms/modals instead of bespoke `<label>` markup.
- `<Modal title onClose footer width="max-w-lg" closeOnOverlay bodyClassName>` — overlay + panel + header (lucide X) + scrollable body + footer. Replace ALL bespoke modal overlays with this, including text-"×" close buttons. `footer` typically: `<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" size="lg" onClick={save}>Save</Button></>`.
- `<Pill tone="success|info|warning|error|accent|neutral">` — for role badges, sync state, dispatch state, "Soon"/"Ask" markers. NOT for statuses in data tables.
- `<StatusDot label={status} color={optional} />` — colored dot + plain text. THE way to render status/priority values inside tables and lists. Default color comes from `statusColor(label)` keyword heuristic; pass `color={priorityColor(p)}` or `color={craftColor(name)}` when you have a more specific mapping.
- `<Tabs tabs={[{id,label,count?}]} active onChange />` — underline style.
- `<Card title actions pad>` — section card (`bg-surface border border-border rounded-lg p-4`).
- `<KV label labelWidth="w-28">value</KV>` — key-value rows in detail panels.
- `<Table>/<Th>/<Tr selected onClick>/<Td primary>` — dense table: 30px rows, 11px uppercase headers, sticky `<Th>`, hover + selection rail built in. `<Td primary>` for the name/identity column, plain `<Td>` renders muted.
- `<EmptyState icon={LucideIcon} title hint action />` — every "No X yet" / "Select a Y" message.
- `<Spinner size />`, `<Skeleton className="h-7 w-12" />` — loading states. Replace bare "Loading…" text where a spinner/skeleton fits naturally.
- `<Dropdown trigger={({open, toggle}) => <Button onClick={toggle}>…</Button>} align width>` — anchored popovers (column pickers, filter menus). Handles click-outside + Escape.
- `<PageHeader title subtitle actions />` — top of PageContainer pages.
- `<SectionLabel>` — 11px uppercase group label in detail panels/forms.

## Hard rules

1. **No behavior changes.** Same handlers, same conditional rendering, same data. If a
   component initializes `useState` from props with a `useEffect` sync — keep it.
2. **No hex colors in JSX.** Anything status/priority/craft-like resolves through
   `lib/statusColors.js`. Other colors use theme classes (`text-muted`, `bg-surface-2`, …).
3. **Border tiers replace ad-hoc opacities.** `border-border` = structural (panel edges,
   inputs, modals). `border-border-soft` = internal dividers, table rows (replaces
   `border-border/40|/50|/60`). `border-border-faint` = hairlines (kv rows, dense grids).
4. **Text tiers:** `text-foreground` (primary), `text-muted` (secondary), `text-faint`
   (tertiary labels/hints — replaces `text-disabled` used as text color and most `text-muted` on
   11px labels).
5. **Radii:** `rounded-md` (6px) for controls, `rounded-lg` (8px) for panels/cards/modals.
   Replace `rounded-xl` containers with `rounded-lg` unless it's a full-page hero card.
6. **One focus treatment** — comes free with the library; delete bespoke
   `focus:ring-primary` (undefined var — bug), `focus:border-accent`-only variants on
   migrated controls.
7. **Statuses in tables = `<StatusDot>`** (dot + plain text), not pills, not raw text.
8. **Links** are `text-link hover:underline` (theme var) — replaces both `text-accent` and
   `text-p2` link styling.
9. **Tables**: migrate to `Table/Th/Tr/Td`. Keep column logic (visible columns, widths)
   intact; only swap presentation. Keep `tabular-nums` (built into Td).
10. **Page structure:** PageContainer pages keep PageContainer and gain `<PageHeader>`.
    Full-bleed tools (Assets, Reviews, OrgHub, ScenarioPlanner, Estimates) stay full-bleed.
11. **Don't touch files outside your assigned list.** Don't edit the `ui/` library itself —
    if it's missing something you need, compose with `className` overrides.
12. After editing, run `npx eslint <your files>` from `frontend/` and fix anything it reports.

## Style vocabulary (for hand-written bits that aren't components)

- Toolbar rows on dense tools: `flex items-center gap-2 px-3 py-2 border-b border-border bg-surface`.
- Sidebar/list selected item: `bg-accent-tint text-foreground shadow-[inset_2px_0_0_var(--color-accent)]`; hover: `hover:bg-surface-2`.
- Mono values (IDs, codes, asset numbers): `font-mono text-xs`.
- Counts in labels: `text-faint tabular-nums`.
