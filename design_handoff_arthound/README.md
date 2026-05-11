# Handoff: ArtHound Design System & Studio App UI

## Overview

ArtHound is a canonical production data layer for game studios — it ingests messy
asset, review, and workflow data from existing tools (PLM, file shares, review
boards) and presents one clean, dark-themed control surface for studio leads,
producers, and outsourcing managers.

This handoff covers the **studio-facing web app** (the dark, lavender-accented
React UI) plus the design tokens that govern it. The vendor-facing app and the
Cu-TOOL-u bot panel are referenced but **not yet designed** — see "Out of scope"
below.

## About the design files

The files in this bundle are **design references created in HTML/JSX** —
prototypes that show intended look and behavior. They are **not production code
to copy directly**.

- The **JSX in `ui_kit/`** is plain Babel-in-the-browser JSX wired to an inline
  HTML harness. It demonstrates structure, copy, and styling — it does not use
  React Router, real auth, or real data fetching.
- The **HTML in `preview/`** is a flat catalog of swatches and component cards
  used to visualize the design system.

The implementation task is to **recreate these designs inside the existing
ArtHound codebase** (Vite + React 18 + React Router + Tailwind v4 with `@theme`
custom properties + sonner toasts) using its established patterns. The repo
already has `frontend/src/index.css` defining most of the same tokens under
Tailwind's `@theme`; the goal is parity, not a rewrite.

## Fidelity

**High-fidelity.** Colors, typography, spacing, radii, shadows, and component
chrome are final. Implementers should match values pixel-for-pixel using the
codebase's existing Tailwind theme + `cn()` helper. Copy text in the prototypes
is intentional and should be preserved unless product asks otherwise.

**Typography is now Geist.** Both the prototypes and the production app should
use Geist (loaded from Google Fonts) with `system-ui` as the fallback. This
replaces the earlier Inter substitution. Geist's tightened tracking
(`letter-spacing: -0.005em` on body / nav) is intentional — keep it.

## Files in this bundle

```
design_handoff_arthound/
├── README.md                      ← you are here
├── tokens/
│   └── colors_and_type.css        ← canonical CSS custom properties
├── ui_kit/
│   ├── index.html                 ← harness; open this to view all screens
│   ├── kit.css                    ← shared utility classes
│   ├── Components.jsx             ← Topbar, Button, Pill, Avatar, etc.
│   ├── Login.jsx
│   ├── StudioHome.jsx
│   ├── AssetsScreen.jsx
│   └── NewReviewModal.jsx
├── preview/                       ← design-system catalog (open _card.css consumers individually)
│   ├── colors-brand.html, colors-surface.html, colors-fg.html,
│   │   colors-status.html, colors-priority.html
│   ├── type-scale.html, type-specimen.html
│   ├── spacing-radii.html, shadow-elevation.html
│   ├── components-buttons.html, components-inputs.html, components-pills.html,
│   │   components-cards.html, components-topbar.html, components-modal.html
│   └── brand-logo.html, brand-cutoolu.html
└── assets/
    ├── ArtHound_logo.png          ← latest hand-drawn ArtHound mark (authoritative)
    ├── ArtHound_wordmark.png      ← lockup with tagline
    ├── cutoolu_logo.png           ← latest Cu-TOOL-u mark (Cu-TOOL-u panel only)
    ├── cutoolu_wordmark.png
    ├── favicon.svg                ← saturated violet+cyan, ceremonial only
    ├── icons.svg                  ← brand icon symbols (bluesky, etc.)
    └── hero.png                   ← marketing splash
```

## Design tokens

All tokens live in `tokens/colors_and_type.css` as CSS custom properties under
the `--ah-*` prefix, and are mirrored in the production `frontend/src/index.css`
under Tailwind v4 `@theme`. Use the existing Tailwind names (`bg-surface`,
`text-fg-muted`, `border-border`, etc.) — do not introduce parallel utility
classes.

### Colors — brand

