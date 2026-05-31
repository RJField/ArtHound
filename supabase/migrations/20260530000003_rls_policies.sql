-- 20260530000003_rls_policies.sql
-- RLS migration 3 of N — user-facing tenancy policies for ALL tables (plan §2/§3, sequencing §8 step 3).
--
-- This file:
--   1. DROPS every existing policy on the target tables (catalog-driven, NOT a hand-list) — the live
--      catalog showed legacy/duplicate/renamed-table policies (ra_studio + replicated_assets_studio +
--      ra_vendor on one table; stale replicated_tasks/replicated_items policies; sed_owner_all+sed_studio;
--      sfm_owner_all+sfm_studio+sfm_studio_write; etc.). Hand-naming DROPs would miss some (completeness
--      review). A catalog loop scoped to the target set removes them all idempotently.
--   2. CREATES the new command-split policies (SELECT / INSERT / UPDATE / DELETE) keyed on the §1
--      predicate functions — never on app_metadata claims.
--   3. ENABLEs RLS on the two tables that currently have it OFF (credential_access_log, org_role_audit_log);
--      all others already have RLS enabled (verified 2026-05-29).
--
-- DELIBERATELY NOT in this file:
--   * FORCE ROW LEVEL SECURITY — deferred to its own migration AFTER the RPCs land (plan §3 + ops
--     finding: FORCE is defense-in-depth for the arthound_rpc-owned SECURITY DEFINER writes of §6, and
--     must be one atomic migration that EXCLUDES the predicate-consulted tables studio_members /
--     vendor_members / studio_vendor_links per §1a). The user path does not need FORCE (authenticated is
--     a non-owner; RLS always applies to it). Applying FORCE here would arm the §1a recursion footgun
--     before the exemption migration exists.
--   * Pattern E review subtree (review / review_step / review_comment / review_grant / review_event /
--     review_*_def) and has_grant() — gated behind the cross-org-reviews FEATURE migration (plan §2
--     Pattern E). Not created here.
--   * System-role policies — already created in migration 2 (sys_all per system table).
--   * arthound_rpc policies — created with the RPCs (migration 4 / §6).
--
-- This migration changes NO runtime behaviour today: every request still uses the service-role key
-- (RLS bypassed) until the app cutover (§8 step 5). It only changes what WOULD be enforced once a
-- request runs as `authenticated`. Safe to apply ahead of the cutover.
--
-- Column-shape facts verified against the live dev schema 2026-05-29 (some diverge from the plan):
--   * field_bucket_override_log, schema_drift_events: ONLY owner_id (NO owner_type) → scoped by
--     studio-or-vendor membership on owner_id, not is_my_org(owner_type, owner_id).
--   * payload_access_log: actor_studio_id only (no actor_vendor_id) — irrelevant to these SELECT
--     policies (matters for RPC writes, §6).
--   * review_attachments: uploaded_by is an EMAIL (no uploaded_by_user_id) — delete keys on the email
--     claim for now; adding uploaded_by_user_id is a hardening TODO (plan MEDIUM finding).
--   * asset_reviews: has created_by_user_id → creator-delete keys on auth.uid().
--   * credential_access_log, org_role_audit_log: RLS was OFF → enabled here.

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. Catalog-driven DROP of all existing policies on the target tables (robust vs wrong-name guessing)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  r record;
  targets text[] := array[
    -- A
    'studios','vendors',
    -- B
    'studio_members','vendor_members','canonical_assets','workflow_steps','workflow_step_dependencies',
    'estimate_config','payload_templates','vendor_studio_ingest_templates','generated_work',
    'synthetic_targets','scenario_sessions','scenario_messages','scenario_products','scenario_assets',
    'scenario_work','studio_join_requests','vendor_join_requests',
    -- C
    'replicated_assets','replicated_products','replicated_item_types','replicated_work',
    'source_field_mappings','source_entity_definitions','sync_cursors','sync_log','source_schema_cache',
    'init_jobs','field_bucket_override_log','schema_drift_events','asset_reviews','review_attachments',
    -- D
    'studio_vendor_links','studio_vendor_invites','payload_dispatches','payload_field_mappings',
    'payload_access_log','payload_export_records','link_cancellation_audit','link_cancellation_dispatches',
    'estimate_share_series','estimate_share_dispatches','estimate_share_access_log','estimate_matrix',
    -- F (no user policy created below; drop any stale ones)
    'source_credentials','attachment_copy_jobs','attachment_refs','system_settings','failed_ingests',
    'credential_access_log','org_role_audit_log'
  ];
