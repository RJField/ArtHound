-- 20260530000017_rls_scenario_config_read.sql
-- RLS migration follow-up — system read access to the studio config tables the scenario
-- generation/cleanup loops consult in background (no user context).
--
-- THE GAP (post-cutover regression): the scenario generator runs in system identity
-- (main.py _scenario_generation_loop → _run_generation_task, both inside system_identity()).
-- Its very first step, fetch_validation_data() / _build_matrix_section() (lib/scenario/shared.py,
-- lib/scenario/context.py), reads four studio-config tables:
--     estimate_config, estimate_matrix, workflow_steps, workflow_step_dependencies
-- Under USE_USER_IDENTITY these reads run as arthound_system, which holds NO grant and NO policy
-- on any of them (migration 20260530000002 deliberately excluded estimate_matrix, and never listed
-- the other three). FORCE RLS + no matching policy = deny-all → the generator sees empty steps/matrix
-- → raises ("Profile '…' not in estimate matrix" / "Generation produced no products") → the session
-- flips to generation_failed. Affects BOTH engines (AI generator.py and rule-based deterministic.py
-- both call fetch_validation_data) and is independent of scenario mode.
--
-- WHY READ-ONLY, CROSS-TENANT IS CORRECT HERE: the generation loop is a single background worker that
-- processes pending sessions for ANY studio, so it must read that studio's matrix/steps. App code
-- already scopes every query with studio_id=eq.<id>; the policy mirrors the system role's existing
-- cross-tenant read reach (replicated_assets, canonical_assets, source_credentials, …). The system role
-- NEVER writes these tables — grant + policy are SELECT-only, so the OWNER-PRIVATE write boundary on
-- estimate_matrix (em_studio/em_vendor) is untouched. User paths are unchanged: the scoping/discussion
-- prompts build the same matrix section but run in USER request context against the existing
-- `to authenticated` policies.
--
-- This SUPERSEDES the scope-note in 20260530000002 that asserted arthound_system holds no grant on
-- estimate_matrix: the scenario background loops are a real system entrypoint that needs these reads.
--
-- Additive + idempotent: SELECT-only grant + a SELECT-only `to arthound_system using (true)` policy per
-- table. Re-running drops/recreates the policy and re-asserts the grant harmlessly.

begin;

do $$
declare t text;
begin
  foreach t in array array[
    'estimate_config',
    'estimate_matrix',
    'workflow_steps',
    'workflow_step_dependencies'
  ]
  loop
    execute format('drop policy if exists sys_read on public.%I', t);
    execute format(
      'create policy sys_read on public.%I for select to arthound_system using (true)', t);
  end loop;
end $$;

grant select on public.estimate_config            to arthound_system;
grant select on public.estimate_matrix            to arthound_system;
grant select on public.workflow_steps             to arthound_system;
grant select on public.workflow_step_dependencies to arthound_system;

commit;

-- ── Post-apply check (run manually / in CI; NOT in the transaction) ───────────────────────────────
-- As a minted arthound_system token, each of these must return 200 (was 401/403 before):
--   GET /rest/v1/workflow_steps?select=id&limit=1
--   GET /rest/v1/estimate_matrix?select=id&limit=1
-- And the four tables must appear in the system grant set (SELECT only):
--   select table_name, string_agg(lower(privilege_type), ',') from information_schema.role_table_grants
--    where grantee='arthound_system' and table_schema='public'
--      and table_name in ('estimate_config','estimate_matrix','workflow_steps','workflow_step_dependencies')
--    group by table_name;   -- expect each → 'select'