| Token | Hex | Use |
|---|---|---|
| `--ah-brand-purple` / `--ah-accent` | `#7c6af4` | Primary actions, links, focus ring |
| `--ah-brand-purple-soft` / `--ah-fg-link` | `#b6a8ff` | Logo outline tint, link hover |
| `--ah-brand-purple-deep` | `#4d3ad6` | Pressed states |
| `--ah-accent-hover` | `#9b8ef8` | Button hover |
| `--ah-accent-tint` | `rgba(124,106,244,0.10)` | Selected row, focus background |
| `--ah-brand-violet-glow` | `#863bff` | Favicon only |
| `--ah-brand-violet-deep` | `#7e14ff` | Favicon only |
| `--ah-brand-cyan-spark` | `#47bfff` | Favicon accent only — never in chrome |

### Colors — surfaces (dark, near-black with violet hue)

| Token | Hex | Use |
|---|---|---|
| `--ah-bg` | `#0d0a1a` | Page background |
| `--ah-surface` | `#161229` | Cards, top bar, modals |
| `--ah-surface-2` | `#1f1a3a` | Inputs, hover row, sidebar selected |
| `--ah-surface-3` | `#2a2350` | Secondary buttons, deepest chip |
| `--ah-overlay` | `rgba(0,0,0,0.60)` | Modal scrim |
| `--ah-border` | `#3a2f6b` | Default 1px borders |
| `--ah-border-soft` | `#2a2350` | Table row dividers |

### Colors — foreground

| Token | Hex | Use |
|---|---|---|
| `--ah-fg` | `#ece6ff` | Primary text (off-white lavender) |
| `--ah-fg-muted` | `#a89cd6` | Labels, captions, secondary |
| `--ah-fg-disabled` | `#6b62a3` | Disabled |
| `--ah-fg-on-accent` | `#ffffff` | Text on accent fill |

### Colors — status

| Token | Hex | Tint |
|---|---|---|
| `--ah-success` | `#34d399` | `rgba(52,211,153,0.12)` |
| `--ah-info` | `#60a5fa` | `rgba(96,165,250,0.12)` |
| `--ah-warning` | `#fbbf24` | `rgba(251,191,36,0.12)` |
| `--ah-error` | `#f87171` | `rgba(248,113,113,0.12)` |

### Colors — priority scale

`P1 #34d399` (highest) → `P2 #60a5fa` → `P3 #fbbf24` → `P4 #f97316` →
`P5 #f87171` (lowest). Use as backgrounds with white text for priority chips.

### Type

