-- 20260508000002_rls_expand.sql
-- Extend RLS to all previously unprotected tables, and fix the asset_reviews
-- subquery regression introduced in 20260506000001_reviews_v2_schema.sql.
--
-- Steps 1–3 run in one transaction. Do not split across deploys — there is no
-- safe window between enabling RLS and adding policies.
--
-- Post-deploy smoke test:
--   1. Studio JWT  → GET /rest/v1/canonical_assets          → own rows only
--   2. Vendor JWT  → GET /rest/v1/payload_field_mappings    → own rows only
--   3. Cross-tenant: studio A JWT + studio B owner_id       → empty result
--   4. Service role → all rows on all tables
--   5. Any JWT     → GET /rest/v1/attachment_copy_jobs      → empty (no policies)

begin;


-- ── STEP 1: enable RLS on unprotected tables ──────────────────────────────────

alter table canonical_assets           enable row level security;
alter table studios                    enable row level security;
alter table vendors                    enable row level security;
alter table studio_members             enable row level security;
alter table vendor_members             enable row level security;
alter table workflow_steps             enable row level security;
alter table workflow_step_dependencies enable row level security;
alter table estimate_config            enable row level security;
alter table estimate_matrix            enable row level security;
alter table payload_dispatches         enable row level security;
alter table payload_templates          enable row level security;
alter table payload_field_mappings     enable row level security;
alter table payload_access_log         enable row level security;
alter table synthetic_targets          enable row level security;
alter table attachment_copy_jobs       enable row level security;
alter table attachment_refs            enable row level security;


-- ── STEP 2: JWT-claim policies (O(1); no subqueries on auth tables) ───────────
-- Drop-if-exists guards make this re-runnable without errors.

-- canonical_assets
drop policy if exists "ca_studio" on canonical_assets;
create policy "ca_studio" on canonical_assets for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- studios: read own record (writes go through service-role API)
drop policy if exists "st_select" on studios;
create policy "st_select" on studios for select using (
  id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- vendors: read own record (writes go through service-role API)
drop policy if exists "v_select" on vendors;
create policy "v_select" on vendors for select using (
  id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- studio_members: studio reads its own member list
drop policy if exists "sm_select" on studio_members;
create policy "sm_select" on studio_members for select using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- vendor_members: vendor reads its own member list
drop policy if exists "vm_select" on vendor_members;
create policy "vm_select" on vendor_members for select using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- workflow_steps
drop policy if exists "ws_studio" on workflow_steps;
create policy "ws_studio" on workflow_steps for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- workflow_step_dependencies: one FK-chain join through workflow_steps
drop policy if exists "wsd_studio" on workflow_step_dependencies;
create policy "wsd_studio" on workflow_step_dependencies for all using (
  step_id in (
    select id from workflow_steps
    where studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  )
);

-- estimate_config
drop policy if exists "ec_studio" on estimate_config;
create policy "ec_studio" on estimate_config for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- estimate_matrix
drop policy if exists "em_studio" on estimate_matrix;
create policy "em_studio" on estimate_matrix for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- payload_templates
drop policy if exists "pt_studio" on payload_templates;
create policy "pt_studio" on payload_templates for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- payload_dispatches: studio owns (sender); vendor reads (recipient)
drop policy if exists "pd_studio"        on payload_dispatches;
drop policy if exists "pd_vendor_select" on payload_dispatches;
create policy "pd_studio" on payload_dispatches for all using (
  sender_studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "pd_vendor_select" on payload_dispatches for select using (
  recipient_vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);

-- payload_field_mappings:
--   vendor: explicit per-operation policies (WITH CHECK required on insert)
--   studio: read-only via FK chain through payload_dispatches
drop policy if exists "pfm_vendor_select" on payload_field_mappings;
drop policy if exists "pfm_vendor_insert" on payload_field_mappings;
drop policy if exists "pfm_vendor_update" on payload_field_mappings;
drop policy if exists "pfm_studio_select" on payload_field_mappings;
create policy "pfm_vendor_select" on payload_field_mappings for select using (
  recipient_vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);
create policy "pfm_vendor_insert" on payload_field_mappings for insert with check (
  recipient_vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);
create policy "pfm_vendor_update" on payload_field_mappings for update using (
  recipient_vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);
create policy "pfm_studio_select" on payload_field_mappings for select using (
  dispatch_id in (
    select id from payload_dispatches
    where sender_studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  )
);

-- payload_access_log: SELECT only for both parties; no INSERT policy intentional
-- (all writes go through service-role _log() helper)
drop policy if exists "pal_studio_select" on payload_access_log;
drop policy if exists "pal_vendor_select" on payload_access_log;
create policy "pal_studio_select" on payload_access_log for select using (
  dispatch_id in (
    select id from payload_dispatches
    where sender_studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  )
);
create policy "pal_vendor_select" on payload_access_log for select using (
  dispatch_id in (
    select id from payload_dispatches
    where recipient_vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
  )
);

-- synthetic_targets
drop policy if exists "syt_studio" on synthetic_targets;
create policy "syt_studio" on synthetic_targets for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);

-- attachment_copy_jobs and attachment_refs: service-role only internal queues.
-- RLS is enabled above; omitting policies blocks all non-service-role access.


-- ── STEP 3: fix asset_reviews subquery regression ─────────────────────────────
--
-- 20260506000001 added subquery-based policies (studio_members / vendor_members).
-- Those require GRANT SELECT on the membership tables to the authenticated role,
-- which is not granted — making them silently non-functional for non-service-role.
-- Additionally, the JWT-claim policies from 20260504000002 were never dropped by
-- that migration, leaving conflicting policy sets on the table.
--
-- Drop everything and replace with clean JWT-claim policies covering both orgs.

drop policy if exists "ar_select"         on asset_reviews;
drop policy if exists "ar_insert"         on asset_reviews;
drop policy if exists "ar_update"         on asset_reviews;
drop policy if exists "ar_delete"         on asset_reviews;
drop policy if exists "studio_select"     on asset_reviews;
drop policy if exists "vendor_select"     on asset_reviews;
drop policy if exists "studio_insert"     on asset_reviews;
drop policy if exists "vendor_insert"     on asset_reviews;
drop policy if exists "org_member_update" on asset_reviews;
drop policy if exists "creator_delete"    on asset_reviews;

create policy "ar_select" on asset_reviews for select using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  or (
    author_org_type = 'vendor' and
    author_org_id   = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
  )
);

create policy "ar_insert" on asset_reviews for insert with check (
  (author_org_type = 'studio' and studio_id    = (auth.jwt()->'app_metadata'->>'studio_id')::uuid)
  or
  (author_org_type = 'vendor' and author_org_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid)
);

create policy "ar_update" on asset_reviews for update using (
  (author_org_type = 'studio' and studio_id    = (auth.jwt()->'app_metadata'->>'studio_id')::uuid)
  or
  (author_org_type = 'vendor' and author_org_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid)
);

-- Known limitation: keyed on created_by_email; email change loses delete access.
-- Clean fix is P4: add created_by_user_id and switch to auth.uid().
create policy "ar_creator_delete" on asset_reviews for delete using (
  (
    (author_org_type = 'studio' and studio_id    = (auth.jwt()->'app_metadata'->>'studio_id')::uuid)
    or
    (author_org_type = 'vendor' and author_org_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid)
  )
  and created_by_email = (auth.jwt()->>'email')
);


commit;
