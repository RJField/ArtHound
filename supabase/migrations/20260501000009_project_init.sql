-- 009_project_init.sql
-- Run in Supabase SQL Editor after 008_generated_tasks_soft_delete.sql
--
-- Adds project initialisation / reset infrastructure:
--   init_jobs            — persistent job tracking for init and reset runs
--   source_schema_cache  — caches discovered source fields for the mapping UI
--   studios.initialized_at — gates downstream features until first sync completes
--
-- Credential encryption is handled at the application layer (lib/crypto.py).
-- Set CREDENTIALS_ENCRYPTION_KEY in .env to enable; existing plaintext rows are
-- read transparently and re-encrypted on next write.


-- ── init_jobs ─────────────────────────────────────────────────────────────────
-- One row per init or reset run. Written by lib/sync/init_runner.py.
-- status:  'pending' → 'running' → 'completed' | 'error'
-- phase:   'sync' | 'done'
-- is_reset: true if this is a re-initialisation (data was wiped first)

create table init_jobs (
  id               uuid    primary key default gen_random_uuid(),
  owner_type       text    not null check (owner_type in ('studio', 'vendor')),
  owner_id         uuid    not null,
  source_type      text    not null default 'airtable',
  status           text    not null default 'pending'
                             check (status in ('pending', 'running', 'completed', 'error')),
  phase            text,
  progress_current int     not null default 0,
  progress_total   int,
  error_log        jsonb   not null default '[]',
  is_reset         boolean not null default false,
  created_at       timestamptz default now(),
  started_at       timestamptz,
  completed_at     timestamptz
);

create index on init_jobs (owner_type, owner_id);
create index on init_jobs (status);
create index on init_jobs (created_at desc);


-- ── source_schema_cache ───────────────────────────────────────────────────────
-- One row per (owner, source_type). Populated by POST /api/init/discover.
-- Invalidated on credential change. Fields shape:
--   [{"id": "fldXXX", "name": "Asset Name", "type": "singleLineText", "category": "text"}]

create table source_schema_cache (
  owner_type    text not null check (owner_type in ('studio', 'vendor')),
  owner_id      uuid not null,
  source_type   text not null default 'airtable',
  fields        jsonb not null default '[]',
  discovered_at timestamptz default now(),

  primary key (owner_type, owner_id, source_type)
);


-- ── studios.initialized_at ────────────────────────────────────────────────────
-- Set by init_runner on completion. NULL means the studio has never completed
-- an initial sync and should be directed to the init wizard.

alter table studios add column if not exists initialized_at timestamptz;


-- ── Row Level Security ────────────────────────────────────────────────────────

alter table init_jobs           enable row level security;
alter table source_schema_cache enable row level security;

-- init_jobs: users can read (not write) their own jobs; engine writes via service role
create policy "ij_studio_read" on init_jobs for select using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "ij_vendor_read" on init_jobs for select using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);

-- source_schema_cache: users can read their own cached schema
create policy "ssc_studio" on source_schema_cache for select using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "ssc_vendor" on source_schema_cache for select using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);
