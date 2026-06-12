-- Create the private `attachments` storage bucket.
--
-- Used by the copy-on-demand attachment pipeline (lib/attachments.py, sha256/ prefix)
-- and review attachment uploads (routes/reviews.py, reviews/ prefix). All access goes
-- through the app layer with the service role; the bucket is private and has no
-- storage.objects policies by design.
--
-- Historically this bucket was created via the dev dashboard (2026-05-05) and never
-- captured in a migration, so the prod project was cloned without it — every storage
-- upload on prod failed with HTTP 400 "Bucket not found" until it was created manually
-- on 2026-06-12. This migration makes bucket provisioning part of the schema so future
-- environments get it automatically. Idempotent: no-op where the bucket already exists.

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;
