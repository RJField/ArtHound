-- Extends payload_field_mappings with:
--   target_table_id / target_issue_type: where to create the record in the vendor's source
--   ingested_at / ingested_source_record_id / ingested_by_user_id: receipt of a successful ingest
alter table payload_field_mappings
  add column target_table_id            text,
  add column target_issue_type          text,
  add column ingested_at                timestamptz,
  add column ingested_source_record_id  text,
  add column ingested_by_user_id        uuid references auth.users(id);
