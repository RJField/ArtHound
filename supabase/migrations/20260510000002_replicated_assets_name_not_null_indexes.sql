-- Enforce NOT NULL on replicated_assets.name and add missing indexes.
--
-- name NOT NULL: an asset without a name is not a valid record. Any existing
-- NULL rows are backfilled from source_record_id so the constraint applies
-- cleanly. The CHECK guards against empty-string writes going forward.
--
-- item_type is intentionally left nullable — it is a mappable slot and some
-- studios do not map it. Enforcing NOT NULL here would break sync for those
-- studios and is better handled at the application layer.
--
-- Indexes: (owner_type, owner_id, name) and (owner_type, owner_id, status)
-- cover sort-and-filter patterns in the asset viewer that currently require
-- full scans at scale.

-- Backfill any existing NULL names before tightening the constraint.
UPDATE replicated_assets
SET name = source_record_id
WHERE name IS NULL;

ALTER TABLE replicated_assets
  ALTER COLUMN name SET NOT NULL,
  ADD CONSTRAINT replicated_assets_name_nonempty CHECK (char_length(name) > 0);

CREATE INDEX IF NOT EXISTS replicated_assets_owner_name_idx
  ON replicated_assets (owner_type, owner_id, name);

CREATE INDEX IF NOT EXISTS replicated_assets_owner_status_idx
  ON replicated_assets (owner_type, owner_id, status);
