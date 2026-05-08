-- 20260509000004_p3_indexes.sql
-- P3 index additions: replicated_work + payload_dispatches hot paths.

-- replicated_work: composite covering the canonical_asset_id lookup in list_work.
-- All callers filter (owner_type, owner_id, canonical_asset_id) together; the
-- existing single-column canonical_asset_id index forces a post-filter on owner scope.
create index if not exists replicated_work_owner_canonical_idx
  on replicated_work (owner_type, owner_id, canonical_asset_id);

-- payload_dispatches: outbox sorts by created_at DESC after filtering on sender;
-- compound index eliminates the sort step.
create index if not exists payload_dispatches_outbox_idx
  on payload_dispatches (sender_studio_id, created_at desc);

-- payload_dispatches: vendor inbox only cares about non-revoked, non-expired rows.
-- Partial index prunes revoked dispatches from the scan entirely.
-- Effective only when the query pushes revoked_at/expires_at filters to SQL
-- (done in routes/payload.py get_vendor_inbox as of this migration).
create index if not exists payload_dispatches_inbox_idx
  on payload_dispatches (recipient_vendor_id, expires_at)
  where revoked_at is null;
