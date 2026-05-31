-- 20260530000007_rls_members_mgmt_rpcs.sql
-- RLS migration 7 — complete the org-member-management write surface (plan §4a item 4, members).
--
-- Migration 4 shipped rpc_decide_join_request + rpc_update_member_role, but the members surface has more
-- admin writes that are RLS-blocked for users (membership tables + studios/vendors + org_role_audit_log
-- are all user-unwritable) and were NOT covered:
--   * org_role_audit_log writes (every privilege change) — SELECT-only for users → audit silently lost.
--   * remove_member (DELETE membership) — no RPC.
--   * invite-code regenerate (UPDATE studios/vendors) — no RPC (pattern A = write-RPC-only).
--   * ownership transfer — the legacy transfer_org_ownership is SECURITY INVOKER (its membership UPDATEs
--     RLS-deny once the caller runs as `authenticated`), trusts a spoofable p_current_owner_id, and is
--     even granted to anon. Replaced for the user path by an auth.uid()-authz'd RPC.
--
-- All new RPCs are owned by arthound_rpc (bounded blast radius — subject to its per-table policies under
-- FORCE, like the §6 cross-org RPCs), SECURITY DEFINER, SET search_path='', REVOKE from public/anon/
-- service_role, GRANT EXECUTE to authenticated. They call public.current_uid() (the postgres-owned
-- auth.uid() wrapper from migration 4) and public.is_org_admin() for authz. Idempotent.
--
-- The legacy transfer_org_ownership is LEFT in place for the flag-off path (the route calls it via the
-- service-role key, where its writes are not RLS-blocked) but its anon/authenticated EXECUTE is revoked
-- (harmless under RLS, but no legitimate direct caller).

begin;

-- Ownership-reassignment prerequisites (idempotent; see migration 4 for the rationale).
do $$ begin execute format('grant arthound_rpc to %I with set true, inherit true', current_user); end $$;
grant create on schema public to arthound_rpc;  -- transient; revoked after the ownership block below

-- ── New arthound_rpc table privileges (exactly what these RPCs write) ───────────────────────────────
grant delete on public.studio_members to arthound_rpc;          -- rpc_remove_member / transfer
grant delete on public.vendor_members to arthound_rpc;
grant update on public.studios        to arthound_rpc;          -- rpc_regenerate_invite_code
grant update on public.vendors        to arthound_rpc;
grant insert on public.org_role_audit_log to arthound_rpc;      -- rpc_write_org_audit
-- arthound_rpc policy on org_role_audit_log (the others already have rpc_all from migration 4).
drop policy if exists rpc_all on public.org_role_audit_log;
create policy rpc_all on public.org_role_audit_log for all to arthound_rpc using (true) with check (true);

-- ── rpc_write_org_audit: an admin records a privilege-change audit row (actor = the caller) ─────────
-- Replaces the direct org_role_audit_log INSERT (SELECT-only for users). is_org_admin authz; the route
-- still calls this fire-and-forget, so it stays best-effort, but now succeeds under RLS.
create or replace function public.rpc_write_org_audit(
  p_org_type text, p_org_id uuid, p_action text,
  p_target_user_id uuid default null, p_old_role text default null, p_new_role text default null)
  returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_org_admin(p_org_type, p_org_id) then raise exception 'admin only'; end if;
  insert into public.org_role_audit_log
    (org_type, org_id, actor_id, target_user_id, action, old_role, new_role)
  values
    (p_org_type, p_org_id, (select public.current_uid()), p_target_user_id, p_action, p_old_role, p_new_role);
end $$;

-- ── rpc_remove_member: admin removes a member; refuses to remove an owner ───────────────────────────
-- (The route keeps the finer "an admin cannot remove another admin" pre-check.)
create or replace function public.rpc_remove_member(p_org_type text, p_org_id uuid, p_target_user uuid)
  returns void language plpgsql security definer set search_path = ''
as $$
declare v_role text;
begin
  if not public.is_org_admin(p_org_type, p_org_id) then raise exception 'admin only'; end if;
  if p_org_type = 'studio' then
    select member_role into v_role from public.studio_members where studio_id = p_org_id and user_id = p_target_user;
    if v_role is null then raise exception 'member not found'; end if;
    if v_role = 'owner' then raise exception 'cannot remove the org owner'; end if;
    delete from public.studio_members where studio_id = p_org_id and user_id = p_target_user;
  elsif p_org_type = 'vendor' then
    select member_role into v_role from public.vendor_members where vendor_id = p_org_id and user_id = p_target_user;
    if v_role is null then raise exception 'member not found'; end if;
    if v_role = 'owner' then raise exception 'cannot remove the org owner'; end if;
    delete from public.vendor_members where vendor_id = p_org_id and user_id = p_target_user;
  else raise exception 'invalid org type'; end if;