- **Family:** `"Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
  Load Geist from Google Fonts (weights 400/500/600/700). Apply
  `letter-spacing: -0.005em` to body, nav, and button text; `-0.01em` on
  display headings.
- **Mono:** `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace` for
  asset IDs, version numbers, and any tabular data.
- **Scale:** 10 / 12 / 14 / 16 / 18 / 20 / 24 / 30 px. The app is data-heavy —
  default body is **14px**, table cells and chips **12px**, page titles **18px**,
  hero/welcome **24px**.
- **Weights:** 400 regular, 500 medium, 600 semibold, 700 bold.
- **Tracking:** `-0.01em` on display headings, `0.04em` (uppercase) on eyebrows
  and the wordmark.

### Spacing scale

`0 / 4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 px`. Card padding is typically
24px; row gutters 12–16px; chip padding `2px 8–10px`.

### Radii

`4 / 6 / 8 / 12 / 16px / pill`. Buttons **6px**, inputs and small cards **8px**,
primary cards and modals **12px**, chips/pills are full-pill.

### Elevation

| Token | Value | Use |
|---|---|---|
| `--ah-shadow-sm` | `0 1px 2px rgba(0,0,0,0.30)` | Resting cards |
| `--ah-shadow-md` | `0 4px 14px rgba(0,0,0,0.35)` | Hovered cards, dropdowns |
| `--ah-shadow-lg` | `0 24px 48px -12px rgba(0,0,0,0.55)` | Modals |
| `--ah-shadow-glow` | accent ring + 8/24 shadow | Featured/active elements |
| `--ah-ring-focus` | `0 0 0 2px rgba(124,106,244,0.55)` | Keyboard focus |

### Motion

- Fast: **120ms** (button color/border changes)
- Normal: **180ms** (panel/modal open/close)
- Slow: **300ms** (page-level transitions)
- Easing: `cubic-bezier(0.2, 0, 0, 1)` for standard, `cubic-bezier(0.2, 0, 0, 1.1)`
  for emphasized.

## Screens

### 1. Login

**Purpose:** Studio members sign in with email + password. The page also
displays the ArtHound brand at low opacity behind the form for atmosphere.

**Layout:** Single full-bleed centered column. Page bg `--ah-bg`. The logo
backdrop is `ArtHound_logo.png` rendered at ~360px square, **10% opacity**,
centered behind the form, `pointer-events:none`.

**Form card:**
- 360px wide, padding 32px, radius 12px, bg `--ah-surface`, border `--ah-border`.
- Title "Sign in to ArtHound" — 18px / 600.
- Two inputs (email, password). Input chrome: bg `--ah-surface-2`, 1px
  `--ah-border`, radius 8px, padding `8px 12px`, font 14px. Focus → border
  `--ah-accent`, ring `--ah-ring-focus`.
- Primary submit button full-width: bg `--ah-accent`, white text, height 36px,
  radius 6px, font 14px / 500. Hover → `--ah-accent-hover`. Loading state shows
  a small spinner in place of the label.
- Below form: small muted helper "Trouble signing in? Contact your studio admin."
  in `--ah-fg-muted` 12px.

**Behavior:** On submit, `apiFetch('/auth/login', { POST email, password })`,
then redirect to `/home`. On error, render `--ah-error` text under the form
("Invalid credentials") and reset the password field.

### 2. Studio Home

**Purpose:** Logged-in landing. Shows a personal greeting, a snapshot of
in-flight production work, and quick links into the four product areas.

**Layout:**
- **Topbar** (see component spec).
- **Body:** centered max-width 1120px, padding `32px 24px`, gap 32px column.
- Hero row: 112px circular avatar (the ArtHound logo at full opacity, on
  `--ah-surface-2`) + "Welcome back, {name}" 24px / 600 + studio name muted 14px.
- Quick-link grid: 4 cards in a 4-column grid (collapse to 2 cols below 900px).
  Each card: bg `--ah-surface`, border `--ah-border`, radius 12px, padding 24px,
  hover → border `--ah-border-on-accent`. Inside: 32px icon top-left, title
  16px / 600, one-line muted description 12px. Cards: **Assets**,
  **Reviews**, **Workflows**, **Estimates**.
- Below grid: "Activity" panel — bg `--ah-surface`, border, radius 12px,
  padding 16px. Lists last 5 events as rows: priority chip + asset id (mono
  12px) + event text + relative timestamp (`a89cd6`).

### 3. Assets

**Purpose:** Browse, filter, and inspect the studio's catalog of assets
(characters, environments, props). Three-pane layout.

**Layout:**
- **Topbar** at top.
- Below topbar, full-bleed three-pane row, each pane vertically scrolls:
  - **Left sidebar (240px):** Product groups. Each row is a button: padding
    `6px 12px`, radius 6px, font 12px / 500. Inactive → `--ah-fg-muted`. Hover →
    bg `--ah-surface-2`, color `--ah-fg`. Active → bg `--ah-surface-2`,
    color `--ah-fg`, plus 2px left accent bar in `--ah-accent`. A pinned
    "All assets" row sits at the top; below it, products grouped under a small
    eyebrow label "Products" (uppercase 10px, tracking 0.04em, color
    `--ah-fg-muted`, padding `12px 12px 4px`). Each product row may show a
    trailing count chip (the `.chip` style: bg `--ah-surface-2`, 12px).
  - **Center grid (flex 1):** A header row with: search input
    (`<input class="input" placeholder="Search assets…">`, max-width 320px),
    then chip filters (Type, Status, Owner, Priority — each a pill
    `chip` with a chevron). Below: responsive CSS grid `repeat(auto-fill,
    minmax(200px, 1fr))` gap 16px, padding 24px. Each tile: bg `--ah-surface`,
    radius 12px, border `--ah-border`, hover → border `--ah-border-on-accent`.
    Tile content: square thumbnail top (object-fit cover, radius 12px 12px 0 0),
    then padding 12px column with: asset name (14px / 500), asset id (mono 12px,
    `--ah-fg-muted`), and a row of: status pill + priority chip + version chip.
  - **Right detail panel (360px, conditional on selection):** Asset metadata.
    Header section padding 24px: large thumbnail (full width, radius 8px),
    asset name 18px / 600, id mono 12px muted, then a vertical key/value list
    (Owner, Status, Priority, Last review, Versions) — labels 12px muted, values
    14px. Below: action row with `Open in Reviews` (primary) and `Edit`
    (secondary). Below that: a **Linked workflows** list (rows of workflow name
    + state pill).

**Behavior:**
- Sidebar selection filters the grid; selected sidebar item gets the active
  styles. The chip filters open multi-select dropdowns.
- Tile click → fills the right panel; double-click → opens the asset's Reviews.
- Search debounces 200ms and queries `/assets?q=...`.
- Top-right of the center pane has a "+ New Review" button (primary) that opens
  the New Review modal (see below) with the selected asset pre-filled.

### 4. New Review Modal

**Purpose:** Create a review thread on an asset. Triggered from the Assets page
or directly from an asset card.

**Layout:** Centered modal over `--ah-overlay` scrim. Modal: 480px wide, bg
`--ah-surface`, radius 12px, border `--ah-border`, shadow `--ah-shadow-lg`,
padding 24px. Sections stacked with 16px gap:
- Header: "New Review" 18px / 600 + close icon-button (ghost) right-aligned.
- Asset row: read-only chip showing the selected asset's thumbnail + name + id.
- Title input (single-line, full-width).
- Description textarea (4 rows, full-width, same input chrome, resize
  vertical).
- Reviewer multi-select: chip-style picker, each selected reviewer rendered as
  an accent chip with an `x` button. Below the input, a typeahead suggests
  studio members.
- Priority radio: 5 segmented buttons P1–P5, each a `pill` styled with the
  matching `--ah-pN` background.
- Footer: ghost "Cancel" (left) + primary "Create review" (right). Cancel
  closes the modal; Create posts to `/reviews` and routes to the new review's
  detail page.

## Component specs

### Topbar (`ui_kit/Components.jsx`)

- 56px tall, bg `--ah-surface`, 1px bottom border `--ah-border`, padding-x 16px.
- Left cluster: 24px logo (ArtHound_logo.png) + wordmark "ArtHound" 16px / 600
  + 16px gap + nav links: **Home** / **Assets** / **Reviews** / **Workflows** /
  **Estimates**. Each is a NavLink: `padding: 6px 12px`, radius 6px, font 12px
  / 500, color `--ah-fg-muted`. Hover → bg `--ah-surface-2`, color `--ah-fg`.
  Active → bg `--ah-surface-2`, color `--ah-fg` (no underline).
- Right cluster: search icon button (ghost) + notifications icon button with
  unread dot in `--ah-accent` (4px circle, top-right of icon) + 32px circular
  avatar. Avatar click opens user menu (dropdown card on `--ah-surface-2`,
  radius 8px, shadow-md).

### Buttons

| Variant | Bg | Text | Hover |
|---|---|---|---|
| Primary | `--ah-accent` | `#fff` | `--ah-accent-hover` |
| Secondary | `--ah-surface-2` | `--ah-fg` | `--ah-surface-3` |
| Ghost | transparent | `--ah-fg-muted` | bg `--ah-surface-2`, color `--ah-fg` |
| Danger | `--ah-error` | `#fff` | (darken 8%) |

