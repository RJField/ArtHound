-- 20260503000002_task_field_mappings.sql
-- Adds per-studio task field column mappings to source_entity_definitions.
--
-- Explicit columns for the five core task fields (only populated for entity_type = 'task' rows).
-- Each field is stored as an (id, name) pair so the API can use either the Airtable field ID
-- (for fetching) or the human-readable name (for Airtable formula filters).
--
-- field_mappings JSONB is a flexible bucket for any additional studio-defined task fields
-- (assignee, department, cap type, etc.) that don't warrant explicit columns yet.

alter table source_entity_definitions
  add column task_name_field_id         text,
  add column task_name_field_name       text,
  add column task_status_field_id       text,
  add column task_status_field_name     text,
  add column task_start_date_field_id   text,
  add column task_start_date_field_name text,
  add column task_end_date_field_id     text,
  add column task_end_date_field_name   text,
  add column task_estimate_field_id     text,
  add column task_estimate_field_name   text,
  add column field_mappings             jsonb not null default '{}';
 