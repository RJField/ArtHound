-- 20260505000001_tasks_to_work_rename.sql
-- Rename all "task" references to "work" to match the P→A→W hierarchy.
-- Pure rename: no shape changes, no new columns.
--
-- Touches:
--   generated_tasks        → generated_work  (+ task_name col → work_name)
--   replicated_tasks       → replicated_work
--   source_entity_definitions task_* columns → work_*
--   entity_type check constraint  'task' → 'work'
--   RLS policies on the two renamed tables


-- ── generated_tasks → generated_work ─────────────────────────────────────────

alter table generated_tasks rename to generated_work;
alter table generated_work  rename column task_name to work_name;

alter index if exists generated_tasks_canonical_asset_id_idx
  rename to generated_work_canonical_asset_id_idx;
alter index if exists generated_tasks_studio_id_idx
  rename to generated_work_studio_id_idx;
alter index if exists generated_tasks_studio_id_canonical_asset_id_idx
  rename to generated_work_studio_id_canonical_asset_id_idx;
alter index if exists generated_tasks_generated_at_idx
  rename to generated_work_generated_at_idx;
-- Partial index added by soft-delete migration (postgres appends '1' on collision)
alter index if exists generated_tasks_studio_id_canonical_asset_id_idx1
  rename to generated_work_studio_id_canonical_asset_id_active_idx;


-- ── replicated_tasks → replicated_work ───────────────────────────────────────

alter table replicated_tasks rename to replicated_work;

alter index if exists replicated_tasks_owner_type_owner_id_idx
  rename to replicated_work_owner_type_owner_id_idx;
alter index if exists replicated_tasks_canonical_asset_id_idx
  rename to replicated_work_canonical_asset_id_idx;
alter index if exists replicated_tasks_owner_type_owner_id_source_asset_record_id_idx
  rename to replicated_work_owner_type_owner_id_source_asset_record_id_idx;


-- ── source_entity_definitions: rename task_* columns → work_* ────────────────

alter table source_entity_definitions rename column task_name_field_id         to work_name_field_id;
alter table source_entity_definitions rename column task_name_field_name       to work_name_field_name;
alter table source_entity_definitions rename column task_status_field_id       to work_status_field_id;
alter table source_entity_definitions rename column task_status_field_name     to work_status_field_name;
alter table source_entity_definitions rename column task_start_date_field_id   to work_start_date_field_id;
alter table source_entity_definitions rename column task_start_date_field_name to work_start_date_field_name;
alter table source_entity_definitions rename column task_end_date_field_id     to work_end_date_field_id;
alter table source_entity_definitions rename column task_end_date_field_name   to work_end_date_field_name;
alter table source_entity_definitions rename column task_estimate_field_id     to work_estimate_field_id;
alter table source_entity_definitions rename column task_estimate_field_name   to work_estimate_field_name;


-- ── entity_type: 'task' → 'work' (data + check constraint) ───────────────────

-- Drop the inline check constraint (auto-named by postgres)
alter table source_entity_definitions
  drop constraint source_entity_definitions_entity_type_check;

update source_entity_definitions
  set entity_type = 'work'
  where entity_type = 'task';

alter table source_entity_definitions
  add constraint source_entity_definitions_entity_type_check
  check (entity_type in ('product', 'asset', 'work'));


-- ── RLS: generated_work ───────────────────────────────────────────────────────

drop policy if exists "gt_studio" on generated_work;

create policy "gw_studio" on generated_work for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);


-- ── RLS: replicated_work ──────────────────────────────────────────────────────

drop policy if exists "rt_studio" on replicated_work;
drop policy if exists "rt_vendor"  on replicated_work;

create policy "rw_studio" on replicated_work for all using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "rw_vendor" on replicated_work for all using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);
