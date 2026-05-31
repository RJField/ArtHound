-- 20260530000010_rls_sync_log_trim_grant.sql
-- RLS migration 10 — let the system role run the sync_log trim (plan §4a item 7, sync_log half).
--
-- The nightly trim loop (main.py _sync_log_trim_loop) calls the SECURITY DEFINER RPC trim_sync_log()
-- (POST /rest/v1/rpc/trim_sync_log). That function is owned by postgres and deletes as postgres, but it
-- was only granted EXECUTE to service_role + postgres — NOT arthound_system. So once the trim loop runs
-- under the system identity (USE_USER_IDENTITY on), the call 403s and sync_log grows unbounded
-- (silently — the loop swallows exceptions). Grant EXECUTE to arthound_system.
--
-- Because trim_sync_log() does the DELETE as its postgres owner (SECURITY DEFINER), arthound_system no
-- longer needs the direct sync_log DELETE granted in migration 2 — but that grant is harmless and other
-- paths are not re-verified here, so it is left in place (drop later if a least-privilege pass confirms
-- nothing else deletes sync_log as the system role). Idempotent.

begin;

grant execute on function public.trim_sync_log(integer) to arthound_system;

commit;

-- ── Post-apply ────────────────────────────────────────────────────────────────────────────────────
--   select has_function_privilege('arthound_system','public.trim_sync_log(integer)','EXECUTE');  -- expect t
