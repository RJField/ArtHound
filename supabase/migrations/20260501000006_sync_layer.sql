-- 006_sync_layer.sql
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query) after 005_vendor_members.sql
--
-- Adds the full sync infrastructure:
--   replicated_assets        — normalised ArtHound asset data synced from source tools
--   replicated_products      — studio/vendor product list, synced from source
--   replicated_item_types    — studio/vendor item type list, synced from source
--   source_field_mappings    — per-owner mapping of source fields → ArtHound standard slots
--   source_credentials       — interim credential storage (service-role only)
--   sync_cursors             — tracks last-synced position for delta sync
--   sync_log                 — append-only record of every sync run
--   payload_export_records   — tracks where dispatched payloads were exported in vendor tools


-- ── replicated_assets ────────────────────────────────────────────────────────
-- Primary read layer for all ArtHound features. One row per asset per owner.
-- Source tools write here via the sync engine and are not queried directly
-- by feature routes once this layer is active.
--
-- owner_type: 'studio' | 'vendor'
-- owner_id:   references studios(id) or vendors(id) depending on owner_type
-- source_hash: SHA-256 of the source record's field JSON — used for change detection

create table replicated_assets (
  id                      uuid primary key default gen_random_uuid(),
  owner_type              text not null check (owner_type in ('studio', 'vendor')),
  owner_id                uuid not null,
  canonical_asset_id      uuid references canonical_assets(id),

  -- Source provenance
  source_type             text not null default 'airtable'
                            check (source_type in ('airtable', 'jira', 'shotgrid', 'arthound')),
  source_record_id        text not null,
  source_last_modified_at timestamptz,
  source_hash             text,

  -- ArtHound standard slots
  name                    text,
  dev_name                text,
  item_type               text,
  priority                int,
  product                 text,
  project_date            date,
  status                  text,
  asset_number            text,

  -- All source fields that don't map to a standard slot land here
  meta                    jsonb not null default '{}',

  synced_at               timestamptz default now(),
  created_at              timestamptz default now(),

  unique (owner_type, owner_id, source_type, source_record_id)
);

create index on replicated_assets (owner_type, owner_id);
create index on replicated_assets (canonical_asset_id);
create index on replicated_assets (owner_type, owner_id, item_type);
create index on replicated_assets (owner_type, owner_id, priority);
create index on replicated_assets using gin (meta);


-- ── replicated_products ──────────────────────────────────────────────────────

create table replicated_products (
  id               uuid primary key default gen_random_uuid(),
  owner_type       text not null check (owner_type in ('studio', 'vendor')),
  owner_id         uuid not null,
  source_type      text not null default 'airtable',
  source_record_id text not null,
  name             text not null,
  meta             jsonb not null default '{}',
  synced_at        timestamptz default now(),

  unique (owner_type, owner_id, source_type, source_record_id)
);

create index on replicated_products (owner_type, owner_id);


-- ── replicated_item_types ────────────────────────────────────────────────────

create table replicated_item_types (
  id               uuid primary key default gen_random_uuid(),
  owner_type       text not null check (owner_type in ('studio', 'vendor')),
  owner_id         uuid not null,
  source_type      text not null default 'airtable',
  source_record_id text not null,
  name             text not null,
  meta             jsonb not null default '{}',
  synced_at        timestamptz default now(),

  unique (owner_type, owner_id, source_type, source_record_id)
);

create index on replicated_item_types (owner_type, owner_id);


-- ── source_field_mappings ────────────────────────────────────────────────────
-- Stores a studio's or vendor's mapping of source fields → ArtHound standard slots.
-- One row per (owner, source_type).
--
-- mappings JSONB is an array of objects:
--   [{
--     "source_field_id":   "fldXXXXXXXXXXXXXX",   -- native field ID in source system
--     "source_field_name": "Asset Name",            -- human-readable name in source
--     "arthound_slot":     "name"                   -- target standard slot, or null for meta
--   }]
--
-- Any source field with arthound_slot = null (or absent from mappings) flows into
-- replicated_assets.meta automatically — no configuration required for custom fields.

create table source_field_mappings (
  id          uuid primary key default gen_random_uuid(),
  owner_type  text not null check (owner_type in ('studio', 'vendor')),
  owner_id    uuid not null,
  source_type text not null default 'airtable',
  mappings    jsonb not null default '[]',
  updated_at  timestamptz default now(),

  unique (owner_type, owner_id, source_type)
);

create index on source_field_mappings (owner_type, owner_id);


