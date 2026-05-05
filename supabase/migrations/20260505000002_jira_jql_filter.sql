-- 20260505000002_jira_jql_filter.sql
-- Adds jql_filter column to source_entity_definitions for Jira connector.
-- Stores a JQL string that defines which Jira issues map to each PAW level.
-- Null for Airtable studios — the existing filters JSONB column still drives those.
-- Also expands the entity_type check constraint to include 'item_type', which the
-- init wizard already uses but the original constraint omitted.

alter table source_entity_definitions
  add column if not exists jql_filter text;

-- Expand entity_type to include item_type (was product|asset|work only)
alter table source_entity_definitions
  drop constraint if exists source_entity_definitions_entity_type_check;

alter table source_entity_definitions
  add constraint source_entity_definitions_entity_type_check
  check (entity_type in ('product', 'asset', 'work', 'item_type'));
