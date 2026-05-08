-- Item types can be sourced from Jira issues (existing behaviour) or from
-- the distinct values of a field on asset issues (e.g. Components, Priority).
alter table source_entity_definitions
  add column if not exists item_type_source    text check (item_type_source in ('issues', 'field_values')) default 'issues',
  add column if not exists item_type_field_id   text,
  add column if not exists item_type_field_name text;