begin
  for r in
    select schemaname, tablename, policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = any(targets)
       and policyname <> 'sys_all'          -- keep the system-role policies from migration 2
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- A. Owner/org-record — read own org row only; create/rename via RPC (§6)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
create policy st_sel on public.studios for select to authenticated
  using (id in (select public.current_studio_ids()));
create policy v_sel on public.vendors for select to authenticated
  using (id in (select public.current_vendor_ids()));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- B. Single-org tenant
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- Membership tables — FORCE-EXEMPT (§1a). Two SELECT policies; writes via RPC (join approval /
-- role change / ownership transfer). sm_co resolves because current_studio_ids() reads this table via
-- the table-owner exemption (the FORCE migration must never include these tables).
create policy sm_self on public.studio_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy sm_co on public.studio_members for select to authenticated
  using (studio_id in (select public.current_studio_ids()));
create policy vm_self on public.vendor_members for select to authenticated
  using (user_id = (select auth.uid()));
create policy vm_co on public.vendor_members for select to authenticated
  using (vendor_id in (select public.current_vendor_ids()));

-- canonical_assets — studio-scoped; SELECT only (sync/canonical-mint = system; ingest = RPC).
create policy ca_sel on public.canonical_assets for select to authenticated
  using (studio_id in (select public.current_studio_ids()));

-- workflow_steps — user-managed config; full CRUD on own (studio OR vendor).
create policy ws_sel on public.workflow_steps for select to authenticated
  using (studio_id in (select public.current_studio_ids())
      or vendor_id in (select public.current_vendor_ids()));
create policy ws_ins on public.workflow_steps for insert to authenticated
  with check (studio_id in (select public.current_studio_ids())
           or vendor_id in (select public.current_vendor_ids()));
create policy ws_upd on public.workflow_steps for update to authenticated
  using (studio_id in (select public.current_studio_ids())
      or vendor_id in (select public.current_vendor_ids()))
  with check (studio_id in (select public.current_studio_ids())
           or vendor_id in (select public.current_vendor_ids()));
create policy ws_del on public.workflow_steps for delete to authenticated
  using (studio_id in (select public.current_studio_ids())
      or vendor_id in (select public.current_vendor_ids()));

-- workflow_step_dependencies — FK chain through workflow_steps (owner of the step).
create policy wsd_all on public.workflow_step_dependencies for all to authenticated
  using (step_id in (select id from public.workflow_steps
                      where studio_id in (select public.current_studio_ids())
                         or vendor_id in (select public.current_vendor_ids())))
  with check (step_id in (select id from public.workflow_steps
                           where studio_id in (select public.current_studio_ids())
                              or vendor_id in (select public.current_vendor_ids())));

-- estimate_config — user-managed; full CRUD on own (studio OR vendor).
create policy ec_all on public.estimate_config for all to authenticated
  using (studio_id in (select public.current_studio_ids())
      or vendor_id in (select public.current_vendor_ids()))
  with check (studio_id in (select public.current_studio_ids())
           or vendor_id in (select public.current_vendor_ids()));

-- payload_templates — studio-managed; full CRUD on own.
create policy pt_all on public.payload_templates for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));

-- vendor_studio_ingest_templates — vendor-managed; full CRUD on own.
create policy vsit_all on public.vendor_studio_ingest_templates for all to authenticated
  using (vendor_id in (select public.current_vendor_ids()))
  with check (vendor_id in (select public.current_vendor_ids()));

-- generated_work — studio writes (schedule generation is a USER request, plan §2). LoreBot's read in
-- a system job is covered by a future system SELECT policy if needed (not granted in migration 2 yet).
create policy gw_sel on public.generated_work for select to authenticated
  using (studio_id in (select public.current_studio_ids()));
create policy gw_ins on public.generated_work for insert to authenticated
  with check (studio_id in (select public.current_studio_ids()));
create policy gw_upd on public.generated_work for update to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));
create policy gw_del on public.generated_work for delete to authenticated
  using (studio_id in (select public.current_studio_ids()));

