-- Closes the vendor ingest canonical gap:
--   1. payload_export_records gains canonical_asset_id — direct FK to the studio's
--      canonical asset, materialising the link that was previously only derivable
--      via payload_dispatches.asset_id.
--   2. replicated_assets gains origin — distinguishes ingest-seeded vendor rows
--      ('ingest') from rows that arrived via normal sync ('sync'). Critical for
--      explicit-map reconciliation: query WHERE origin='sync' AND canonical_asset_id IS NULL
--      to find genuinely unlinked manual vendor creates, vs origin='ingest' rows
--      where the canonical write failed post-ingest.

-- ── payload_export_records ────────────────────────────────────────────────────

-- Pre-flight: NOT NULL with no default requires the table to be empty.
-- If rows exist they are stale test data or an unexpected state — inspect before proceeding.
do $$
begin
  if exists (select 1 from payload_export_records limit 1) then
    raise exception
      'payload_export_records has existing rows. Inspect and either delete stale rows '
      'or backfill canonical_asset_id (= payload_dispatches.asset_id for each row) '
      'before applying this migration.';
  end if;
end;
$$;

alter table payload_export_records
  add column canonical_asset_id uuid not null references canonical_assets(id);

-- Batch-scoped sync lookup: (vendor_id, source_type, record_id) used by
-- _get_ingest_canonical_map in lib/sync/runner.py
create index on payload_export_records (vendor_id, vendor_source_type, vendor_tool_record_id);
create index on payload_export_records (canonical_asset_id);


-- ── replicated_assets.origin ──────────────────────────────────────────────────

-- Default 'sync' correctly labels all existing rows that arrived via the sync runner.
-- Exception: vendor rows whose source_record_id matches a prior ingest will have been
-- created by sync (after the vendor's tool was synced) but originated from a payload
-- ingest. The backfill below recovers the correct label using
-- payload_field_mappings.ingested_source_record_id, which has been the ground truth
-- for ingest-created records since the ingest route shipped.
alter table replicated_assets
  add column origin text not null default 'sync'
    check (origin in ('sync', 'ingest'));

update replicated_assets ra
set    origin = 'ingest'
from   payload_field_mappings pfm
where  ra.owner_type       = 'vendor'
  and  ra.owner_id         = pfm.recipient_vendor_id
  and  ra.source_record_id = pfm.ingested_source_record_id
  and  pfm.ingested_source_record_id is not null;
