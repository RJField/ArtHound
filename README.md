# ArtHound

ArtHound is a canonical production data layer for game studios. It replicates source tool data (Airtable, Jira, and future connectors) into a central Supabase database, then all product features — estimation, scheduling, vendor dispatch, reviews — read from that database rather than from the source tools directly. Studios connect their existing pipelines; ArtHound becomes the stable cross-tool identity and coordination layer sitting on top.

The core conceptual model is **PAW — Product, Asset, Work**. Every piece of data belongs to one of these three tiers, and every record in the system links back to a canonical asset that acts as the stable thread connecting internal production data, vendor deliveries, reviews, and generated work into a single coherent record.

---

## Architecture Overview

```
Source Tool (Airtable / Jira / …)
        │
   Sync Layer (lib/sync/)        ← replicates on login, webhook, and polling
        │
   Supabase (replicated_*)       ← all features read from here
        │
   FastAPI (routes/)             ← API layer
        │
   React SPA (frontend/)         ← UI
```

Studios onboard by connecting their source tool through an init wizard, defining their P→A→W hierarchy, and mapping source fields to ArtHound's schema. Once that first sync runs, all product features are available without touching the source tool again.

---

## Documentation

### [Sync Layer](docs/sync.md)

The sync layer is the most important architectural component. It runs continuously — triggered on login, by a polling loop, and by source tool webhooks — and keeps the Supabase `replicated_*` tables current. A sync run proceeds through six phases: init (load credentials and mappings), fetch (pull raw records from the source tool), normalize (map source fields to ArtHound slots), diff (detect changes by source hash), write (batch upsert to Supabase), and cleanup (delete orphaned records). Two connectors are currently implemented — Airtable and Jira Cloud/Data Center — against a shared `BaseConnector` interface. Delta syncs use per-owner cursors so only changed records are written on subsequent runs.

### [Studio Onboarding](docs/onboarding.md)

A gated five-step wizard that connects a studio's source tool and runs the first full sync. Steps in order: validate and encrypt source credentials, fetch and cache the full source schema, define the P→A→W hierarchy (which source tables are Products, Assets, and Work, and how they link), map source fields to ArtHound slots and classify them by display tier, then start the background init job. Each step gates the next. A polling endpoint reports job progress so the UI can show live status.

### [Asset Viewer](docs/asset-viewer.md)

The central UI surface. A three-panel layout — filterable asset list on the left, tabbed detail panel on the right. Tabs: Details (slot fields + meta fields grouped by display tier, with a "Show more" collapse for secondary-tier fields), Work (source work vs ArtHound-generated work, with a Gantt timeline view), Reviews, Attachments, and Bugs. Column visibility in the list panel is persisted in localStorage. Field display tier (primary / secondary / hidden) is configured per studio in the field mapping UI and drives both the list columns and the detail panel. Schema drift — changes to the source tool's field schema — surfaces as a banner and badge prompting the studio to review their mappings.

### [Estimation Engine](docs/estimation.md)

Studios define a library of **workflow steps** (production tasks with optional craft labels and dependency edges), then choose **variable fields** from their source schema (e.g., "Asset Type", "Complexity"). The system enumerates all unique combinations of those field values across synced assets and builds an estimate matrix: one cell per (workflow step × variable combination), each holding a day count. Studios fill in the matrix via an inline spreadsheet UI. When the scheduler generates work for an asset, it resolves the asset's variable values against this matrix to produce step-level estimates.

### [Schedule and Generated Work](docs/schedule.md)

The scheduler generates work snapshots from the estimate matrix and writes them back to the studio's source tool (creating Jira issues or Airtable records with link-back fields). **Source work** (`replicated_work`) is what the source tool already contains; **generated work** (`generated_work`) is what ArtHound proposes. Generated work is soft-deleted rather than hard-deleted so historical snapshots are available for variance analysis. A reconcile endpoint soft-deletes generated work rows whose source records have since been removed.

### [NumberBot](docs/numberbot.md)

An in-app AI assistant powered by Claude Haiku. Before each turn it fetches live context — asset inventory, field mappings, source work, generated work, and reviews — builds an ASCII summary, and passes it to the model with prompt caching enabled. Scope is strictly limited to production data questions: the assistant refuses general knowledge, business advice, and anything not grounded in the fetched context. Works for both studio and vendor sessions; vendor context is scoped to dispatched assets only.

### [Studio↔Vendor Handshake](docs/handshake.md)

The prerequisite gate for payload dispatch. Studios send invites to vendors by searching their unique handle; vendors preview the studio's payload templates and accept, triggering the creation of an active link and an optional field mapping setup step. Either party can cancel a link, which immediately revokes all outstanding (non-ingested) dispatches and writes a full audit trail. The `review_collaboration_mode` set at invite time (`none` / `isolated` / `collaborative`) controls review visibility between orgs; currently only `none` is live.

### [Asset Payload Dispatch](docs/payload.md)

