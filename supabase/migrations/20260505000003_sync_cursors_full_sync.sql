-- 20260505000003_sync_cursors_full_sync.sql
-- Adds last_full_sync_at to sync_cursors so the nightly full-reconciliation
-- timestamp is tracked separately from the delta cursor.
-- The nightly loop sets this after every run_sync(full=True) completes.

alter table sync_cursors
  add column if not exists last_full_sync_at timestamptz;