All: 6px radius, 12px font / 500, padding `6px 12px`, gap `6px` for
inline icons, `transition: background-color 120ms`. Disabled → 50% opacity,
`cursor: not-allowed`. Focus → `--ah-ring-focus`.

### Inputs

bg `--ah-surface-2`, 1px `--ah-border`, radius 8px, padding `8px 12px`,
font 14px, color `--ah-fg`. Placeholder `--ah-fg-disabled`. Focus →
border `--ah-accent`, `box-shadow: var(--ah-ring-focus)`.

### Pills (status & priority)

Pill base: padding `3px 10px`, radius pill, font 12px / 500, inline-flex.
- `pill-success` / `pill-info` / `pill-warning` / `pill-error` use the matching
  status tint as bg and the full saturation color as text.
- Priority pills (P1–P5) use the priority hex as bg with white text.

### Chip

Base: bg `--ah-surface-2`, color `--ah-fg-muted`, padding `2px 8px`, radius
pill, 12px. `chip--accent` variant is transparent with a 1px `--ah-accent`
border and accent-colored text — used for tag chips and selected-filter chips.

### Card

bg `--ah-surface`, 1px `--ah-border`, radius 12px. Interactive variant
(`.card-int`) gets `border-color --ah-border-on-accent` on hover with a 120ms
transition. Padding is contextual (16px for compact panels, 24px for primary
content).