Studios dispatch frozen snapshots of asset data to connected vendors. Each dispatch is immutable after creation — changes to the studio's source data do not affect what the vendor sees. Vendors map payload fields to their own source tool schema and ingest, creating a real Jira issue or Airtable record in their own tool. ArtHound writes a canonical link (`payload_export_records`) back to the studio's asset on successful ingest, making the vendor's record permanently traceable. Dispatches can be revoked by the studio at any time; an expiry window is set at dispatch time. An append-only audit log tracks every access event for both parties.

### [Attachment Architecture](docs/attachments.md)

Attachments from source tools (images, video, PDFs, documents) are surfaced inline in the UI via a content-addressed storage layer in Supabase Storage. Two copy triggers: **copy-on-dispatch** (attachments are downloaded and stored when a studio dispatches an asset to a vendor, freezing the snapshot) and **copy-on-first-view** (studio attachments are copied on the first time a user opens them in the Asset Viewer). Every blob is stored at `attachments/sha256/{hex_hash}`, making deduplication free and paths collision-safe. A background drain loop processes the copy job queue every 30 seconds; a nightly purge removes orphaned blobs. Browser media components (`<img>`, `<video>`, pdf.js) receive blob URLs created from authenticated proxy responses, since browsers cannot send JWT headers in media element requests.

### [Asset Reviews](docs/reviews.md)

ArtHound-native structured feedback records attached to canonical assets. Not synced to or from any source tool — they exist only in ArtHound's database. Both studios and vendors can create reviews on assets they have access to (studios on their own assets; vendors on dispatched assets). Reviews support file attachments stored in Supabase Storage, independent of the source-tool attachment pipeline. The `review_collaboration_mode` on the studio↔vendor link is intended to control cross-org review visibility; that feature is not yet implemented.

### [Member Management and Org Hub](docs/members.md)

Studios and vendors are multi-user organisations with three membership tiers: `owner`, `admin`, and `user`. New members join via an 8-character invite code; they land in a pending state until an org admin approves their join request. The org hub shows the full member list with inline role management, the current invite code (with regeneration), and pending join requests. Ownership transfer is atomic via a Postgres RPC — there is always exactly one owner. A 15-second membership cache means role changes propagate within 15 seconds.

### [Scenario Planner](docs/scenario.md)

Studios model hypothetical production schedules — "when can we ship?" or "what can we complete by date X?" — without touching their source tool. A Claude Haiku scoping conversation gathers planning parameters (release cadence, asset counts by classification, optional per-craft concurrency caps), then a generation engine writes an ephemeral product/asset/work plan to session-scoped tables. Two engines are available: a deterministic rule-based engine (no AI, fully reproducible, grounded entirely in the studio's estimate matrix and workflow graph) and a Claude Sonnet multi-pass engine. Both support `earliest_ship` (schedule forward, derive completion date) and `target_date` (schedule backward, flag infeasibility) modes. The rule-based engine uses a DAG-aware, asset-at-a-time scheduler with dependency-respecting date placement, a two-pass capped scheduler (forward cap-push + backward pullback for uncapped steps), and a cadence scheduling path that derives sprint release dates from actual asset completions. Post-generation, Haiku answers questions about the plan in a discussion chat. Export to CSV and Write to Source are deferred.

### [LoreBot](docs/lorebot.md)

A proof-of-concept document-reading assistant. Given a canonical asset (studio) or a dispatch (vendor), LoreBot reads the attached files from Supabase Storage — PDFs, text, images — and answers questions about their content using Claude Haiku with vision. PDFs are extracted via `pypdf`; up to four images are passed as base64 vision blocks. Attachments must be copied to Storage before chat begins; a replication endpoint triggers the copy synchronously. Prompt caching is applied to the attachment context. Explicitly marked PoC — not for use with confidential data.

### [Synthetic Data Generator](docs/synthetic.md)

An admin-only tool for populating an Airtable base with realistic-looking test data. Studios save a "target" (an Airtable base with a P→A→W table mapping and encrypted PAT), then generate Products, Assets, and Work records in configurable counts with optional link fields and extra randomly-populated fields. Records are written in batches of 10 with rate-limit handling. Used to build test environments without real production data.

### [Platform Admin](docs/admin.md)

System-wide controls for ArtHound operators. Access is restricted to email addresses in the `PLATFORM_ADMIN_EMAILS` environment variable. Currently controls the registration gate: `registration_invite_required` (boolean) and `registration_invite_code` (the platform-wide code new users must enter). A simple admin panel UI at `/admin` exposes these settings.

---

## Dev Setup

**Backend** (from repo root):
```bash
uvicorn main:app --reload --port 8000
```

**Frontend** (from `frontend/`):
```bash
npm run dev        # Vite dev server on :5173, proxies /api → localhost:8000
npm run build      # Outputs to frontend/dist/ (served by FastAPI in prod)
```

Both servers must run simultaneously in development.

## Database

Migrations live in `supabase/migrations/` and are applied in filename order via `supabase db push`. Never apply schema changes through the Supabase dashboard.
