-- 20260503000001_replicated_tasks.sql
-- Run after 20260502000001_asset_reviews.sql
--
-- Adds replicated_tasks: source task records synced from the studio's source tool.
-- Tasks are the child layer of the P→A→T hierarchy (Product → Asset → Task).
-- Each task links back to a parent asset via source_asset_record_id (raw source ID)
-- and canonical_asset_id (resolved ArtHound canonical UUID).
--
-- Slots kept minimal (name, status, estimate). All other source fields land in meta.
-- Proper task field mapping UI (analogous to asset field mappings) is a future addition.

create table replicated_tasks (
  id                      uuid primary key default gen_random_uuid(),
  owner_type              text not null check (owner_type in ('studio', 'vendor')),
  owner_id                uuid not null,
  source_type             text not null default 'airtable'
                            check (source_type in ('airtable', 'jira', 'shotgrid', 'arthound')),
  source_record_id        text not null,
  source_last_modified_at timestamptz,
  source_hash             text,

  -- Parent asset link
  source_asset_record_id  text,
  canonical_asset_id      uuid references canonical_assets(id),

  -- Task slots
  name                    text,
  status                  text,
  estimate                numeric,

  -- All remaining source fields
  meta                    jsonb not null default '{}',

  synced_at               timestamptz default now(),
  created_at              timestamptz default now(),

  unique (owner_type, owner_id, source_type, source_record_id)
);

create index on replicated_tasks (owner_type, owner_id);
create index on replicated_tasks (canonical_asset_id);
create index on replicated_tasks (owner_type, owner_id, source_asset_record_id);


-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table replicated_tasks enable row level security;

create policy "rt_studio" on replicated_tasks for all using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "rt_vendor" on replicated_tasks for all using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);