-- synthetic_targets — studio admin feature (token_enc inside; app gates admin). Full CRUD on own studio.
create policy syt_all on public.synthetic_targets for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));

-- scenario_* — studio-scoped (all carry studio_id directly). User CRUD own; the generation/cleanup
-- LOOPS write via the system role (migration 2). Discussion read path is USER (§4).
create policy ss_all on public.scenario_sessions for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));
create policy smsg_all on public.scenario_messages for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));
create policy sprod_all on public.scenario_products for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));
create policy sasset_all on public.scenario_assets for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));
create policy swork_all on public.scenario_work for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));

-- join requests — requester sees own; org admin sees the org's. Creation + approval via RPC (§6
-- bootstrap: a pre-membership user can't be gated by membership, so rpc_request_join handles INSERT;
-- rpc_approve_join_request handles the status UPDATE). No user write policy here.
create policy sjr_self on public.studio_join_requests for select to authenticated
  using (user_id = (select auth.uid()));
create policy sjr_admin on public.studio_join_requests for select to authenticated
  using (public.is_org_admin('studio', studio_id));
create policy vjr_self on public.vendor_join_requests for select to authenticated
  using (user_id = (select auth.uid()));
create policy vjr_admin on public.vendor_join_requests for select to authenticated
  using (public.is_org_admin('vendor', vendor_id));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- C. Polymorphic owner (owner_type, owner_id) — SELECT-ONLY for users; writes via system role / RPC.
--    Index-friendly disjunction (NOT scalar is_my_org) on the high-row replicated_* tables (plan §3).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
create policy ra_sel on public.replicated_assets for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));
create policy rp_sel on public.replicated_products for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));
create policy rit_sel on public.replicated_item_types for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));
create policy rw_sel on public.replicated_work for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));

-- source config — SELECT-only for users. NOTE/FLAG (plan §3 + completeness finding): there IS a
-- studio config-UI write path (FieldMappingModal save / init wizard) and a drift-resolution PATCH.
-- Whether those run in USER vs SYSTEM context is resolved in §4. If they stay user-initiated requests,
-- add scoped INSERT/UPDATE here for the owning org. Defaulting to SELECT-only (system-owned truth) is
-- the safe choice and must be revisited before cutover so the config UI doesn't silently break.
create policy sfm_sel on public.source_field_mappings for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));
create policy sed_sel on public.source_entity_definitions for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));

-- sync bookkeeping / caches / jobs — SELECT-only for users (system writes).
create policy sc_sel on public.sync_cursors for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));
create policy sl_sel on public.sync_log for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));
create policy ssc_sel on public.source_schema_cache for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));
create policy ij_sel on public.init_jobs for select to authenticated
  using ((owner_type='studio' and owner_id in (select public.current_studio_ids()))
      or (owner_type='vendor' and owner_id in (select public.current_vendor_ids())));

-- field_bucket_override_log / schema_drift_events — ONLY owner_id (no owner_type, verified). owner_id
-- is a studio OR vendor id; membership sets are disjoint UUID spaces so this stays tenant-scoped.
-- SELECT-only (system/drift loop writes).
create policy fbol_sel on public.field_bucket_override_log for select to authenticated
  using (owner_id in (select public.current_studio_ids())
      or owner_id in (select public.current_vendor_ids()));
create policy sde_sel on public.schema_drift_events for select to authenticated
  using (owner_id in (select public.current_studio_ids())
      or owner_id in (select public.current_vendor_ids()));

-- asset_reviews — preserves CURRENT cross-org review visibility under the predicate model: a studio
-- sees all reviews on its assets (studio_id) regardless of author; any org sees reviews it authored.
-- Write only as your own org; delete only your own creation. (The cross-org-reviews FEATURE will
-- supersede this; until then this is the live behaviour.)
create policy ar_sel on public.asset_reviews for select to authenticated
  using (studio_id in (select public.current_studio_ids())
      or public.is_my_org(author_org_type, author_org_id));
create policy ar_ins on public.asset_reviews for insert to authenticated
  with check (public.is_my_org(author_org_type, author_org_id));
create policy ar_upd on public.asset_reviews for update to authenticated
  using (public.is_my_org(author_org_type, author_org_id))
  with check (public.is_my_org(author_org_type, author_org_id));
