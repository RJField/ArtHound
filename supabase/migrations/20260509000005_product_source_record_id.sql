-- 20260509000005_product_source_record_id.sql
--
-- Splits the hybrid replicated_assets.product column into two clean columns:
--   product                  — display name only (human-readable)
--   product_source_record_id — source tool record ID only (stable FK target)
--
-- Previously the normalizer wrote `display_name or source_id` into product,
-- forcing a two-predicate OR filter on every product-scoped asset query and
-- making a targeted index impossible.
--
-- After this migration + normalizer change:
--   - product always holds the display name (or NULL if no name was resolved)
--   - product_source_record_id always holds the source record ID when available
--   - asset list queries filter on product_source_record_id=eq.{id} (indexed)
--   - select-based products (no source ID) continue to filter on product=eq.{name}

ALTER TABLE replicated_assets ADD COLUMN IF NOT EXISTS product_source_record_id text;

-- Index for the new column — covers the hot path in GET /api/assets?productId=...
CREATE INDEX IF NOT EXISTS replicated_assets_product_src_idx
  ON replicated_assets (owner_type, owner_id, product_source_record_id);

-- Backfill case 1: product holds a source_record_id (e.g. recXXX or a Jira key).
-- Move it to product_source_record_id and replace product with the display name.
UPDATE replicated_assets ra
SET product_source_record_id = ra.product,
    product                  = rp.name
FROM replicated_products rp
WHERE ra.owner_id  = rp.owner_id
  AND ra.owner_type = rp.owner_type
  AND ra.product   = rp.source_record_id
  AND ra.product_source_record_id IS NULL;

-- Backfill case 2: product already holds the display name.
-- Just populate product_source_record_id from the matching product row.
UPDATE replicated_assets ra
SET product_source_record_id = rp.source_record_id
FROM replicated_products rp
WHERE ra.owner_id  = rp.owner_id
  AND ra.owner_type = rp.owner_type
  AND ra.product   = rp.name
  AND ra.product_source_record_id IS NULL;
