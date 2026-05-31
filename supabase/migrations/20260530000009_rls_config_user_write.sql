-- 20260530000009_rls_config_user_write.sql
-- RLS migration 9 — scoped USER write policies for the studio/vendor CONFIG tables (plan §4a item 6,
-- the §3 FLAG left open in migration 3).
--
-- source_field_mappings and source_entity_definitions are Pattern C (polymorphic owner_type/owner_id),
-- and migration 3 gave users SELECT-only — correct for the SYNCED-DATA tables (replicated_*), but WRONG
-- for these two: they hold user-AUTHORED config written by the init wizard (PUT /entity-definitions) and
-- the field-mapping UI (PUT /field-mapping) as the logged-in org member. Left SELECT-only, the config UI
-- silently breaks once USE_USER_IDENTITY is on (the user's upsert RLS-denies). The routes already write
-- via the user context (_headers), so adding these policies is sufficient — no route change.
--
-- SCOPE = the OWNING org (same index-friendly disjunction as the *_sel policies — NOT scalar is_my_org,
-- so the (owner_type, owner_id) index is usable). This is the tenant-isolation boundary: a member can
-- write ONLY their own org's config, never another org's. Admin-vs-member gating stays an APP concern
-- (the routes gate as they do today); RLS here enforces the cross-tenant boundary, which is the point of
-- the migration. The system drift loop keeps writing via its sys_all policy (migration 2); these add the
-- user path alongside it. Idempotent.

begin;

-- ── source_field_mappings — user write (insert/update for the upsert path + delete) ────────────────
drop policy if exists sfm_ins on public.source_field_mappings;
create policy sfm_ins on public.source_field_mappings for insert to authenticated
  with check ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
           or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())));

drop policy if exists sfm_upd on public.source_field_mappings;
create policy sfm_upd on public.source_field_mappings for update to authenticated
  using ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())))
  with check ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
           or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())));

drop policy if exists sfm_del on public.source_field_mappings;
create policy sfm_del on public.source_field_mappings for delete to authenticated
  using ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())));

-- ── source_entity_definitions — user write (insert/update for the upsert path + delete) ────────────
drop policy if exists sed_ins on public.source_entity_definitions;
create policy sed_ins on public.source_entity_definitions for insert to authenticated
  with check ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
           or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())));

drop policy if exists sed_upd on public.source_entity_definitions;
create policy sed_upd on public.source_entity_definitions for update to authenticated
  using ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())))
  with check ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
           or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())));

drop policy if exists sed_del on public.source_entity_definitions;
create policy sed_del on public.source_entity_definitions for delete to authenticated
  using ((owner_type = 'studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type = 'vendor' and owner_id in (select public.current_vendor_ids())));

commit;

-- ── Post-apply test (plan §9; run as a member JWT) ────────────────────────────────────────────────
--   * a studio member upserts source_field_mappings for their own studio  → OK.
--   * the same member tries to write owner_id = ANOTHER org                → 0 rows / RLS deny.
--   * replicated_assets / sync_* remain user-write-DENIED (only these two config tables got user write).