end $$;

-- ── rpc_regenerate_invite_code: admin sets a new (caller-generated) invite code; updates ONLY that col ─
create or replace function public.rpc_regenerate_invite_code(p_org_type text, p_org_id uuid, p_code text)
  returns text language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_org_admin(p_org_type, p_org_id) then raise exception 'admin only'; end if;
  if p_code is null or length(trim(p_code)) = 0 then raise exception 'invite code required'; end if;
  if p_org_type = 'studio' then
    update public.studios set invite_code = p_code where id = p_org_id;
  elsif p_org_type = 'vendor' then
    update public.vendors set invite_code = p_code where id = p_org_id;
  else raise exception 'invalid org type'; end if;
  return p_code;
end $$;

-- ── rpc_transfer_ownership: secure ownership transfer (auth.uid() must BE the current owner) ─────────
-- Hardens the legacy transfer_org_ownership: the caller is derived from auth.uid(), never a spoofable
-- arg, so a direct caller cannot transfer someone else's ownership. Atomic owner→admin / target→owner.
create or replace function public.rpc_transfer_ownership(p_org_type text, p_org_id uuid, p_new_owner uuid)
  returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid());
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if v_uid = p_new_owner then raise exception 'already the owner'; end if;
  if p_org_type = 'studio' then
    if not exists (select 1 from public.studio_members
                    where studio_id = p_org_id and user_id = v_uid and member_role = 'owner') then
      raise exception 'only the owner can transfer ownership';
    end if;
    if not exists (select 1 from public.studio_members where studio_id = p_org_id and user_id = p_new_owner) then
      raise exception 'target is not a member';
    end if;
    update public.studio_members set member_role = 'owner' where studio_id = p_org_id and user_id = p_new_owner;
    update public.studio_members set member_role = 'admin' where studio_id = p_org_id and user_id = v_uid;
  elsif p_org_type = 'vendor' then
    if not exists (select 1 from public.vendor_members
                    where vendor_id = p_org_id and user_id = v_uid and member_role = 'owner') then
      raise exception 'only the owner can transfer ownership';
    end if;
    if not exists (select 1 from public.vendor_members where vendor_id = p_org_id and user_id = p_new_owner) then
      raise exception 'target is not a member';
    end if;
    update public.vendor_members set member_role = 'owner' where vendor_id = p_org_id and user_id = p_new_owner;
    update public.vendor_members set member_role = 'admin' where vendor_id = p_org_id and user_id = v_uid;
  else raise exception 'invalid org type'; end if;
end $$;

-- ── Ownership + EXECUTE lockdown for the 4 new RPCs ─────────────────────────────────────────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.rpc_write_org_audit(text, uuid, text, uuid, text, text)',
    'public.rpc_remove_member(text, uuid, uuid)',
    'public.rpc_regenerate_invite_code(text, uuid, text)',
    'public.rpc_transfer_ownership(text, uuid, uuid)'
  ]
  loop
    execute format('alter function %s owner to arthound_rpc', fn);
    execute format('revoke all on function %s from public', fn);
    execute format('revoke execute on function %s from anon, service_role', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- Legacy transfer_org_ownership stays for the flag-off (service-role) path; tighten its grants — no
-- legitimate anon/authenticated direct caller (its writes RLS-deny for them anyway; this is belt+braces).
revoke execute on function public.transfer_org_ownership(text, uuid, uuid, uuid) from anon, authenticated;

revoke create on schema public from arthound_rpc;  -- drop the transient CREATE

commit;

-- ── Post-apply guard (manual/CI) ──────────────────────────────────────────────────────────────────
--   select proname, pg_get_userbyid(proowner) owner, prosecdef from pg_proc
--    where pronamespace='public'::regnamespace
--      and proname in ('rpc_write_org_audit','rpc_remove_member','rpc_regenerate_invite_code','rpc_transfer_ownership');
--   -- expect owner=arthound_rpc, prosecdef=t for all 4; EXECUTE = {authenticated} only.
--   -- Tenancy test: a non-admin caller must get 'admin only'; a non-owner calling rpc_transfer_ownership
--   -- must get 'only the owner can transfer ownership'.
