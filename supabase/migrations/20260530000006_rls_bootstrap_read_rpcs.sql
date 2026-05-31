-- 20260530000006_rls_bootstrap_read_rpcs.sql
-- RLS migration 6 — read-RPCs for the pre-login + pending-member paths (plan §4a item 2).
--
-- A handful of reads happen with NO authenticated member behind them and so cannot be served by the
-- user/system identities once USE_USER_IDENTITY is on:
--   * the public registration gate + system-invite check (gate signup itself — can't be deferred),
--   * public org-invite-code resolution (the join UI, pre-login),
--   * the pending-member org-name lookup (an authenticated user who is NOT yet a member of the org they
--     requested to join — st_sel/v_sel correctly deny them a direct studios/vendors read).
-- Under flag-on these would fail closed (no bound token) or RLS-deny. Each becomes a SECURITY DEFINER
-- read-RPC that returns ONLY public-safe fields and is reached with the anon key (public ones) or the
-- caller's JWT (the pending one).
--
-- OWNERSHIP: postgres-owned (NOT arthound_rpc) for two reasons — (1) postgres has BYPASSRLS so the
-- definer reads succeed against the FORCE'd tables without per-table policies, and (2) the body can call
-- auth.uid() directly (postgres has auth-schema access; this is how the §1 predicate fns reach it). They
-- are created here as postgres and never reassigned, so they stay postgres-owned.
--
-- SAFETY: each returns only what the corresponding endpoint already exposed publicly today —
--   * rpc_registration_required / rpc_check_system_invite: ONLY a boolean; NEVER the configured code.
--   * rpc_resolve_invite: org name + type only (same as the rate-limited resolve endpoint), no ids.
--   * rpc_my_pending_org: scoped by auth.uid() to the CALLER'S OWN pending request — reveals an org name
--     only for an org the caller already asked to join (already knows the invite code for).
--
-- Flag-independent: callable with the anon key whether USE_USER_IDENTITY is on or off (the definer body
-- bypasses RLS regardless), so the wiring in routes/auth.py + routes/members.py needs no flag branch.
-- Idempotent (create-or-replace + revoke/grant).

begin;

-- ── Public org-invite resolution (anon) ───────────────────────────────────────────────────────────
create or replace function public.rpc_resolve_invite(p_code text)
  returns table(org_type text, org_name text)
  language sql security definer stable set search_path = ''
as $$
  select 'studio', s.name from public.studios s where s.invite_code = p_code
  union all
  select 'vendor', v.name from public.vendors v where v.invite_code = p_code
  limit 1
$$;

-- ── Platform registration gate (anon) — boolean only, never the code ──────────────────────────────
create or replace function public.rpc_registration_required()
  returns boolean
  language sql security definer stable set search_path = ''
as $$
  select coalesce((select s.registration_invite_required from public.system_settings s where s.id = true), false)
$$;

-- ── System-invite check (anon) — compares internally, returns valid/invalid only ───────────────────
-- Mirrors the old _check_system_invite semantics: gate off → true; gate on but no code configured → true.
create or replace function public.rpc_check_system_invite(p_code text)
  returns boolean
  language sql security definer stable set search_path = ''
as $$
  with cfg as (
    select s.registration_invite_required as required,
           nullif(trim(s.registration_invite_code), '') as code
      from public.system_settings s where s.id = true
  )
  select case
    when not coalesce((select required from cfg), false) then true
    when (select code from cfg) is null                  then true
    else upper(coalesce(trim(p_code), '')) = upper((select code from cfg))
  end
$$;

-- ── Pending-member org lookup (authenticated; auth.uid()-scoped) ───────────────────────────────────
create or replace function public.rpc_my_pending_org()
  returns table(org_type text, org_id uuid, org_name text)
  language sql security definer stable set search_path = ''
as $$
  select 'studio', s.id, s.name
    from public.studio_join_requests r
    join public.studios s on s.id = r.studio_id
   where r.user_id = auth.uid() and r.status = 'pending'
  union all
  select 'vendor', v.id, v.name
    from public.vendor_join_requests r
    join public.vendors v on v.id = r.vendor_id
   where r.user_id = auth.uid() and r.status = 'pending'
  limit 1
$$;

-- ── EXECUTE lockdown (Supabase default-grants anon+authenticated+service_role on every new fn) ──────
-- Public reads: anon + authenticated; strip service_role (request paths never use it here).
revoke all on function public.rpc_resolve_invite(text)        from public;
revoke all on function public.rpc_registration_required()     from public;
revoke all on function public.rpc_check_system_invite(text)   from public;
revoke execute on function public.rpc_resolve_invite(text), public.rpc_registration_required(),
  public.rpc_check_system_invite(text) from service_role;
grant  execute on function public.rpc_resolve_invite(text), public.rpc_registration_required(),
  public.rpc_check_system_invite(text) to anon, authenticated;
-- Pending lookup: authenticated ONLY (uses auth.uid(); anon/service_role get nothing useful).
revoke all on function public.rpc_my_pending_org() from public;
revoke execute on function public.rpc_my_pending_org() from anon, service_role;
grant  execute on function public.rpc_my_pending_org() to authenticated;

commit;

-- ── Post-apply guard (run manually / in CI) ───────────────────────────────────────────────────────
--   select proname, pg_get_userbyid(proowner) owner, prosecdef,
--          (select array_to_string(array_agg(c),';') from unnest(proconfig) c where c like 'search_path=%') sp
--     from pg_proc where pronamespace='public'::regnamespace
--      and proname in ('rpc_resolve_invite','rpc_registration_required','rpc_check_system_invite','rpc_my_pending_org');
--   -- expect: owner=postgres, prosecdef=t, sp=search_path="" for all four.
--   -- EXECUTE: the 3 public ones → {anon,authenticated}; rpc_my_pending_org → {authenticated}.
