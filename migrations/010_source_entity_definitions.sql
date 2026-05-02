-- 010_source_entity_definitions.sql
-- Run after 009_project_init.sql
--
-- Stores per-owner definitions of what represents each entity (product, asset, task)
-- in their source tool. These replace the hardcoded config.tables names and let
-- studios scope entities by table + filters + relationship fields.
--
-- entity_type:    'product' | 'asset' | 'task'
-- table_id:       native table ID in source (Airtable table ID)
-- table_name:     human-readable name, stored for display only
-- filters:        [{field_id, field_name, operator ('eq'|'neq'|'contains'), value}]
-- parent_entity_type: null for product; 'product' for asset; 'asset' for task
-- rel_field_id:   ID of the linked-record field that connects child → parent (or parent → child)
-- rel_direction:  'child_holds_link'  — Asset has a "Project" field pointing to Product
--                 'parent_holds_link' — Product has an "Assets" field pointing to Assets

create table source_entity_definitions (
  owner_type          text    not null check (owner_type in ('studio', 'vendor')),
  owner_id            uuid    not null,
  source_type         text    not null default 'airtable',
  entity_type         text    not null check (entity_type in ('product', 'asset', 'task')),

  table_id            text    not null,
  table_name          text    not null,
  filters             jsonb   not null default '[]',

  parent_entity_type  text    check (parent_entity_type in ('product', 'asset')),
  rel_field_id        text,
  rel_field_name      text,
  rel_direction       text    check (rel_direction in ('child_holds_link', 'parent_holds_link')),

  primary key (owner_type, owner_id, source_type, entity_type)
);

create index on source_entity_definitions (owner_type, owner_id);


-- ── RLS ───────────────────────────────────────────────────────────────────────

alter table source_entity_definitions enable row level security;

create policy "sed_studio" on source_entity_definitions for all using (
  owner_type = 'studio' and
  owner_id in (select studio_id from studio_members where user_id = auth.uid())
);
create policy "sed_vendor" on source_entity_definitions for all using (
  owner_type = 'vendor' and
  owner_id in (select vendor_id from vendor_members where user_id = auth.uid())
);