-- ── source_credentials ───────────────────────────────────────────────────────
-- Interim credential storage until studio/vendor profile UI is built.
-- No user-facing RLS policy — service role only. Frontend never reads this table.
--
-- credentials JSONB shape varies by source_type:
--   airtable:  { "api_token": "...", "base_id": "appXXX" }
--   jira:      { "api_token": "...", "base_url": "...", "project_key": "..." }
--   shotgrid:  { "api_key": "...",   "base_url": "...", "script_name": "..." }
--
-- TODO: add pgsodium column-level encryption when compliance requirements solidify.

create table source_credentials (
  id          uuid primary key default gen_random_uuid(),
  owner_type  text not null check (owner_type in ('studio', 'vendor')),
  owner_id    uuid not null,
  source_type text not null default 'airtable',
  credentials jsonb not null default '{}',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),

  unique (owner_type, owner_id, source_type)
);


-- ── sync_cursors ─────────────────────────────────────────────────────────────
-- One row per (owner, source_type). Tracks the timestamp of the last successful
-- full sync — the engine only fetches records modified after this on delta runs.
-- Setting last_synced_at to NULL forces a full re-sync on the next run.

create table sync_cursors (
  owner_type     text not null check (owner_type in ('studio', 'vendor')),
  owner_id       uuid not null,
  source_type    text not null default 'airtable',
  last_synced_at timestamptz,

  primary key (owner_type, owner_id, source_type)
);


-- ── sync_log ─────────────────────────────────────────────────────────────────
-- Append-only. Never update or delete rows.
-- trigger:  'login' | 'manual' | 'webhook' | 'poll'
-- status:   'running' | 'success' | 'error'

create table sync_log (
  id              uuid primary key default gen_random_uuid(),
  owner_type      text not null,
  owner_id        uuid not null,
  source_type     text not null,
  trigger         text not null,
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  records_synced  int,
  status          text not null default 'running',
  error_detail    text
);

create index on sync_log (owner_type, owner_id);
create index on sync_log (started_at desc);


-- ── payload_export_records ───────────────────────────────────────────────────
-- When a vendor exports a dispatched payload into their source tool (or directly
-- into their ArtHound dataset), this records the mapping between the dispatch
-- and the resulting record in the vendor's system.
--
-- "Remain connected": future studio re-dispatches look up this table to update
-- the existing vendor-tool record rather than creating a duplicate.
--
-- vendor_source_type:    'airtable' | 'jira' | 'arthound' | etc.
-- vendor_tool_record_id: native record ID in vendor's source system,
--                        OR replicated_assets.id if vendor uses ArtHound directly.

create table payload_export_records (
  id                    uuid primary key default gen_random_uuid(),
  dispatch_id           uuid not null references payload_dispatches(id),
  vendor_id             uuid not null references vendors(id),
  vendor_source_type    text not null default 'arthound',
  vendor_tool_record_id text not null,
  exported_at           timestamptz default now(),

  unique (dispatch_id, vendor_id)
);

create index on payload_export_records (dispatch_id);
create index on payload_export_records (vendor_id);


-- ── Row Level Security ───────────────────────────────────────────────────────
-- Primary enforcement is at the FastAPI layer (get_current_user resolves
-- studio_id/vendor_id and scopes all queries server-side).
-- RLS is defence-in-depth for any direct Supabase client access.
--
-- Since studio_id/vendor_id are NOT embedded as JWT claims (they're resolved
-- via a DB lookup in lib/auth.py), policies use subqueries against the
-- *_members tables keyed by auth.uid().

alter table replicated_assets     enable row level security;
alter table replicated_products   enable row level security;
alter table replicated_item_types enable row level security;
alter table source_field_mappings enable row level security;
alter table source_credentials    enable row level security;
alter table sync_cursors          enable row level security;
alter table sync_log              enable row level security;
alter table payload_export_records enable row level security;


-- replicated_assets
create policy "ra_studio" on replicated_assets for all using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "ra_vendor" on replicated_assets for all using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);

-- replicated_products
create policy "rp_studio" on replicated_products for all using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "rp_vendor" on replicated_products for all using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);

-- replicated_item_types
create policy "ri_studio" on replicated_item_types for all using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "ri_vendor" on replicated_item_types for all using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);

-- source_field_mappings
create policy "sfm_studio" on source_field_mappings for all using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "sfm_vendor" on source_field_mappings for all using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);

-- source_credentials: no user-facing policy (service role only)
-- RLS is enabled but zero policies means authenticated users cannot read/write.

-- sync_cursors: users can read their own cursor (engine writes via service role)
create policy "sc_studio_read" on sync_cursors for select using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "sc_vendor_read" on sync_cursors for select using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);

-- sync_log: users can read their own log entries
create policy "sl_studio_read" on sync_log for select using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "sl_vendor_read" on sync_log for select using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);

-- payload_export_records: vendors see their own exports
create policy "per_vendor" on payload_export_records for all using (
  vendor_id in (select vendor_id from vendor_members where user_id = auth.uid())
);
