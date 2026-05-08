-- ArtHound-native review tickets, scoped to a studio.
-- Reviews are standalone intelligence layer records — they reference a
-- canonical asset (and optionally a source tool record) but do not
-- participate in the sync layer and are never written back to Airtable.

CREATE TABLE asset_reviews (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id          uuid        NOT NULL REFERENCES studios(id)          ON DELETE CASCADE,
  canonical_asset_id uuid        NOT NULL REFERENCES canonical_assets(id) ON DELETE CASCADE,
  source_record_id   text,                   -- source tool record ID (e.g. Airtable record ID)
  description        text,
  status             text,                   -- free text for now; null = no status set
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_email   text        NOT NULL
);

CREATE INDEX asset_reviews_studio_id_idx          ON asset_reviews(studio_id);
CREATE INDEX asset_reviews_canonical_asset_id_idx ON asset_reviews(canonical_asset_id);
CREATE INDEX asset_reviews_created_at_idx         ON asset_reviews(created_at DESC);

ALTER TABLE asset_reviews ENABLE ROW LEVEL SECURITY;

-- Studio members may read reviews for their own studio
CREATE POLICY "studio_members_select"
  ON asset_reviews FOR SELECT
  USING (
    studio_id IN (
      SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
    )
  );

-- Studio members may create reviews for their own studio
CREATE POLICY "studio_members_insert"
  ON asset_reviews FOR INSERT
  WITH CHECK (
    studio_id IN (
      SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
    )
  );

-- Any studio member may update reviews (e.g. change status)
CREATE POLICY "studio_members_update"
  ON asset_reviews FOR UPDATE
  USING (
    studio_id IN (
      SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
    )
  );

-- Only the creator may delete their own review
CREATE POLICY "creator_delete"
  ON asset_reviews FOR DELETE
  USING (
    studio_id IN (
      SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
    )
    AND created_by_email = (auth.jwt() ->> 'email')
  );
