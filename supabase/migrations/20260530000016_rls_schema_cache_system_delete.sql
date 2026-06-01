-- 20260530000016_rls_schema_cache_system_delete.sql
-- RLS migration 16 — grant arthound_system DELETE on source_schema_cache (batch 3 follow-up).
--
-- source_schema_cache is system-managed (sys_all policy; users have SELECT only). The init wizard's
-- "save credentials" step INVALIDATES the cache with a DELETE (routes/init.py), and that write now runs
-- as the system identity — but migration 2 granted arthound_system only INSERT/UPDATE/SELECT, not
-- DELETE. Add it so the cache invalidation succeeds under flag-on. (INSERT/UPDATE/SELECT already held;
-- the sys_all policy already covers the row predicate.) Idempotent.

begin;
grant delete on public.source_schema_cache to arthound_system;
commit;
