-- 20260504000002_rls_jwt_claims.sql
-- Replace all subquery-based RLS policies (auth.uid() → *_members lookup)
-- with JWT claim-based policies (auth.jwt()->'app_metadata'->>'studio_id').
--
-- The subquery approach requires authenticated role to have SELECT on
-- studio_members / vendor_members, which is not granted by default.
-- JWT claims are O(1) and self-contained in the token.
--
-- Prerequisite: backfill_jwt_claims.py must have run for all users.

-- ── replicated_assets ─────────────────────────────────────────────────────────
drop policy if exists "ra_studio" on replicated_assets;
drop policy if exists "ra_vendor" on replicated_assets;

create policy "ra_studio" on replicated_assets for all using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "ra_vendor" on replicated_assets for all using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── replicated_products ───────────────────────────────────────────────────────
drop policy if exists "rp_studio" on replicated_products;
drop policy if exists "rp_vendor" on replicated_products;

create policy "rp_studio" on replicated_products for all using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "rp_vendor" on replicated_products for all using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── replicated_item_types ─────────────────────────────────────────────────────
drop policy if exists "ri_studio" on replicated_item_types;
drop policy if exists "ri_vendor" on replicated_item_types;

create policy "ri_studio" on replicated_item_types for all using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "ri_vendor" on replicated_item_types for all using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── source_field_mappings ─────────────────────────────────────────────────────
drop policy if exists "sfm_studio" on source_field_mappings;
drop policy if exists "sfm_vendor" on source_field_mappings;

create policy "sfm_studio" on source_field_mappings for all using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "sfm_vendor" on source_field_mappings for all using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── sync_cursors ──────────────────────────────────────────────────────────────
drop policy if exists "sc_studio_read" on sync_cursors;
drop policy if exists "sc_vendor_read" on sync_cursors;

create policy "sc_studio_read" on sync_cursors for select using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "sc_vendor_read" on sync_cursors for select using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── sync_log ──────────────────────────────────────────────────────────────────
drop policy if exists "sl_studio_read" on sync_log;
drop policy if exists "sl_vendor_read" on sync_log;

create policy "sl_studio_read" on sync_log for select using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "sl_vendor_read" on sync_log for select using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── payload_export_records ────────────────────────────────────────────────────
drop policy if exists "per_vendor" on payload_export_records;

create policy "per_vendor" on payload_export_records for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── init_jobs ─────────────────────────────────────────────────────────────────
drop policy if exists "ij_studio_read" on init_jobs;
drop policy if exists "ij_vendor_read" on init_jobs;

create policy "ij_studio_read" on init_jobs for select using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "ij_vendor_read" on init_jobs for select using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── source_schema_cache ───────────────────────────────────────────────────────
drop policy if exists "ssc_studio" on source_schema_cache;
drop policy if exists "ssc_vendor" on source_schema_cache;

create policy "ssc_studio" on source_schema_cache for select using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "ssc_vendor" on source_schema_cache for select using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── asset_reviews ─────────────────────────────────────────────────────────────
drop policy if exists "studio_members_select" on asset_reviews;
drop policy if exists "studio_members_insert" on asset_reviews;
drop policy if exists "studio_members_update" on asset_reviews;
drop policy if exists "creator_delete" on asset_reviews;

create policy "ar_select" on asset_reviews for select using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "ar_insert" on asset_reviews for insert with check (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "ar_update" on asset_reviews for update using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "ar_delete" on asset_reviews for delete using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  and created_by_email = (auth.jwt()->>'email')
);

-- ── generated_tasks ───────────────────────────────────────────────────────────
drop policy if exists "gt_studio" on generated_tasks;

create policy "gt_studio" on generated_tasks for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- ── source_entity_definitions ─────────────────────────────────────────────────
drop policy if exists "sed_studio" on source_entity_definitions;
drop policy if exists "sed_vendor" on source_entity_definitions;

create policy "sed_studio" on source_entity_definitions for all using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "sed_vendor" on source_entity_definitions for all using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- ── replicated_tasks ──────────────────────────────────────────────────────────
drop policy if exists "rt_studio" on replicated_tasks;
drop policy if exists "rt_vendor" on replicated_tasks;

create policy "rt_studio" on replicated_tasks for all using (
  owner_type = 'studio' and
  owner_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "rt_vendor" on replicated_tasks for all using (
  owner_type = 'vendor' and
  owner_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);
