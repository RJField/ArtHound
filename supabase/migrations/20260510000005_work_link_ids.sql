-- Add dedicated work_link_ids column to replicated_assets.
--
-- Delta sync with parent_holds_link direction previously fetched all
-- replicated_assets rows including full meta JSONB to read one field value
-- (the linked work record IDs on each asset). This column stores those IDs
-- directly so the supplement query selects text[] instead of full JSONB payloads.
--
-- Forces a full resync for all owners so the column is populated before
-- any delta sync relies on it.

ALTER TABLE replicated_assets
    ADD COLUMN IF NOT EXISTS work_link_ids text[] DEFAULT NULL;

UPDATE sync_cursors SET force_full_resync = TRUE;