create policy ar_del on public.asset_reviews for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and created_by_user_id = (select auth.uid()));

-- review_attachments — same visibility as the parent review (carries studio_id + author org).
-- DELETE keys on the email claim (no uploaded_by_user_id column yet — hardening TODO).
create policy rat_sel on public.review_attachments for select to authenticated
  using (studio_id in (select public.current_studio_ids())
      or public.is_my_org(author_org_type, author_org_id));
create policy rat_ins on public.review_attachments for insert to authenticated
  with check (public.is_my_org(author_org_type, author_org_id));
create policy rat_del on public.review_attachments for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and uploaded_by = (select auth.jwt() ->> 'email'));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- D. Dual-party cross-org — SELECT either party; WRITE owner-only; cross-org transitions via RPC (§6).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- studio_vendor_links — FORCE-EXEMPT (§1a; is_link_party reads it). SELECT both parties; create/cancel
-- via RPC (arthound_rpc gets its own policy in §6).
create policy svl_sel on public.studio_vendor_links for select to authenticated
  using (studio_id in (select public.current_studio_ids())
      or vendor_id in (select public.current_vendor_ids()));

-- studio_vendor_invites — studio manages its invites; vendor reads invites addressed to it; accept via RPC.
create policy svi_studio on public.studio_vendor_invites for all to authenticated
  using (studio_id in (select public.current_studio_ids()))
  with check (studio_id in (select public.current_studio_ids()));
create policy svi_vendor_sel on public.studio_vendor_invites for select to authenticated
  using (vendor_id in (select public.current_vendor_ids()));

-- payload_dispatches — sender studio owns (CRUD); recipient vendor reads. Recipient state changes
-- (viewed/ingested) via RPC, not a recipient UPDATE policy. payload_data immutability: BEFORE UPDATE
-- trigger TODO (plan §3).
create policy pd_sel on public.payload_dispatches for select to authenticated
  using (sender_studio_id in (select public.current_studio_ids())
      or recipient_vendor_id in (select public.current_vendor_ids()));
create policy pd_ins on public.payload_dispatches for insert to authenticated
  with check (sender_studio_id in (select public.current_studio_ids()));
create policy pd_upd on public.payload_dispatches for update to authenticated
  using (sender_studio_id in (select public.current_studio_ids()))
  with check (sender_studio_id in (select public.current_studio_ids()));

-- payload_field_mappings — vendor owns the mapping CONFIG (CRUD own); studio reads via dispatch FK.
-- FLAG (completeness finding): the ingest-RESULT columns (ingested_at, ingested_source_record_id,
-- failed_at, failure_reason) must NOT be vendor-writable — they belong to the ingest RPC. Enforce via a
-- column grant or a BEFORE UPDATE trigger in §6; the row-level policy alone cannot express that.
create policy pfm_vendor on public.payload_field_mappings for all to authenticated
  using (recipient_vendor_id in (select public.current_vendor_ids()))
  with check (recipient_vendor_id in (select public.current_vendor_ids()));
create policy pfm_studio_sel on public.payload_field_mappings for select to authenticated
  using (dispatch_id in (select id from public.payload_dispatches
                          where sender_studio_id in (select public.current_studio_ids())));

-- payload_access_log — SELECT both parties via dispatch FK; writes via RPC/system (no user INSERT).
create policy pal_studio_sel on public.payload_access_log for select to authenticated
  using (dispatch_id in (select id from public.payload_dispatches
                          where sender_studio_id in (select public.current_studio_ids())));
create policy pal_vendor_sel on public.payload_access_log for select to authenticated
  using (dispatch_id in (select id from public.payload_dispatches
                          where recipient_vendor_id in (select public.current_vendor_ids())));

-- payload_export_records — vendor reads own; studio reads via dispatch FK (outbox ingestion status,
-- completeness finding). Writes via ingest RPC.
create policy per_vendor_sel on public.payload_export_records for select to authenticated
  using (vendor_id in (select public.current_vendor_ids()));
create policy per_studio_sel on public.payload_export_records for select to authenticated
  using (dispatch_id in (select id from public.payload_dispatches
                          where sender_studio_id in (select public.current_studio_ids())));

