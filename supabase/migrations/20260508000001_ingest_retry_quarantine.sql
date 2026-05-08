-- Ingest retry / quarantine
--
-- 1. payload_field_mappings.failed_at + failure_reason
--    Tracks dispatches where the external record was created but the canonical
--    link write exhausted all retries. Vendor-facing: failed_at IS NOT NULL means
--    retryable via POST /api/payload/{id}/retry-canonical.
--    ingested_at remains NULL until both the external write AND canonical link succeed.
--
-- 2. failed_ingests table
--    Operator-facing quarantine. Written alongside failed_at on payload_field_mappings.
--    Per-write granularity (export_ok / replicated_ok) so manual remediation targets
--    exactly the table(s) that failed. Background job or operator can re-run
--    _write_canonical_link using the stored source_record_id without touching the
--    external tool again.

alter table payload_field_mappings
  add column failed_at      timestamptz,
  add column failure_reason text;

create table failed_ingests (
  id                 uuid        primary key default gen_random_uuid(),
  dispatch_id        uuid        not null references payload_dispatches(id),
  vendor_id          uuid        not null,
  source_type        text        not null,
  source_record_id   text        not null,
  canonical_asset_id uuid        not null references canonical_assets(id),
  export_ok          boolean     not null default false,
  replicated_ok      boolean     not null default false,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,
  constraint failed_ingests_dispatch_uniq unique (dispatch_id)
);

-- Operator query: all unresolved orphans
create index on failed_ingests (resolved_at) where resolved_at is null;
-- Vendor retry lookup
create index on failed_ingests (dispatch_id, vendor_id);

-- RLS: block direct PostgREST access; all reads/writes go via service role in route handlers
alter table failed_ingests enable row level security;
