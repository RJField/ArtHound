-- 20260530000002_rls_system_role.sql
-- RLS migration 2 of N — the system identity (docs/plans/rls-migration.md §5, sequencing §8 step 2).
--
-- Grants the `arthound_system` role (created in migration 1) the LEAST-PRIVILEGE set of table ops the
-- background/system code actually performs, plus a per-table system RLS policy. NOT god-mode: the
-- precise GRANTs are the containment, and because arthound_system is NOT the table owner, RLS still
-- applies to it (a buggy `using(true)` is still bounded by the grant set). This deliberately rejects
-- the blanket `grant ... on all tables` anti-pattern flagged in the adversarial review.
--
-- Containment model (plan §5): one `for all to arthound_system using(true) with check(true)` policy per
-- system table; the GRANT decides which SQL commands the role may issue at all. Add a CI/preflight test
-- asserting the live grant set equals the matrix below (scope-drift guard, finding C3-ops).
--
-- Additive + idempotent: re-asserts the role grant, grants table privileges, (re)creates system
-- policies. RLS is ALREADY enabled on every table below today, so this does not toggle RLS and does not
-- touch the user-facing policies (those are dropped/recreated in the §3 policies file). Old service-role
-- code keeps working after this lands.
--
-- ── Scope reconciliation note (READ THIS) ────────────────────────────────────────────────────────
-- Base = plan §5 scope matrix. Cross-checked against inventory.system_role_scope (observed background
-- access). Deviations, each justified by a real background entrypoint and marked [+ADD]/[~MOD] inline:
--   [~MOD] payload_dispatches: §5 said SELECT only; the attachment-copy worker (lib/attachments
--          copy_payload_attachments) PATCHes payload_data with content hashes → needs UPDATE too.
--   [~MOD] replicated_products/item_types/work: writer upserts (on_conflict) → needs UPDATE, not just
--          INSERT/DELETE; granted SIUD to match replicated_assets and the upsert reality.
--   [~MOD] source_field_mappings: §5 said SELECT; schema-drift loop PATCHes mappings → SELECT, UPDATE.
--   [~MOD] schema_drift_events / field_bucket_override_log: added SELECT alongside INSERT (drift loop
--          reads back); still no UPDATE/DELETE.
--   [+ADD] payload_export_records (SELECT): sync runner reads it (lib/sync/runner). WRITE stays on the
--          ingest RPC (arthound_rpc), not system.
--   [+ADD] scenario_sessions/products/assets/work/messages: the _scenario_generation_loop and
--          _scenario_cleanup_loop (main.py) are background — they MUST be system (no request context →
--          no user token). The scenario *discussion* read path stays USER (plan §4); these grants are
--          only for the generation/cleanup loops.
-- Deliberately NOT granted to system (routed elsewhere — confirm during §4 client refactor):
--   payload_field_mappings, failed_ingests  → written by the ingest flow (becomes an arthound_rpc RPC).
--   generated_work                          → written by schedule generation, a USER request (plan §2).
--   studio_vendor_links, payload_templates  → user/RPC paths; predicates read links as DEFINER, not as
--                                             the system role.
-- Two op-level items to VERIFY during §4 (left at the plan's value for now, flagged):
--   * source_credentials UPDATE — confirm lib/token_refresh writes in place (UPDATE) vs inserts a new
--     row (would need INSERT). Granted SELECT, UPDATE per §5.
--   * sync_log DELETE — only needed if the trim path deletes directly; if trim_sync_log() is a
--     SECURITY DEFINER RPC, system needs EXECUTE on it instead and DELETE here can be dropped.
-- Final scope locks (and the CI scope-drift test is written) in §4 once the client refactor pins
-- exactly which entrypoints run in system context.

begin;

-- Role exists from migration 1; re-assert membership + schema usage idempotently so this file is
-- self-contained.
grant arthound_system to authenticator;
grant usage on schema public to arthound_system;

-- ── Helper: (re)create the uniform system policy on a table ───────────────────────────────────────
-- One permissive policy per table; the GRANT below it is the real op-level containment.
do $$
declare t text;
begin
  foreach t in array array[
    'source_credentials',
    'replicated_assets','replicated_products','replicated_item_types','replicated_work',
    'canonical_assets',
    'sync_cursors','sync_log',
    'source_field_mappings','source_entity_definitions','source_schema_cache',
    'field_bucket_override_log','schema_drift_events',
    'attachment_copy_jobs','attachment_refs',
    'payload_dispatches','payload_export_records',
    'init_jobs',
    'scenario_sessions','scenario_products','scenario_assets','scenario_work','scenario_messages'
  ]
  loop
    execute format('drop policy if exists sys_all on public.%I', t);
    execute format(
      'create policy sys_all on public.%I for all to arthound_system using (true) with check (true)', t);
  end loop;
end $$;

-- ── Least-privilege GRANTs (the containment) ─────────────────────────────────────────────────────
-- Credentials: read for poll/sync; UPDATE for token refresh in place.   [verify UPDATE vs INSERT in §4]
grant select, update                       on public.source_credentials        to arthound_system;

-- Sync replica tables: full upsert + delete lifecycle.
grant select, insert, update, delete       on public.replicated_assets         to arthound_system;
grant select, insert, update, delete       on public.replicated_products       to arthound_system;  -- [~MOD +UPDATE]
grant select, insert, update, delete       on public.replicated_item_types     to arthound_system;  -- [~MOD +UPDATE]
grant select, insert, update, delete       on public.replicated_work           to arthound_system;  -- [~MOD +UPDATE]

-- Canonical identity: mint + maintain, never delete.
grant select, insert, update               on public.canonical_assets          to arthound_system;

-- Sync bookkeeping.
grant select, insert, update               on public.sync_cursors              to arthound_system;
grant select, insert, delete               on public.sync_log                  to arthound_system;  -- [DELETE: verify trim path §4]

-- Source config: read for sync; drift loop updates field mappings.
grant select, update                       on public.source_field_mappings     to arthound_system;  -- [~MOD +UPDATE]
grant select                               on public.source_entity_definitions to arthound_system;
grant select, insert, update               on public.source_schema_cache       to arthound_system;

-- Append-only signal logs (drift loop writes, reads back).
grant select, insert                       on public.field_bucket_override_log to arthound_system;  -- [~MOD +SELECT]
grant select, insert                       on public.schema_drift_events       to arthound_system;  -- [~MOD +SELECT]

-- Attachment pipeline.
grant select, insert, update, delete       on public.attachment_copy_jobs      to arthound_system;
grant select, insert, update               on public.attachment_refs           to arthound_system;
grant select, update                       on public.payload_dispatches        to arthound_system;  -- [~MOD +UPDATE: worker writes content hash]
grant select                               on public.payload_export_records    to arthound_system;  -- [+ADD: sync runner reads]

-- Init/reset jobs.
grant select, insert, update               on public.init_jobs                 to arthound_system;

-- Scenario generation/cleanup loops (background; no user context).  [+ADD beyond §5]
grant select, update, delete               on public.scenario_sessions         to arthound_system;
grant select, insert, delete               on public.scenario_products         to arthound_system;
grant select, insert, delete               on public.scenario_assets           to arthound_system;
grant select, insert, delete               on public.scenario_work             to arthound_system;
grant select, insert, delete               on public.scenario_messages         to arthound_system;

commit;

-- ── Post-apply scope-drift guard (run manually / in CI; NOT in the transaction) ───────────────────
-- Assert the live grant set for arthound_system equals exactly the matrix above. Any extra row = drift.
--
--   select table_name, string_agg(lower(privilege_type), ',' order by privilege_type) as ops
--     from information_schema.role_table_grants
--    where grantee = 'arthound_system' and table_schema = 'public'
--    group by table_name
--    order by table_name;
--
-- And assert arthound_system holds NO grant on any table not in the matrix (esp. studio_members,
-- vendor_members, asset_reviews, estimate_matrix, payload_field_mappings, failed_ingests,
-- generated_work, system_settings, org_role_audit_log, credential_access_log).
