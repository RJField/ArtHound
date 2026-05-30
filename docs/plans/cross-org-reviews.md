# Cross-Org Review System — Design

**Status:** design only, not yet built. Drafted 2026-05-29. Supersedes the narrow
[cross-org review sharing TODO](../../README.md) (studio→vendor `shared_at` stub).

ArtHound reviews graduate from a flat per-org note into the **method and record of sign-off and
delivery** for an asset. A review is ArtHound-native (never synced), always tied to one canonical
asset, and scales across three routines without bloating the cheap one:

1. **Internal** daily craft/team review (single org, never shared).
2. **Cross-org ritual** (e.g. biweekly submissions) over a studio↔vendor link.
3. **Formal delivery** — a cross-org review terminating in the studio **accepting delivery**.

---

## 1. Settled decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Review unit | **Many reviews per asset** — the asset accrues a review *history*; the current sign-off is the latest accepted delivery review. |
| 2 | Cross-org step composition | **Private lanes + shared gates** — internal steps stay invisible; only agreed gate steps cross the wall. |
| 3 | Visibility primitive | **Explicit grants everywhere** — nothing is cross-org by default; every shared item is an auditable grant row. |
| 4 | Security enforcement | **Route resolver + RLS defense-in-depth** — one audited visibility chokepoint (service-role), RLS mirrors the grants. |
| 5 | Step shape | **Linear / staged** — ordered steps, optionally grouped into stages; no DAG, no cycle risk. |
| 6 | Re-delivery | **New linked review** — each (re)submission is a fresh review referencing the prior (revision chain); history immutable. |
| 7 | Acceptance freeze | **Snapshot of review + delivered assets** — freeze review state AND a snapshot of delivered asset data/attachments (payload-dispatch style). |

Secondary calls (proposed, not gold-plated):
- **Grant permission levels** `view` / `comment` / `act` — `act` = may transition a shared step's status.
  This one primitive serves "show feedback" (view), "let them reply" (comment), and "they sign off"
  (act).
- **Status vocabulary is per-org global** (`review_status_def`), referenced by workflow defs — not
  per-workflow status lists.
- **Granting/revoking is privileged** — gated to the owning org's admin/owner tier
  (`studio_members`/`vendor_members` roles).
- **Gate grants are auto-created** from the workflow definition (a step def tagged `shared_gate` grants
  to the partner on instantiation); ad-hoc sharing is a manual grant on one more record.

---

## 2. What exists today (findings)

- `asset_reviews` is flat: one row per `(author_org, canonical_asset)` with `title`, `description`,
  free-text `status`, and an unused `shared_at` stub. Always linked to a canonical asset (invariant
  already holds). Org-walled by `author_org_type`/`author_org_id` in both RLS and `routes/reviews.py`.
  **No cross-org visibility exists yet.**
- `review_attachments` → Supabase Storage, served **inline read-only** (videos/images/PDFs/docs) via a
  streaming endpoint. ✅ reused as-is.
- `studio_vendor_links.review_collaboration_mode ∈ {none, isolated, collaborative}` already exists
  (only `none` live) — the designated home for cross-org review config.
- Reusable patterns: payload **frozen-snapshot + append-only access log** (immutable delivery record);
  `link_cancellation_audit` **dual-party-RLS / no-insert-policy** audit shape; `workflow_steps`
  **status→category** mapping (≈ Jira To-Do/In-Progress/Done).
- PAW anchor: CLAUDE.md lists "a review cycle" as an example of the **Work** tier. This system is the
  ArtHound-native Work-on-an-asset; **sign-off/delivery is its terminal state.**

---

## 3. Entity model

Today's flat `asset_reviews` becomes a **container**; structure beyond "title + one step" is optional
and data-driven, so the internal routine stays cheap.

**Definitions (org-scoped, reusable templates — the modular/prescriptive layer):**
- `review_status_def` — `{owner_org, label, meta_status ∈ open|in_progress|closed, sort, is_terminal,
  color}`. The customizable status vocabulary; labels live in **data, never named columns**.
- `review_workflow_def` — `{owner_org, name, is_default, applies_scope ∈ internal|cross_org}`. We seed
  a prescriptive baseline (a default "Delivery Review"); fully editable per org.
- `review_step_def` — `{workflow_def_id, name, sort, stage, actor ∈ owner|partner, is_shared_gate,
  default_status_def_id}`.

**Instances:**
- `review` (repurpose `asset_reviews`) — `{canonical_asset_id, owner_org, scope ∈ internal|cross_org,
  link_id?, workflow_def_id?, current_meta_status (denormalized), revision_of (self FK), accepted_at,
  accepted_by, frozen_snapshot jsonb, created_by, timestamps}`. Frozen on acceptance.
- `review_step` — `{review_id, step_def_id?, owner_org, name, current_status_def_id, assignee_user_id,
  sort, stage, timestamps}`. Studio and vendor steps coexist; a step's visibility is grant-driven.
- `review_comment` — `{review_id, step_id?, author_org, author_user_id, body, created_at, edited_at}`.
  Default-private to author org; visibility via grants.
- `review_attachment` (exists) — add nullable `step_id`; keep inline read-only serving.

**Cross-cutting:**
- `review_grant` — `{subject_type ∈ review|step|comment|attachment, subject_id, grantee_kind ∈
  org|user, grantee_org_type?, grantee_org_id?, grantee_user_id?, permission ∈ view|comment|act,
  link_id, granted_by, granted_at, revoked_at}`. **Per-record, non-inherited.** No grant = private
  lane; a grant = shared gate.
