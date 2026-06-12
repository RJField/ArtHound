# ArtHound UI redesign — inventory, direction, and execution plan

Status: **PROPOSAL — awaiting approval. No app code changed.**
Mockups: open the `.html` files in this folder in a browser (PNG renders alongside).

- `01-tokens.html` — proposed design system (palette, borders, controls, pills, table density, type scale)
- `02-assets.html` — Assets 3-panel viewer
- `03-home.html` — Studio Home dashboard
- `04-reviews.html` — Reviews split view

## 1 · Inventory findings

~14 screens (8 PageContainer pages, 5 full-bleed tools, auth flows) + ~20 modals.
Theme is Tailwind v4 CSS vars in `frontend/src/index.css`. lucide-react icons, sonner toasts.

**Systemic issues found:**

1. **Saturated purple chrome.** Background `#0d0a1a`, borders `#3a2f6b`, muted text `#a89cd6` —
   every border and secondary label carries color, so on dense screens the chrome competes
   with the data instead of receding.
2. **No component primitives.** Buttons/inputs/modals/tables/cards are hand-rolled per file
   (~2,200 className strings). OrgHub and AdminPanel each define their own `btnPrimary`.
3. **Focus states: 4+ different patterns**, including `focus:ring-primary` in
   SyntheticDataModal.jsx referencing a CSS var that doesn't exist (bug).
4. **Border opacity chaos**: `border-border`, `/40`, `/50`, `/60` with no semantics.
5. **Button geometry mismatch**: primary `px-4 py-2 rounded-lg` vs secondary `px-3 py-1.5 rounded-md`.
6. **Status colors hardcoded as hex** in Reviews.jsx and ScenarioViewer.jsx instead of shared tokens.
7. **Link color split**: `text-p2` (blue) in DetailModal vs `text-accent` (purple) elsewhere.
8. **Close buttons**: text "×" in some modals, lucide `<X/>` in others.
9. **Density inconsistency**: table rows range `py-1.5` to `py-3`; 14px base font is generous
   for a data tool.
10. **Empty/loading states ad-hoc**: mixed "Loading…" text vs skeletons, varied empty-state styling.

## 2 · Design direction: "graphite + violet"

- **Neutral chrome.** Surfaces/borders/secondary text drop to near-neutral graphite with a
  faint cool cast. The dark identity stays; the lavender haze goes.
- **Purple = action.** Accent `#7c6af4` is reserved for primary buttons, selection
  (tinted row + 2px left rail), focus rings, and active nav. Because nothing else is
  saturated, these now pop with zero extra weight.
- **Denser baseline.** 13px UI font (from 14), 12px table cells, 30px rows, 28px controls,
  tabular numerals, 11px uppercase column headers in `--faint`.
- **Three border tiers.** `--border` (structural), `--border-soft` (rows/dividers),
  `--border-faint` (hairlines). Replaces ad-hoc opacities.
- **Two radii.** 6px controls, 10px panels/modals. Nothing else.
- **One focus treatment.** 2px accent ring on every focusable control.
- **Status pills everywhere** a status appears in a table — single 12% tint level,
  colors from one shared module.

## 3 · Execution plan (phased, each phase shippable)

### Phase 1 — Tokens (small diff, app-wide effect)
Rewrite the `@theme` block in `index.css` with the new palette + border tiers + type/density
tokens. Add `--color-primary` cleanup (fix the undefined var usage). Keep old var names
working (`--color-surface-2` etc.) so no component breaks; add new ones (`--color-border-soft`,
`--color-border-faint`, `--color-faint`).

### Phase 2 — Primitives (`frontend/src/components/ui/`)
`Button` (primary/secondary/ghost/danger × md/lg), `Input`, `Select`, `Textarea`,
`Modal` (overlay + panel + header w/ lucide X + footer), `Pill`/`StatusPill`,
`Tabs`, `EmptyState`, `Spinner`/`Skeleton`, `Dropdown`, `DataTable` (sticky header,
density, selection rail), `KVRow`. Plus `lib/statusColors.js` (review status, priority,
craft colors — removes the hex maps in Reviews.jsx / ScenarioViewer.jsx).

### Phase 3 — Dense tools migration (highest value)
Assets 3-panel → Reviews → OrgHub (Estimates matrix + Workflows + Members) → ScenarioViewer.
Adopt DataTable + toolbar pattern (search / filters / columns left, bulk + primary actions
right), selection bar, status bar with counts.

### Phase 4 — Pages + modals sweep
Home dashboards, Vendors/Studios/Inbox, AdminPanel, auth/onboarding screens, then the
~20 modals onto the Modal primitive. Delete per-file button/input class strings.

### Phase 5 — Polish pass
Empty states, skeletons, keyboard affordances (`/` to search), and a final screen-by-screen
consistency check against the token sheet.

## 4 · Open decisions for review

1. **Palette neutrality** — mockups use near-neutral graphite (`#131217` bg). Could keep
   slightly more violet in surfaces if the brand feel reads too cold.
2. **Row density default** — mockups use 30px rows. Could add a per-user density toggle
   (compact 26 / default 30 / relaxed 36) on DataTable from day one, or defer.
3. **Status pills vs plain text** in very wide tables — pills add scanability but visual
   weight; could use colored-dot + text for low-key columns.
4. **Scope of Phase 3 vs 4 ordering** — dense tools first (proposed) or quick full-app
   token flip first, component migration after.
