# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Dev Commands

**Backend** (from repo root):
```bash
uvicorn main:app --reload --port 8000
```

**Frontend** (from `frontend/`):
```bash
npm run dev        # Vite dev server on :5173, proxies /api → localhost:8000
npm run build      # Outputs to frontend/dist/ (served by FastAPI in prod)
npm run lint
```

Both servers must run simultaneously in development. The FastAPI app also serves `frontend/dist/` as the SPA in production via a catch-all route.

## Architecture

ArtHound is a **canonical production data layer** for game studios. It replicates source tool data (Airtable, ShotGrid, etc.) into Supabase, then all product features read from Supabase — never from the source tool directly. This is the single most important architectural principle.

```
Source Tool (Airtable)
        │
   lib/sync/runner.py          ← orchestrates full/delta sync
        │
   lib/sync/connectors/        ← source-specific fetch logic
   lib/sync/normalizer.py      ← maps source fields → ArtHound slots
   lib/sync/differ.py          ← change detection via source_hash
   lib/sync/writer.py          ← batch upsert to Supabase
        │
   Supabase (replicated_*)     ← all features read from here
        │
   FastAPI routes/             ← API layer
        │
   React SPA (frontend/)       ← UI
```

Sync is triggered on login (via `AuthContext.jsx`) and by a background polling loop in `main.py`. The webhook handler in `routes/sync.py` will also trigger it. All three paths call the same sync function — keep sync logic trigger-agnostic.

## Backend Conventions

**Auth:** Every protected route uses `get_current_user` from `lib/auth.py` as a FastAPI dependency. It verifies the Supabase JWT (JWKS + HS256 fallback), resolves the user's role (`studio` or `vendor`), and returns membership info with a 60-second cache. Do not re-implement auth logic inline.

**Supabase queries:** Use the helper in `lib/db.py` which builds the PostgREST URL and injects service-role headers. All DB writes use the service role key, not the anon key.

**Airtable calls:** `lib/airtable.py` wraps the Airtable REST API. This is being phased out of most routes — new features should read from Supabase replicated tables, not call Airtable directly. `routes/reconcile-tasks` is a known exception that still uses this pattern and needs migration.

**Credentials:** Source credentials (Airtable PAT, etc.) are encrypted at rest in `source_credentials`. Use `lib/source_creds.py` to retrieve and decrypt them; never query that table directly in route handlers.

**Field mapping:** Source fields are mapped to ArtHound slots via `source_field_mappings` in Supabase. Estimation and task queries must resolve field names through this table — never assume a column name. See `lib/sync/normalizer.py` for how slots are resolved.

## Frontend Conventions

**API calls:** Always use `apiFetch()` from `frontend/src/lib/api.js`. It injects the Supabase JWT and standardizes error handling. Never use raw `fetch` for `/api` routes.

**Auth state:** Supabase session and user profile live in `AuthContext`. App-level UI state (open modals, selected assets, filters) lives in `AppContext`. Hooks in `frontend/src/hooks/` encapsulate all data fetching.

**Props → state sync:** When a component initializes `useState` from props, add a `useEffect` to sync if the prop changes (e.g., `useEffect(() => setState(prop), [prop])`). Components that open from a list and show `history[0]` are the main case.

**Field schema:** When passing field definitions between layers, always include the full type + options object (select choices, `linkedTableId`, formula result type). Do not strip to just the type name — downstream rendering depends on options.

## Database

Migrations live in `supabase/migrations/` and are applied in filename order. All schema changes must go through migration files — never via the Supabase dashboard.

**Key tables:**
- `canonical_assets` — global stable IDs (studio_id + source_record_id)
- `replicated_assets` / `replicated_products` / `replicated_item_types` — synced source data
- `replicated_tasks` — workflow-generated work items (always filter `deleted_at IS NULL` unless querying history)
- `source_field_mappings` — per-studio field → slot mapping
- `source_entity_definitions` — defines the P→A→W hierarchy for each studio (which source table is Products, which is Assets, which is Tasks, and the linking fields between them)
- `asset_reviews` — ArtHound-native reviews (not synced to/from any source tool)
- `source_credentials` — encrypted tokens (service role only)
- `payload_dispatch` — vendor payload tokens

## Multi-tenancy

Studios and vendors are separate roles with separate home pages (`StudioHome.jsx` / `VendorHome.jsx`). Field mappings, source credentials, and sync cursors are all scoped to `studio_id`. The `source_entity_definitions` table defines each studio's P→A→W hierarchy — nothing about the source table structure should be assumed or hardcoded.

## Known Debt

- **task → work rename:** All UI, API, and DB references to "task/tasks" should become "work" (hierarchy is P→A→W). Not yet done — scope is wide.
- **`routes/schedule.py` `reconcile_tasks`:** Still calls Airtable directly via `lib/airtable.py` instead of reading from Supabase. Crashes when `AIRTABLE_BASE_ID` is not set.
- **`maya/arthound_review.py`:** Posts to a defunct `/api/reviews/submit` endpoint. Needs redesign around `canonical_asset_id`.
- **Asset reviews write in `routes/reviews.py`:** Legacy Airtable write path still present; to be removed once Supabase-only path is validated.