- `review_event` — append-only audit log: `{review_id, subject_type, subject_id, event_type, actor_user_id,
  actor_org, detail jsonb, created_at}`. Covers created / status-changed / shared / unshared /
  comment-added / accepted / revision-created. **Dual-party RLS select, no INSERT policy**
  (service-role `_log()` only). This is the auditable history — *including every sharing change*.

---

## 4. Visibility & security (the #1 risk)

**Default-private.** A record is visible to a user in org `O` iff **(a)** the record's owner org is `O`,
or **(b)** an active grant (`revoked_at IS NULL`) on that exact record has a grantee matching `O` or
the user. Grants do **not** inherit: granting a review exposes the review row and lets the partner *see
that shared steps exist*, but each shared step/comment needs its own grant. This is what makes "private
lanes + shared gates" hold under "grants everywhere."

**Enforcement = one route-layer chokepoint.** Like payload/estimate-share, the routes use the
service-role client (RLS bypassed at runtime), so a single audited resolver is the enforced boundary:

- `resolve_visible_review(review_id, user) -> {review, steps, comments, attachments, my_permissions}`
  loads the subtree + all its grants in one pass and filters in-process. Every read path goes through
  it. A cross-tenant request (partner with no grant) returns 404/empty **at the route**.
- Write actions check the grant's `permission`: transitioning a shared step requires an `act` grant;
  commenting requires `comment`; everything else is owner-org only.

**RLS = defense-in-depth**, modelling the same grants (own-org via membership OR a grant subquery), so a
future user-JWT path can't leak. It does not change runtime behaviour.

**Acceptance is ACID-critical** — a Postgres RPC in one transaction: validate required shared gates are
closed → assemble `frozen_snapshot` (review state + delivered asset data + attachment refs) →
set `accepted_at/by`, `current_meta_status` → write `review_event 'accepted'`. Attachment snapshots
reference the existing content-addressed `sha256` blobs (no recopy).

---

## 5. How the three routines fall out

1. **Internal daily review** — `scope=internal`, a lightweight workflow (or a single ad-hoc step), zero
   grants. Never visible to any partner. Cheapest path; no grant/resolver overhead beyond own-org.
2. **Cross-org ritual** — `scope=cross_org` on a `link_id`. The vendor submits; shared-gate steps are
   auto-granted to the studio; ad-hoc extra sharing is a manual grant. Cadence ("biweekly") is just how
   often reviews are created — no schedule primitive needed in v1.
3. **Formal delivery** — a cross-org review whose `workflow_def` ends in a studio `actor=partner`,
   `is_terminal` **"Accept delivery"** step. The studio's `act` transition runs the acceptance RPC,
   freezes the snapshot, and writes the immutable delivery record. A rejection or later revision spawns
   a **new review** with `revision_of` set; the prior stays frozen.

The handshake link names the **sanctioned formal sequence** (which `workflow_def` is the agreed
cross-org protocol) — repurposing/extending `review_collaboration_mode`. Ad-hoc cross-org reviews
(routine 2) don't require the link protocol.

---

## 6. Phasing (each independently shippable)

| Phase | Scope | Delivers |
|---|---|---|
| **0 — Structured reviews (internal)** | `review` container + `review_step` + `review_status_def` + `review_workflow_def`/`review_step_def`; migrate flat `asset_reviews`; reuse attachments | Routine 1: internal multi-step reviews with custom status→meta-status. No cross-org. |
| **1 — Grants + audit** | `review_grant` + `review_event` + the visibility resolver + RLS depth; per-record sharing (view/comment) | Routine 2 (ad-hoc): share a review/step/comment to a partner, fully audited. |
| **2 — Sanctioned protocol** | workflow-def `shared_gate` auto-grant, `act` permission, link-level sanctioned sequence | Routine 2 (structured): agreed cross-org review sequence with partner-actionable gates. |
| **3 — Formal delivery** | acceptance RPC + snapshot freeze + `revision_of` chain | Routine 3: studio accepts delivery; immutable record; revisions as new reviews. |

Phase 0 carries the **migration risk** (repurposing `asset_reviews`): existing flat rows backfill as
single-step internal reviews (`title` kept; `description` → review summary or first comment; free-text
`status` → a seeded status def). The current flat API is versioned/shimmed during transition.

---

## 7. Open risks & deferred

- **Cross-org leak via a resolver bug** — the dominant risk. Mitigation: single chokepoint, exhaustive
  tenancy tests (partner-without-grant returns empty), RLS mirroring the grants.
- **Grant query cost** — index `review_grant` on `(subject_type, subject_id)` and on grantee; resolve a
  whole subtree's grants in one query.
- **Frozen-snapshot size** — reference `sha256` attachment blobs, never recopy.
- **`act` over-reach** — a partner with `act` may transition *only* the specifically granted step.
- **Many-per-asset UX** — needs an asset "review history" surface (revision chains, latest accepted).
- **Deferred:** stakeholder notifications (hook into the [notification system](../../README.md) TODO,
  don't hardcode); **studio↔studio** ("cross studio org") reviews — the grant model is org-typed so it
  generalizes, but the handshake is studio↔vendor only today; real-time collaboration; shared template
  library across orgs.

---

## 8. ArtHound-principle check

- **Security/integrity first** — default-private, single audited chokepoint, RLS depth, ACID acceptance.
- **Everything links to its canonical asset** — `review.canonical_asset_id` stays NOT NULL.
- **Named fields = universal truths only** — statuses, step names, workflows are data-driven defs.
- **No cross-org flow without explicit authorization** — grants are the authorization, and every grant
  is an event.
- **Prescriptive baseline, modular where it counts** — seeded default workflow/statuses; per-org
  customization; stakeholder management deferred to the notification layer.
