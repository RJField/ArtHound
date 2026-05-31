-- 20260530000001_rls_predicate_functions.sql
-- RLS migration 1 of N — the root-cause fix (docs/plans/rls-migration.md §1, sequencing §8 step 1).
--
-- Resolves org membership through SECURITY DEFINER helper functions that read the membership
-- tables directly, so the `authenticated` role never needs SELECT on those tables and policies
-- never depend on (spoofable) app_metadata JWT claims. This dissolves BOTH historical bugs:
--   - the malformed auth.uid() subquery policies that lacked GRANT SELECT on the membership tables
--   - the JWT-claim-vs-DB-membership authority split
--
-- This file is purely additive: it creates two roles and the predicate functions. It creates NO
-- policies and enables RLS on NO table, so on its own it changes runtime behaviour for nothing.
-- The roles and predicates become load-bearing only once later migrations reference them.
--
-- Roles are created FIRST so every later migration's GRANT / policy / ALTER FUNCTION OWNER can
-- reference them (avoids the grant-before-role ordering bug — plan §1 note + ops review).
--
-- IDENTITY MODEL VALIDATED END-TO-END ON DEV 2026-05-29 via a reversible probe (plan §0d): a user
-- JWT resolves to its own org via this predicate shape; a role=arthound_system token SET ROLEs and a
-- system policy returns all rows; an app_metadata.role spoof in the JWT body grants nothing.
--
-- search_path is pinned to '' on every SECURITY DEFINER function: all object names are therefore
-- schema-qualified (public.*, auth.*) and no earlier-on-path schema can shadow them (plan §1, sec C5).
-- (auth.uid() is wrapped as (select auth.uid()) and predicates are used as `col in (select fn())` so
-- the planner hoists them to a once-per-statement InitPlan — plan §10 perf.)

begin;

-- ── Roles (idempotent; created before any grant references them) ────────────────────────────────
-- arthound_system: the narrow background/system identity (its grants + policies land in §5's file).
-- arthound_rpc:    owner of the cross-tenant SECURITY DEFINER RPCs — a NON-owner of the tables, so
--                  FORCE RLS still applies to it (plan §6). Created here so later files can reference it.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'arthound_system') then
    create role arthound_system nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'arthound_rpc') then
    create role arthound_rpc nologin;
  end if;
end $$;

-- ── Membership id-sets ───────────────────────────────────────────────────────────────────────────
-- The studios / vendors the current user belongs to. SETOF so policies use `col in (select fn())`.

create or replace function public.current_studio_ids()
  returns setof uuid
  language sql security definer stable
  set search_path = ''
as $$
  select studio_id from public.studio_members where user_id = (select auth.uid())
$$;

create or replace function public.current_vendor_ids()
  returns setof uuid
  language sql security definer stable
  set search_path = ''
as $$
  select vendor_id from public.vendor_members where user_id = (select auth.uid())
$$;

-- ── is_my_org: TOTAL polymorphic predicate ───────────────────────────────────────────────────────
-- org_type is pinned to the matching id-set, never a bare union — a studio_id can never match a
-- vendor-owned row and vice versa (plan §2 finding M3).

create or replace function public.is_my_org(p_org_type text, p_org_id uuid)
  returns boolean
  language sql security definer stable
  set search_path = ''
as $$
  select (p_org_type = 'studio' and p_org_id in (select public.current_studio_ids()))
      or (p_org_type = 'vendor' and p_org_id in (select public.current_vendor_ids()))
$$;

-- ── is_org_admin: privileged-write gate (join approval, grant creation, link cancel) ──────────────

create or replace function public.is_org_admin(p_org_type text, p_org_id uuid)
  returns boolean
  language sql security definer stable
  set search_path = ''
as $$
  select exists (
    select 1 from public.studio_members
     where user_id = (select auth.uid()) and studio_id = p_org_id
       and p_org_type = 'studio' and member_role in ('owner','admin')
    union all
    select 1 from public.vendor_members
     where user_id = (select auth.uid()) and vendor_id = p_org_id
       and p_org_type = 'vendor' and member_role in ('owner','admin')
  )
$$;

-- ── is_link_party: caller is a party to an ACTIVE studio↔vendor link (basis for dual-party) ───────

create or replace function public.is_link_party(p_link_id uuid)
  returns boolean
  language sql security definer stable
  set search_path = ''
as $$
  select exists (
    select 1 from public.studio_vendor_links l
     where l.id = p_link_id and l.status = 'active'
       and ( l.studio_id in (select public.current_studio_ids())
          or l.vendor_id in (select public.current_vendor_ids()) )
  )