## Interactions & behavior

- **Page transitions:** none — these are router-level swaps with no animation.
- **Modal open:** scrim fades 180ms, modal scales from 96% with 180ms emphasized
  easing.
- **Toasts (sonner):** anchor bottom-right; default style overrides should use
  `--ah-surface-2` bg, `--ah-fg` text, 1px `--ah-border`, radius 8px, shadow-md.
- **Loading rows / cards:** use the `.skeleton` class — `--ah-surface-2`
  background pulsing 0.5↔1 opacity over 1.4s.
- **Empty states:** centered column. Logo at 96px, 30% opacity. Title 16px /
  500 `--ah-fg`. Subtitle 12px `--ah-fg-muted`. Optional primary action button.
- **Keyboard:** all interactive elements receive `--ah-ring-focus` on
  `:focus-visible`. The asset grid supports arrow-key navigation; `Enter`
  selects, `Space` opens detail.

## State management

Existing app already uses React Router + `apiFetch` (a thin wrapper over
`fetch` with auth headers) + sonner. Continue those. The screens here introduce
nothing new — selection state on Assets is local component state; no global
store is required.

## Out of scope for this handoff

- **Reviews list & review detail page** — has been started in the live app
  (`frontend/src/pages/Reviews.jsx`); design has not yet been refreshed.
- **Workflows page** — design unchanged from the existing Workflows.jsx.
- **Estimates page** — design has not yet been started.
- **Vendor app** — separate codebase / surface; not designed yet.
- **Cu-TOOL-u bot panel (NumberBot, LoreBot)** — only the brand mark is
  designed; the conversation surface has not been spec'd.
- **Filter dropdown internals** on the Assets page — visual chip is designed;
  the dropdown body is not.

## Assets — provenance

- `ArtHound_logo.png` / `ArtHound_wordmark.png` — supplied by client; treat as
  authoritative. The PNG in this bundle is the **latest** version — replace any
  older mark in `frontend/public/` with this file.
- `cutoolu_logo.png` / `cutoolu_wordmark.png` — supplied by client; **only**
  used in the Cu-TOOL-u panel. The PNG in this bundle is the **latest**
  version — replace any older mark in `frontend/public/` with this file.
- `favicon.svg` — supplied; saturated violet+cyan gradient. Use only as the
  browser favicon — the saturation is too hot for in-app chrome.
- `icons.svg` — symbol sprite (Bluesky etc.) shipped from the existing repo.
- `hero.png` — marketing splash; not used in app chrome.

## How to view the prototypes

1. Open `ui_kit/index.html` in a browser to see Login → Studio Home → Assets →
   New Review wired together.
2. Open any file in `preview/` directly to inspect a single token group or
   component card.

The prototypes load Inter from Google Fonts, React 18 + Babel from unpkg.
They run with no build step.
