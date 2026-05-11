-- Drop the GIN index on replicated_assets.meta.
--
-- This index was created speculatively in the original sync_layer migration.
-- All meta filtering in ArtHound is done in Python after fetching rows via
-- PostgREST — no query ever filters meta->>'key' at the SQL layer, so the
-- index has idx_scan = 0 and only adds write overhead on every sync upsert.

DROP INDEX IF EXISTS replicated_assets_meta_idx;