$$;

-- ── perm ordering helper (view < comment < act); IMMUTABLE — args only ────────────────────────────

create or replace function public.perm_at_least(p_have text, p_need text)
  returns boolean
  language sql immutable
  set search_path = ''
as $$
  select array_position(array['view','comment','act'], p_have)
       >= array_position(array['view','comment','act'], p_need)
$$;

-- ── has_grant: review-subtree grant check (joins link-liveness) ───────────────────────────────────
-- References public.review_grant, created by the cross-org-reviews FEATURE migration
-- (docs/plans/cross-org-reviews.md), NOT this RLS set. Defined here ONLY if that table already
-- exists, so this migration is safe to apply before the review subtree ships. No cutover policy may
-- reference has_grant until review_grant exists (plan §2 Pattern E gate). When the review-subtree
-- migration runs, it (re)creates has_grant itself.

do $$ begin
  if to_regclass('public.review_grant') is not null then
    execute $fn$
      create or replace function public.has_grant(p_subject_type text, p_subject_id uuid, p_perm text)
        returns boolean
        language sql security definer stable
        set search_path = ''
      as $body$
        select exists (
          select 1
            from public.review_grant g
            join public.studio_vendor_links l on l.id = g.link_id and l.status = 'active'
           where g.subject_type = p_subject_type
             and g.subject_id   = p_subject_id
             and g.revoked_at is null
             and public.perm_at_least(g.permission, p_perm)
             and ( (g.grantee_org_type = 'studio' and g.grantee_org_id in (select public.current_studio_ids()))
                or (g.grantee_org_type = 'vendor' and g.grantee_org_id in (select public.current_vendor_ids())) )
        )
      $body$;
    $fn$;
    execute 'revoke all on function public.has_grant(text, uuid, text) from public';
    execute 'grant execute on function public.has_grant(text, uuid, text) to authenticated';
  end if;
end $$;

-- ── Lock down EXECUTE: authenticated ONLY ────────────────────────────────────────────────────────
-- The system role uses current_user = 'arthound_system' for its policies (§5), never these membership
-- predicates, so granting them to arthound_system would only widen surface (plan §1 sec-finding).
-- (has_grant is granted inside the conditional block above when it exists.)

revoke all on function public.current_studio_ids()       from public;
revoke all on function public.current_vendor_ids()       from public;
revoke all on function public.is_my_org(text, uuid)      from public;
revoke all on function public.is_org_admin(text, uuid)   from public;
revoke all on function public.is_link_party(uuid)        from public;
revoke all on function public.perm_at_least(text, text)  from public;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon + service_role on EVERY new function via
-- an explicit (non-PUBLIC) grant, so the `revoke all ... from public` above does NOT remove them.
-- Strip both explicitly so these membership predicates are reachable by `authenticated` only (plan §1
-- intent). Safe: the fns are auth.uid()-gated (anon → empty set), nothing calls them as service_role
-- (which bypasses RLS and so never evaluates a policy that invokes them), and arthound_rpc is granted
-- the subset it needs explicitly in migration 4. postgres (owner) retains EXECUTE implicitly.
revoke execute on function
  public.current_studio_ids(), public.current_vendor_ids(), public.is_my_org(text, uuid),
  public.is_org_admin(text, uuid), public.is_link_party(uuid), public.perm_at_least(text, text)
  from anon, service_role;

grant execute on function public.current_studio_ids()      to authenticated;
grant execute on function public.current_vendor_ids()      to authenticated;
grant execute on function public.is_my_org(text, uuid)     to authenticated;
grant execute on function public.is_org_admin(text, uuid)  to authenticated;
grant execute on function public.is_link_party(uuid)       to authenticated;
grant execute on function public.perm_at_least(text, text) to authenticated;

commit;

-- ── Post-apply guard (run manually / in CI; NOT part of the transaction) ──────────────────────────
-- A later migration must NEVER silently replace these bodies (e.g. is_my_org -> `select true`).
-- Plan §8 step 1 guard: assert the fns exist + are hardened before any policy file is applied.
--
--   select proname, prosecdef,
--          (select array_agg(c) from unnest(proconfig) c where c like 'search_path=%') as sp
--     from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('current_studio_ids','current_vendor_ids','is_my_org','is_org_admin',
--                      'is_link_party','perm_at_least')
--    order by proname;
--   -- expect 6 rows; prosecdef=true for all except perm_at_least; sp = {search_path=""} for every row.
