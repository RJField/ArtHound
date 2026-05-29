-- 20260528000003_asset_slots_tier2.sql
--
-- Tier 2 slot demotion: item_type, team, status
-- These are primary segmentation / workflow-context fields. Demoted after Tier 1
-- is verified in production. Forward-looking JSONB indexes added to cover future
-- SQL-level slicing on these dimensions.
--
-- IMPORTANT: The three CREATE INDEX CONCURRENTLY statements CANNOT run inside a
-- transaction block. Run this file in two parts:
--
--   Part A (non-transactional): backfill UPDATE + CONCURRENTLY index builds.
--     Run each CONCURRENTLY statement as a standalone statement, not in a txn.
--     If a build fails mid-way, DROP INDEX <name> before retrying — a failed
--     CONCURRENTLY build leaves an INVALID index that wastes space silently.
--
--   Part B (transactional): column drops — run only after all three indexes
--     report as VALID (check pg_indexes or \d replicated_assets).
--
-- Note on team column: the column exists but was never written by the sync writer
-- (team was added to the schema but omitted from upsert_assets in writer.py).
-- It will be NULL on all rows; the backfill WHERE guard skips it safely.


-- ════════════════════════════════════════════════════════════════════════════════
-- PART A — Backfill + indexes (run outside transaction)
-- ════════════════════════════════════════════════════════════════════════════════

-- ── Batched backfill ──────────────────────────────────────────────────────────
-- PostgreSQL UPDATE does not accept ORDER BY or LIMIT directly.
-- Use a subselect cursor pattern to batch large tables.
--
-- Advance :last_id to the MAX id returned by each batch until 0 rows are affected.
-- Start with: :last_id = '00000000-0000-0000-0000-000000000000'
--
-- id is UUID v4 (gen_random_uuid) — not chronologically monotonic but gives a
-- stable total ordering suitable for cursor paging. Every row is visited exactly once.
--
-- Idempotent: re-running overwrites with the same merged value. A crashed loop is
-- safe to restart from id = '00000000-...' with no special recovery.
--
-- UPDATE replicated_assets
-- SET meta = jsonb_set(
--   coalesce(meta, '{}'::jsonb),
--   '{__slots}',
--   jsonb_build_object('item_type', item_type, 'team', team, 'status', status)
--   || coalesce(meta->'__slots', '{}'::jsonb)
-- )
-- WHERE id IN (
--   SELECT id FROM replicated_assets
--   WHERE (item_type IS NOT NULL OR team IS NOT NULL OR status IS NOT NULL)
--     AND id > :last_id
--   ORDER BY id
--   LIMIT 5000
-- );

-- ── Verify (must return 0 before running Part B) ──────────────────────────────
--
-- SELECT count(*) FROM replicated_assets
--   WHERE item_type IS NOT NULL AND NOT (meta->'__slots' ? 'item_type');
--
-- SELECT count(*) FROM replicated_assets
--   WHERE team IS NOT NULL AND NOT (meta->'__slots' ? 'team');
--
-- SELECT count(*) FROM replicated_assets
--   WHERE status IS NOT NULL AND NOT (meta->'__slots' ? 'status');

-- ── Forward-looking JSONB indexes ────────────────────────────────────────────
-- These serve future SQL-level filtering on these dimensions.
-- Current numbersbot/reviews filtering is Python-side (post-fetch Counter grouping)
-- and does not use these indexes. They are insurance, not a preservation of current
-- query behaviour.
--
-- Run each as a standalone statement outside any transaction:
--
-- CREATE INDEX CONCURRENTLY replicated_assets_slot_item_type_idx
--   ON replicated_assets (owner_type, owner_id, (meta->'__slots'->>'item_type'));
--
-- CREATE INDEX CONCURRENTLY replicated_assets_slot_team_idx
--   ON replicated_assets (owner_type, owner_id, (meta->'__slots'->>'team'));
--
-- CREATE INDEX CONCURRENTLY replicated_assets_slot_status_idx
--   ON replicated_assets (owner_type, owner_id, (meta->'__slots'->>'status'));


-- ════════════════════════════════════════════════════════════════════════════════
-- PART B — Column drops (run as transactional migration after Part A indexes are VALID)
-- ════════════════════════════════════════════════════════════════════════════════

begin;

DROP INDEX IF EXISTS replicated_assets_owner_type_owner_id_item_type_idx;
DROP INDEX IF EXISTS replicated_assets_owner_type_owner_id_team_idx;

ALTER TABLE replicated_assets DROP COLUMN IF EXISTS item_type;
ALTER TABLE replicated_assets DROP COLUMN IF EXISTS team;
ALTER TABLE replicated_assets DROP COLUMN IF EXISTS status;

commit;
