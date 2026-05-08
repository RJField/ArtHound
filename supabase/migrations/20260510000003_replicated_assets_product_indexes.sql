-- Index the two product filter columns used in GET /api/assets?productId=...
-- Without these, PostgREST falls back to a full table scan for every asset list request.
CREATE INDEX IF NOT EXISTS replicated_assets_owner_product_src_idx
  ON replicated_assets (owner_type, owner_id, product_source_record_id);

CREATE INDEX IF NOT EXISTS replicated_assets_owner_product_idx
  ON replicated_assets (owner_type, owner_id, product);
