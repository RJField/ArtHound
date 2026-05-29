-- 20260528000002_asset_slots_tier1.sql
--
-- Tier 1 slot demotion: dev_name, priority
-- These are pure display/passthrough fields with no analytical group-by use.
--
-- Strategy: expand/contract.
--   1. Backfill meta["__slots"] from the existing columns.
--      Merge order: {col_data} || {existing __slots} so any value already written
--      by a live sync (Phase A normalizer) wins over the stale column value.
--   2. Verify per-key that every non-null column row has the key in __slots.
--   3. Drop the columns and the priority compound index.
--
-- Column fallbacks in _build_asset_response() are removed in Phase E (separate deploy)
-- after production verification that __slots is fully populated.

begin;

-- ── Backfill __slots from columns ────────────────────────────────────────────
-- Idempotent: re-running overwrites with the same merged value.
-- __slots on the right side of || wins on key conflict — live-synced values
-- from the Phase A normalizer are preserved over stale column values.

UPDATE replicated_assets
SET meta = jsonb_set(
  coalesce(meta, '{}'::jsonb),
  '{__slots}',
  jsonb_build_object('dev_name', dev_name, 'priority', priority)
  || coalesce(meta->'__slots', '{}'::jsonb)
)
WHERE dev_name IS NOT NULL OR priority IS NOT NULL;


-- ── Verify (must return 0 rows before proceeding) ─────────────────────────────
-- Run these as standalone queries after the UPDATE and confirm 0 before continuing.
--
-- SELECT count(*) FROM replicated_assets
--   WHERE dev_name IS NOT NULL AND NOT (meta->'__slots' ? 'dev_name');
--
-- SELECT count(*) FROM replicated_assets
--   WHERE priority IS NOT NULL AND NOT (meta->'__slots' ? 'priority');


-- ── Drop index and columns ────────────────────────────────────────────────────

DROP INDEX IF EXISTS replicated_assets_owner_type_owner_id_priority_idx;

ALTER TABLE replicated_assets DROP COLUMN IF EXISTS dev_name;
ALTER TABLE replicated_assets DROP COLUMN IF EXISTS priority;

commit;
