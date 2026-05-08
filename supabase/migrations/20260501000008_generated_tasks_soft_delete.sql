-- 008_generated_tasks_soft_delete.sql
-- Run after 007_generated_tasks.sql
--
-- Adds soft-delete to generated_tasks. Deleted tasks are hidden from the
-- active ArtHound work view but preserved as historical records for bot
-- context and audit. Hard deletes are never used on this table.
--
-- deleted_at: null = active, non-null = deleted (timestamp of deletion detection)

alter table generated_tasks add column deleted_at timestamptz;

-- Partial index for the common active-task query path
create index on generated_tasks (studio_id, canonical_asset_id) where deleted_at is null;
