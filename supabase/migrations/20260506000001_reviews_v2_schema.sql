-- Reviews v2: org wall, title, updated_at, shared_at stub.
-- Drops source_record_id (denormalization of replicated_assets — derive via canonical_asset_id).
-- Adds author_org_type / author_org_id to wall reviews by org.

ALTER TABLE asset_reviews
  ADD COLUMN title          text,
  ADD COLUMN author_org_type text,
  ADD COLUMN author_org_id   uuid,
  ADD COLUMN updated_at      timestamptz DEFAULT now(),
  ADD COLUMN shared_at       timestamptz;

-- Backfill: all existing rows are studio-authored
UPDATE asset_reviews
SET author_org_type = 'studio',
    author_org_id   = studio_id
WHERE author_org_type IS NULL;

ALTER TABLE asset_reviews
  ALTER COLUMN author_org_type SET NOT NULL,
  ALTER COLUMN author_org_id   SET NOT NULL;

ALTER TABLE asset_reviews
  ADD CONSTRAINT asset_reviews_author_org_type_check
    CHECK (author_org_type IN ('studio', 'vendor'));

ALTER TABLE asset_reviews DROP COLUMN IF EXISTS source_record_id;

-- ── RLS replacement ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "studio_members_select" ON asset_reviews;
DROP POLICY IF EXISTS "studio_members_insert" ON asset_reviews;
DROP POLICY IF EXISTS "studio_members_update" ON asset_reviews;
DROP POLICY IF EXISTS "creator_delete"         ON asset_reviews;

-- Studio members see studio-authored reviews in their studio
CREATE POLICY "studio_select" ON asset_reviews FOR SELECT
  USING (
    author_org_type = 'studio' AND
    studio_id IN (SELECT studio_id FROM studio_members WHERE user_id = auth.uid())
  );

-- Vendor members see their own vendor-authored reviews
CREATE POLICY "vendor_select" ON asset_reviews FOR SELECT
  USING (
    author_org_type = 'vendor' AND
    author_org_id IN (SELECT vendor_id FROM vendor_members WHERE user_id = auth.uid())
  );

CREATE POLICY "studio_insert" ON asset_reviews FOR INSERT
  WITH CHECK (
    author_org_type = 'studio' AND
    studio_id IN (SELECT studio_id FROM studio_members WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_insert" ON asset_reviews FOR INSERT
  WITH CHECK (
    author_org_type = 'vendor' AND
    author_org_id IN (SELECT vendor_id FROM vendor_members WHERE user_id = auth.uid())
  );

CREATE POLICY "org_member_update" ON asset_reviews FOR UPDATE
  USING (
    (author_org_type = 'studio' AND studio_id IN (SELECT studio_id FROM studio_members WHERE user_id = auth.uid()))
    OR
    (author_org_type = 'vendor' AND author_org_id IN (SELECT vendor_id FROM vendor_members WHERE user_id = auth.uid()))
  );

CREATE POLICY "creator_delete" ON asset_reviews FOR DELETE
  USING (
    (
      (author_org_type = 'studio' AND studio_id IN (SELECT studio_id FROM studio_members WHERE user_id = auth.uid()))
      OR
      (author_org_type = 'vendor' AND author_org_id IN (SELECT vendor_id FROM vendor_members WHERE user_id = auth.uid()))
    )
    AND created_by_email = (auth.jwt() ->> 'email')
  );
