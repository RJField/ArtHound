-- 20260530000013_rls_join_request_uniq.sql
-- RLS migration 13 — unique (org, user) on the join-request tables (plan §4a item 3, signup Option C).
--
-- rpc_request_join (migration 4) does `insert ... on conflict (studio_id, user_id) do nothing` to make
-- a re-request idempotent — but the matching unique constraint was never created. The legacy
-- signup-join path uses a plain insert (a brand-new user each time) and so never exercised the ON
-- CONFLICT; the Option C onboarding join path is the FIRST caller and hits
-- 42P10 "there is no unique or exclusion constraint matching the ON CONFLICT specification".
--
-- Add the constraint the RPC was written for. It also enforces the intended data model — one request
-- per user per org. Verified zero existing duplicate (org_id, user_id) rows on dev before adding.
-- Additive + idempotent (guarded create).

begin;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'studio_join_requests_org_user_uniq') then
    alter table public.studio_join_requests
      add constraint studio_join_requests_org_user_uniq unique (studio_id, user_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'vendor_join_requests_org_user_uniq') then
    alter table public.vendor_join_requests
      add constraint vendor_join_requests_org_user_uniq unique (vendor_id, user_id);
  end if;
end $$;

commit;

-- ── Post-apply test ───────────────────────────────────────────────────────────────────────────────
--   call rpc_request_join twice with the same code as one user → both succeed, exactly ONE pending row.