-- link cancellation audit — SELECT both parties via link FK; writes via RPC/system.
create policy lca_sel on public.link_cancellation_audit for select to authenticated
  using (link_id in (select id from public.studio_vendor_links
                      where studio_id in (select public.current_studio_ids())
                         or vendor_id in (select public.current_vendor_ids())));
create policy lcd_sel on public.link_cancellation_dispatches for select to authenticated
  using (link_cancellation_id in (
           select id from public.link_cancellation_audit
            where link_id in (select id from public.studio_vendor_links
                               where studio_id in (select public.current_studio_ids())
                                  or vendor_id in (select public.current_vendor_ids()))));

-- estimate_share_series — vendor (owner) reads own; recipient studio reads. Create/supersede via RPC.
create policy ess_vendor_sel on public.estimate_share_series for select to authenticated
  using (vendor_id in (select public.current_vendor_ids()));
create policy ess_studio_sel on public.estimate_share_series for select to authenticated
  using (recipient_studio_id in (select public.current_studio_ids()));

-- estimate_share_dispatches — vendor reads own; studio reads live (not revoked, not expired), matching
-- the original time-gated visibility. Writes via RPC.
create policy esd_vendor_sel on public.estimate_share_dispatches for select to authenticated
  using (vendor_id in (select public.current_vendor_ids()));
create policy esd_studio_sel on public.estimate_share_dispatches for select to authenticated
  using (recipient_studio_id in (select public.current_studio_ids())
     and revoked_at is null
     and (expires_at is null or expires_at > now()));

-- estimate_share_access_log — SELECT both parties via dispatch FK; writes via RPC/system.
create policy esal_vendor_sel on public.estimate_share_access_log for select to authenticated
  using (dispatch_id in (select id from public.estimate_share_dispatches
                          where vendor_id in (select public.current_vendor_ids())));
create policy esal_studio_sel on public.estimate_share_access_log for select to authenticated
  using (dispatch_id in (select id from public.estimate_share_dispatches
                          where recipient_studio_id in (select public.current_studio_ids())));

-- estimate_matrix — OWNER-PRIVATE (plan §2/§3 corrected). Studio sees only its own base rows
-- (link_id is null hardening); vendor sees its own base + per-link override rows; neither sees the
-- other. Studio gets vendor rates ONLY via the frozen estimate_share_dispatches.snapshot.
create policy em_studio on public.estimate_matrix for all to authenticated
  using (studio_id in (select public.current_studio_ids()) and link_id is null)
  with check (studio_id in (select public.current_studio_ids()) and link_id is null);
create policy em_vendor on public.estimate_matrix for all to authenticated
  using (vendor_id in (select public.current_vendor_ids()))
  with check (vendor_id in (select public.current_vendor_ids()));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- F. System-only — NO user policy (deny-all to authenticated). System role policies are in migration 2.
--    Enable RLS on the two that currently have it OFF; the rest already have RLS on.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.credential_access_log enable row level security;   -- was OFF (plan §2)
alter table public.org_role_audit_log    enable row level security;   -- was OFF (plan §2)
-- source_credentials / attachment_copy_jobs / attachment_refs / system_settings / failed_ingests:
-- RLS already enabled; deny-all to users by having no authenticated policy.

-- org_role_audit_log — NOT pure F: org admins may READ their org's audit trail (plan §2). No user write
-- (writes via the role-change RPC / system).
create policy oral_admin_sel on public.org_role_audit_log for select to authenticated
  using (public.is_org_admin(org_type, org_id));

commit;

-- ── Post-apply guard (run manually / in CI; NOT in the transaction) ───────────────────────────────
-- 1. No surviving policy references app_metadata (the old spoofable authority):
--      select tablename, policyname from pg_policies
--       where schemaname='public' and (qual like '%app_metadata%' or with_check like '%app_metadata%');
--      -- expect ZERO rows.
-- 2. Every target table has the intended policy set (spot-check the high-risk ones):
--      estimate_matrix (em_studio has `link_id is null`), payload_dispatches (no recipient UPDATE),
--      replicated_assets (SELECT only, disjunction form), source_credentials (no authenticated policy).
-- 3. FORCE is intentionally NOT set here — applied in a later migration that EXCLUDES studio_members /
--    vendor_members / studio_vendor_links (§1a).
