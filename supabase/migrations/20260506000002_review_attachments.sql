-- Review-native attachments: files uploaded directly to a review ticket.
-- Stored in Supabase Storage under reviews/{review_id}/{uuid}_{filename}.
-- RLS mirrors the org wall on asset_reviews.

CREATE TABLE review_attachments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       uuid        NOT NULL REFERENCES asset_reviews(id) ON DELETE CASCADE,
  studio_id       uuid        NOT NULL REFERENCES studios(id),
  author_org_type text        NOT NULL CHECK (author_org_type IN ('studio', 'vendor')),
  author_org_id   uuid        NOT NULL,
  filename        text        NOT NULL,
  storage_path    text        NOT NULL,
  content_type    text,
  file_size       bigint,
  uploaded_by     text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX review_attachments_review_id_idx ON review_attachments(review_id);

ALTER TABLE review_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "studio_select" ON review_attachments FOR SELECT
  USING (
    author_org_type = 'studio' AND
    studio_id IN (SELECT studio_id FROM studio_members WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_select" ON review_attachments FOR SELECT
  USING (
    author_org_type = 'vendor' AND
    author_org_id IN (SELECT vendor_id FROM vendor_members WHERE user_id = auth.uid())
  );

CREATE POLICY "studio_insert" ON review_attachments FOR INSERT
  WITH CHECK (
    author_org_type = 'studio' AND
    studio_id IN (SELECT studio_id FROM studio_members WHERE user_id = auth.uid())
  );

CREATE POLICY "vendor_insert" ON review_attachments FOR INSERT
  WITH CHECK (
    author_org_type = 'vendor' AND
    author_org_id IN (SELECT vendor_id FROM vendor_members WHERE user_id = auth.uid())
  );

CREATE POLICY "uploader_delete" ON review_attachments FOR DELETE
  USING (uploaded_by = (auth.jwt() ->> 'email'));
