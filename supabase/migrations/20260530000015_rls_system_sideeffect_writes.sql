-- 20260530000015_rls_system_sideeffect_writes.sql
-- RLS migration 15 — let the SYSTEM identity perform user-triggered side-effect writes to
-- system-managed tables (post-cutover regression, batch 2).
--
-- Several audit-log / config writes happen as a SIDE EFFECT of a user action but target tables that
-- only arthound_rpc/arthound_system may write (no `authenticated` policy). Under flag-on they 403 —
-- SILENTLY for the fire-and-forget audit logs (a gap), or as a hard 500 for the platform-admin
-- settings page. The routes now wrap these writes in system_identity(); this migration gives
-- arthound_system the grant + policy to perform them:
--   * payload_access_log     — dispatch/ingest audit (routes/payload.py:_log; fire-and-forget)
--   * credential_access_log  — credential-access audit (lib/source_creds.py; fire-and-forget)
--   * system_settings        — platform-admin READ + WRITE of the registration gate (routes/admin.py)
--   * schema_drift_events    — init wizard resolves drift on field-mapping save (UPDATE; the drift loop
--                              already had INSERT)
-- field_bucket_override_log already grants system INSERT (migration 2) → code wrap only, no grant here.
-- The actor stays a DATA column (actor_*_id / updated_by); only the WRITER becomes the system role.
-- Idempotent.

begin;

-- payload_access_log — append-only dispatch/ingest audit
grant insert on public.payload_access_log to arthound_system;
drop policy if exists sys_all on public.payload_access_log;
create policy sys_all on public.payload_access_log for all to arthound_system using (true) with check (true);

-- credential_access_log — append-only credential-access audit
grant insert on public.credential_access_log to arthound_system;
drop policy if exists sys_all on public.credential_access_log;
create policy sys_all on public.credential_access_log for all to arthound_system using (true) with check (true);

-- system_settings — platform-admin read/write of the singleton (system performs it on the admin's behalf)
grant select, insert, update on public.system_settings to arthound_system;
drop policy if exists sys_all on public.system_settings;
create policy sys_all on public.system_settings for all to arthound_system using (true) with check (true);

-- schema_drift_events — system has INSERT + sys_all policy already; add UPDATE for the init-resolve path
grant update on public.schema_drift_events to arthound_system;

commit;

-- ── Post-apply test ───────────────────────────────────────────────────────────────────────────────
--   as an arthound_system token: INSERT payload_access_log / credential_access_log → ok;
--   SELECT + UPDATE system_settings → ok; UPDATE schema_drift_events → ok.
