-- 20260530000004_rls_rpcs.sql
-- RLS migration 4 of N — cross-tenant + bootstrap RPCs (plan §6, sequencing §8 step 4).
--
-- Under user-RLS, the membership / cross-org / sync-owned tables have NO user write policy (§3), so the
-- writes those flows need are funnelled through audited SECURITY DEFINER functions whose in-function
-- authz check is the real guard. This file is ADDITIVE and backward-compatible: until the app cutover
-- (§8 step 5) routes still call these via the service-role key, which works unchanged. After cutover the
-- routes call them with the user JWT (auth.uid() = the caller).
--
-- OWNER-ROLE MODEL (plan §6 Option A): every function is owned by `arthound_rpc` (a NON-owner of the
-- tables, created in migration 1). FORCE RLS — applied in a LATER migration — only affects a table's
-- owner, so arthound_rpc stays subject to RLS and is bounded by an explicit per-table policy + GRANT on
-- EXACTLY the tables each RPC writes. Even if an in-fn authz check were bypassed, the role cannot touch a
-- table outside that set. The cross-org rows legitimately belong to "the other org", so the arthound_rpc
-- policies are `using(true)` SCOPED PER TABLE (never a blanket grant) — and the in-fn authz is therefore
-- load-bearing and must be covered by the §9 tenancy tests.
--
-- Hardening on every function: SECURITY DEFINER, SET search_path = '' (all names schema-qualified),
-- REVOKE EXECUTE FROM public, GRANT EXECUTE TO authenticated. One transaction per call — any
-- RAISE EXCEPTION rolls back all writes. Mutating cross-org RPCs lock the link/dispatch row (FOR UPDATE)
-- and re-check inside the lock (TOCTOU).
--
-- DELIBERATELY NOT in this file:
--   * Review-subtree RPCs (rpc_grant_review_access, rpc_accept_review_delivery — plan §6 #12/#13):
--     they reference review/review_grant/review_event which don't exist yet. Gated behind the
--     cross-org-reviews FEATURE migration (plan §2 Pattern E gate).
--   * FORCE ROW LEVEL SECURITY (its own later migration; must EXCLUDE studio_members / vendor_members /
--     studio_vendor_links per §1a).
--
-- Schema facts verified against live dev 2026-05-29 (plan §6 "schema accuracy"):
--   * payload_export_records cols: (dispatch_id, vendor_id, vendor_source_type, vendor_tool_record_id,
--     canonical_asset_id); ONLY unique constraint is (dispatch_id, vendor_id).
--   * replicated_assets ingest-stub conflict key: (owner_type, owner_id, source_type, source_record_id).
--   * payload_access_log has actor_studio_id ONLY (no actor_vendor_id) — a vendor-actor event writes
--     actor_studio_id=NULL and carries the vendor id in `detail` jsonb.
--   * estimate_share_access_log DOES have both actor_vendor_id and actor_studio_id.
--   * studio_vendor_invites has invite_code; studios/vendors have invite_code (join-by-code).
--   * membership tables have NO surrogate id — PK is (org_id, user_id).
--
-- Structural carve-outs these RPCs do NOT cover (stay service-role in the route — plan §0c):
--   * create-org sets app_metadata via the GoTrue Admin API (not a table) — route keeps that call.
--   * ingest creates the external Airtable/Jira record in Python before calling rpc_ingest_payload.
--   * freeze computes the matrix projection in Python (project_effective_matrix) and passes the snapshot.

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Let the migration-running role reassign function ownership to arthound_rpc (the ALTER FUNCTION ...
-- OWNER TO block at the end). PG16+ split role membership into separate ADMIN / INHERIT / SET
-- privileges: `CREATE ROLE arthound_rpc` in migration 1 auto-granted the creator (postgres) ADMIN but
-- NOT SET, so postgres can administer the role yet cannot `SET ROLE` to it — and ALTER ... OWNER TO a
-- role requires the ability to SET ROLE to that role ("must be able to SET ROLE arthound_rpc", 42501).
-- postgres holds admin_option on arthound_rpc, so it can grant itself the SET option. Dynamic on
-- current_user so this is correct whoever runs the migration (postgres on dev + prod). Idempotent.
do $$ begin execute format('grant arthound_rpc to %I with set true, inherit true', current_user); end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Schema access for the RPC owner. The functions run AS arthound_rpc (SECURITY DEFINER), so the role
-- needs USAGE on schema public to reach any public.* object or function — without this every RPC fails
-- at runtime. (Migration 1 created the role but granted no schema usage.)
-- CREATE on schema public is granted TRANSIENTLY: ALTER FUNCTION ... OWNER TO arthound_rpc (at the end
-- of this file) requires the NEW owner to hold CREATE on the object's schema. arthound_rpc needs no
-- CREATE at runtime (its definer bodies only read/write granted tables), so it is REVOKED again right
-- after the ownership block, keeping the role least-privilege.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
grant usage on schema public to arthound_rpc;
grant create on schema public to arthound_rpc;  -- transient; revoked after the ownership block below

-- Many RPC bodies need the caller's auth uid. They are SECURITY DEFINER owned by arthound_rpc, which —
-- unlike postgres — CANNOT call auth.uid() directly: auth.uid() requires USAGE on schema auth, the auth
-- schema is owned by supabase_admin, and postgres (the migration runner) cannot GRANT that usage to
-- arthound_rpc (the GRANT silently WARNs and no-ops — verified: auth_usage stays false). The portable
-- fix is a wrapper: public.current_uid() is a postgres-owned SECURITY DEFINER fn (postgres DOES have
-- auth access — it is how the §1 predicate fns reach auth.uid()) that the arthound_rpc RPCs call
-- instead. resolve_my_membership is called by get_current_user on EVERY authenticated request, so
-- without this every login would 403 at cutover.
-- Its body is `select auth.uid()` WITHOUT the (select …) wrapper the RPC bodies use, so the
-- replace-auth.uid()-with-current_uid() rewrite below does not touch it (no self-recursion). It stays
-- postgres-owned: it is deliberately NOT in the ownership-reassignment array at the end of this file.
create or replace function public.current_uid()
  returns uuid language sql security definer stable set search_path = ''
as $$ select auth.uid() $$;
revoke all on function public.current_uid() from public;
revoke execute on function public.current_uid() from anon, service_role;
grant execute on function public.current_uid() to authenticated, arthound_rpc;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Predicate EXECUTE for the RPC owner (in-fn authz needs these; migration 1 granted them to
-- `authenticated` only). NOT is_my_org/perm_at_least unless used below.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
grant execute on function public.current_studio_ids()      to arthound_rpc;
grant execute on function public.current_vendor_ids()      to arthound_rpc;
grant execute on function public.is_org_admin(text, uuid)  to arthound_rpc;
grant execute on function public.is_link_party(uuid)       to arthound_rpc;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- arthound_rpc table GRANTs + per-table policies (EXACTLY the write set; using(true) scoped per table)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'studios','vendors','studio_members','vendor_members',
    'studio_join_requests','vendor_join_requests',
    'studio_vendor_links','studio_vendor_invites',
    'payload_dispatches','link_cancellation_audit','link_cancellation_dispatches',
    'payload_export_records','replicated_assets','payload_field_mappings','payload_access_log',
    'failed_ingests',
    'estimate_share_series','estimate_share_dispatches','estimate_share_access_log'
  ]
  loop
    execute format('drop policy if exists rpc_all on public.%I', t);
    execute format('create policy rpc_all on public.%I for all to arthound_rpc using (true) with check (true)', t);
  end loop;
end $$;

-- payload_templates is the one READ-ONLY cross-org table: rpc_accept_link_invite reads the studio's
-- templates to snapshot them onto the new link, but arthound_rpc never writes it (studios own it via
-- pt_all). It needs a SELECT policy because migration 5 FORCEs this table and arthound_rpc is a
-- non-owner (RLS requires policy + grant; the grant below is SELECT-only). Kept OUT of the rpc_all
-- write-set loop so "rpc_all = write set" stays true; this is the documented read exception.
drop policy if exists rpc_sel on public.payload_templates;
create policy rpc_sel on public.payload_templates for select to arthound_rpc using (true);

-- SELECT needs for in-fn reads that aren't writes (resolve_my_membership / lookups). DEFINER predicates
-- read membership as postgres, but the RPC bodies also read these tables directly as arthound_rpc.
grant select                 on public.studio_members            to arthound_rpc;
grant select                 on public.vendor_members            to arthound_rpc;
grant select                 on public.studios                   to arthound_rpc;
grant select                 on public.vendors                   to arthound_rpc;
grant select                 on public.studio_join_requests      to arthound_rpc;
grant select                 on public.vendor_join_requests      to arthound_rpc;
grant select                 on public.payload_templates         to arthound_rpc;  -- accept_invite snapshot read
grant select                 on public.studio_vendor_invites     to arthound_rpc;
grant select                 on public.studio_vendor_links       to arthound_rpc;
grant select                 on public.payload_dispatches        to arthound_rpc;
grant select                 on public.payload_field_mappings    to arthound_rpc;
grant select                 on public.failed_ingests            to arthound_rpc;
grant select                 on public.estimate_share_series     to arthound_rpc;
grant select                 on public.estimate_share_dispatches to arthound_rpc;
-- Writes
grant insert                 on public.studios                   to arthound_rpc;
grant insert                 on public.vendors                   to arthound_rpc;
grant insert, update         on public.studio_members            to arthound_rpc;
grant insert, update         on public.vendor_members            to arthound_rpc;
grant insert, update         on public.studio_join_requests      to arthound_rpc;
grant insert, update         on public.vendor_join_requests      to arthound_rpc;
grant insert, update         on public.studio_vendor_links       to arthound_rpc;
grant update                 on public.studio_vendor_invites     to arthound_rpc;
grant update                 on public.payload_dispatches        to arthound_rpc;
grant insert                 on public.link_cancellation_audit   to arthound_rpc;
grant insert                 on public.link_cancellation_dispatches to arthound_rpc;
grant insert                 on public.payload_export_records    to arthound_rpc;
grant insert                 on public.replicated_assets         to arthound_rpc;
grant update                 on public.payload_field_mappings    to arthound_rpc;
grant insert                 on public.payload_access_log        to arthound_rpc;
grant insert, update         on public.failed_ingests            to arthound_rpc;
grant insert, update         on public.estimate_share_series     to arthound_rpc;
grant insert, update         on public.estimate_share_dispatches to arthound_rpc;
grant insert                 on public.estimate_share_access_log to arthound_rpc;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- BOOTSTRAP RPCs (the #1 fix — without these the app cannot onboard or even authenticate under RLS)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- resolve_my_membership: the call get_current_user makes INSTEAD of a raw studio_members SELECT
-- (which under RLS would need the membership policy / recurse). Returns the caller's org + role.
create or replace function public.resolve_my_membership()
  returns table (studio_id uuid, vendor_id uuid, member_role text)
  language sql security definer stable set search_path = ''
as $$
  select sm.studio_id, null::uuid, sm.member_role
    from public.studio_members sm where sm.user_id = (select public.current_uid())
  union all
  select null::uuid, vm.vendor_id, vm.member_role
    from public.vendor_members vm where vm.user_id = (select public.current_uid())
  limit 1
$$;

-- create org + founding owner membership, atomically. Authz: authenticated + no existing membership.
-- NOTE: the route still sets app_metadata via the GoTrue Admin API after this returns (§0c carve-out);
-- this RPC does ONLY the two table inserts.
create or replace function public.rpc_create_studio_with_owner(p_name text)
  returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid()); v_org uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if exists (select 1 from public.studio_members where user_id = v_uid)
     or exists (select 1 from public.vendor_members where user_id = v_uid) then
    raise exception 'already a member of an org';
  end if;
  insert into public.studios (name) values (p_name) returning id into v_org;
  insert into public.studio_members (studio_id, user_id, member_role) values (v_org, v_uid, 'owner');
  return v_org;
end $$;

create or replace function public.rpc_create_vendor_with_owner(p_name text, p_handle text)
  returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid()); v_org uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_handle is null or length(trim(p_handle)) = 0 then raise exception 'vendor handle required'; end if;
  if exists (select 1 from public.studio_members where user_id = v_uid)
     or exists (select 1 from public.vendor_members where user_id = v_uid) then
    raise exception 'already a member of an org';
  end if;
  insert into public.vendors (name, handle) values (p_name, p_handle) returning id into v_org;
  insert into public.vendor_members (vendor_id, user_id, member_role) values (v_org, v_uid, 'owner');
  return v_org;
end $$;

-- request_join: resolve an org by invite_code (a pre-membership read the caller can't do directly) and
-- insert a pending join request for the caller. Authz: a valid invite code. Idempotent.
create or replace function public.rpc_request_join(p_invite_code text)
  returns text language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid()); v_org uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select id into v_org from public.studios where invite_code = p_invite_code;
  if v_org is not null then
    insert into public.studio_join_requests (studio_id, user_id, status)
    values (v_org, v_uid, 'pending')
    on conflict (studio_id, user_id) do nothing;
    return 'studio';
  end if;

  select id into v_org from public.vendors where invite_code = p_invite_code;
  if v_org is not null then
    insert into public.vendor_join_requests (vendor_id, user_id, status)
    values (v_org, v_uid, 'pending')
    on conflict (vendor_id, user_id) do nothing;
    return 'vendor';
  end if;

  raise exception 'invalid invite code';
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- MEMBERSHIP ADMIN RPCs (membership tables are user-unwritable under §3 → all changes via RPC)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- approve/reject a join request. Authz derives the org FROM the request row (not a caller param) then
-- requires is_org_admin on it (plan §6 finding). On approve, inserts the requester's membership.
create or replace function public.rpc_decide_join_request(p_org_type text, p_request_id uuid, p_decision text)
  returns void language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid()); v_org uuid; v_target uuid; v_status text;
begin
  if p_decision not in ('approve','reject') then raise exception 'invalid decision'; end if;

  if p_org_type = 'studio' then
    select studio_id, user_id, status into v_org, v_target, v_status
      from public.studio_join_requests where id = p_request_id for update;
  elsif p_org_type = 'vendor' then
    select vendor_id, user_id, status into v_org, v_target, v_status
      from public.vendor_join_requests where id = p_request_id for update;
  else
    raise exception 'invalid org type';
  end if;

  if v_org is null then raise exception 'request not found'; end if;
  if not public.is_org_admin(p_org_type, v_org) then raise exception 'admin only'; end if;
  if v_status <> 'pending' then raise exception 'request already decided'; end if;

  if p_decision = 'approve' then
    if p_org_type = 'studio' then
      insert into public.studio_members (studio_id, user_id, member_role)
      values (v_org, v_target, 'user') on conflict do nothing;
      update public.studio_join_requests
         set status='accepted', resolved_at=now(), resolved_by=v_uid where id=p_request_id;
    else
      insert into public.vendor_members (vendor_id, user_id, member_role)
      values (v_org, v_target, 'user') on conflict do nothing;
      update public.vendor_join_requests
         set status='accepted', resolved_at=now(), resolved_by=v_uid where id=p_request_id;
    end if;
  else
    -- status must be 'declined' (the *_join_requests_status_check CHECK allows only
    -- pending/accepted/declined — 'rejected' violates it). Matches the legacy route's value.
    if p_org_type = 'studio' then
      update public.studio_join_requests
         set status='declined', resolved_at=now(), resolved_by=v_uid where id=p_request_id;
    else
      update public.vendor_join_requests
         set status='declined', resolved_at=now(), resolved_by=v_uid where id=p_request_id;
    end if;
  end if;
end $$;

-- change a member's role. Authz: caller is admin of the NAMED org (org_id is explicit, not derived by
-- a limit-1 hack — multi-org-safe, plan finding H2). Refuses 'owner' (transfer is a separate flow).
create or replace function public.rpc_update_member_role(p_org_type text, p_org_id uuid, p_target_user uuid, p_role text)
  returns void language plpgsql security definer set search_path = ''
as $$
begin
  if p_role not in ('admin','user') then raise exception 'invalid role'; end if;
  if not public.is_org_admin(p_org_type, p_org_id) then raise exception 'admin only'; end if;
  if p_org_type = 'studio' then
    update public.studio_members set member_role = p_role
      where studio_id = p_org_id and user_id = p_target_user;
  elsif p_org_type = 'vendor' then
    update public.vendor_members set member_role = p_role
      where vendor_id = p_org_id and user_id = p_target_user;
  else
    raise exception 'invalid org type';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- CROSS-ORG RPCs
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- accept a studio↔vendor invite. Authz: the caller is the invite's vendor (membership-derived),
-- invite pending + unexpired. Snapshots the studio's payload_templates onto the new link.
-- Takes p_invite_id (the table has NO invite_code column — verified live; the route's accept flow keys
-- on the invite id scoped by vendor, routes/handshake.py:accept_invite). Snapshot shape matches the
-- route exactly: {"templates": [{id,name,field_schema}, ...]} (NOT whole rows).
-- MUST NOT: create a link for any vendor other than the caller; touch another studio's data beyond the
-- one invite's payload_templates.
create or replace function public.rpc_accept_link_invite(p_invite_id uuid)
  returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_inv record; v_link uuid; v_templates jsonb; v_now timestamptz := now();
begin
  select * into v_inv from public.studio_vendor_invites where id = p_invite_id for update;
  if v_inv is null then raise exception 'invite not found'; end if;
  if v_inv.vendor_id not in (select public.current_vendor_ids()) then
    raise exception 'invite is for a different vendor';
  end if;
  if v_inv.status <> 'pending' then raise exception 'invite is no longer pending'; end if;
  if v_inv.expires_at is not null and v_now > v_inv.expires_at then raise exception 'invite expired'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', pt.id, 'name', pt.name, 'field_schema', pt.field_schema)
                            order by pt.name), '[]'::jsonb)
    into v_templates
    from public.payload_templates pt where pt.studio_id = v_inv.studio_id;

  insert into public.studio_vendor_links
    (studio_id, vendor_id, invite_id, status, review_collaboration_mode, payload_format_snapshot)
  values
    (v_inv.studio_id, v_inv.vendor_id, v_inv.id, 'active',
     coalesce(v_inv.review_collaboration_mode, 'none'),
     jsonb_build_object('templates', v_templates))
  returning id into v_link;

  update public.studio_vendor_invites
     set status='accepted', accepted_at=v_now where id = v_inv.id;
  return v_link;
end $$;

-- cancel a link (either party). Authz: is_link_party. Revokes all live dispatches for the pair, writes
-- the cancellation audit + per-dispatch rows, marks the link cancelled. (Review-grant cascade-revoke is
-- added with the review subtree — plan §6 #4.)
create or replace function public.rpc_cancel_link(p_link_id uuid, p_reason text default null)
  returns integer language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid()); v_link record; v_by text; v_audit uuid;
        v_now timestamptz := now(); v_ids uuid[];
begin
  select * into v_link from public.studio_vendor_links where id = p_link_id for update;
  if v_link is null then raise exception 'link not found'; end if;
  if not public.is_link_party(p_link_id) then raise exception 'not a party to this link'; end if;

  if v_link.studio_id in (select public.current_studio_ids()) then v_by := 'studio';
  elsif v_link.vendor_id in (select public.current_vendor_ids()) then v_by := 'vendor';
  else raise exception 'not a party to this link'; end if;

  select array_agg(id) into v_ids from public.payload_dispatches
   where sender_studio_id = v_link.studio_id
     and recipient_vendor_id = v_link.vendor_id
     and revoked_at is null;
  v_ids := coalesce(v_ids, array[]::uuid[]);

  -- cancelled_by is a uuid (the acting user), NOT the 'studio'/'vendor' role text (v_by) — that text is
  -- only for the studio_vendor_links.status label below. Writing v_by here throws 22P02 on the uuid cast.
  insert into public.link_cancellation_audit (link_id, cancelled_by, dispatch_count)
  values (p_link_id, v_uid, array_length(v_ids, 1)) returning id into v_audit;

  if array_length(v_ids, 1) is not null then
    update public.payload_dispatches set revoked_at = v_now where id = any(v_ids);
    insert into public.link_cancellation_dispatches (link_cancellation_id, dispatch_id)
      select v_audit, unnest(v_ids);
  end if;

  update public.studio_vendor_links
     set status = 'cancelled_by_' || v_by, cancelled_at = v_now, cancelled_by = v_uid
   where id = p_link_id;
  return coalesce(array_length(v_ids, 1), 0);
end $$;

-- record the DB side of a payload ingest (the external Airtable/Jira record is created in Python first;
-- its id/source_type are passed in). Authz: caller is the dispatch's recipient vendor; not revoked/
-- expired; not already ingested. Writes the canonical link (export record + vendor-owned replicated
-- stub), marks the mapping ingested, logs. MUST NOT touch another vendor's rows or the studio's
-- canonical asset (only references dispatch.asset_id).
-- DROP first: the return type changed void→text (PG forbids that via CREATE OR REPLACE). No-op on a
-- fresh DB; on dev it drops the prior void version. Recreated as postgres then reassigned to arthound_rpc.
drop function if exists public.rpc_ingest_payload(uuid, text, text);
create or replace function public.rpc_ingest_payload(p_dispatch_id uuid, p_source_record_id text, p_source_type text)
  returns text language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid()); v_d record; v_now timestamptz := now(); v_reason text;
begin
  select * into v_d from public.payload_dispatches where id = p_dispatch_id for update;
  if v_d is null then raise exception 'dispatch not found'; end if;
  if v_d.recipient_vendor_id not in (select public.current_vendor_ids()) then
    raise exception 'not the recipient vendor';
  end if;
  if v_d.revoked_at is not null then raise exception 'dispatch revoked'; end if;
  if v_d.expires_at is not null and v_now > v_d.expires_at then raise exception 'dispatch expired'; end if;

  -- The external Airtable/Jira record already exists by the time this is called, so the canonical-link
  -- writes are wrapped: a transient failure QUARANTINES to failed_ingests for /retry-canonical instead
  -- of orphaning the external record. Authz above stays hard-RAISE (a revoked/expired dispatch is not
  -- retryable). Returns 'ok' on success, or 'quarantined' (link recorded for retry). Replaces the legacy
  -- route's _write_canonical_link backoff + failed_ingests quarantine, which a user can't do under RLS.
  begin
    insert into public.payload_export_records
      (dispatch_id, vendor_id, vendor_source_type, vendor_tool_record_id, canonical_asset_id)
    values
      (p_dispatch_id, v_d.recipient_vendor_id, p_source_type, p_source_record_id, v_d.asset_id)
    on conflict (dispatch_id, vendor_id) do nothing;

    insert into public.replicated_assets
      (owner_type, owner_id, source_type, source_record_id, canonical_asset_id, origin, meta)
    values
      ('vendor', v_d.recipient_vendor_id, p_source_type, p_source_record_id, v_d.asset_id, 'ingest', '{}'::jsonb)
    on conflict (owner_type, owner_id, source_type, source_record_id) do nothing;

    update public.payload_field_mappings
       set ingested_at = v_now, ingested_source_record_id = p_source_record_id, ingested_by_user_id = v_uid,
           failed_at = null, failure_reason = null
     where dispatch_id = p_dispatch_id and recipient_vendor_id = v_d.recipient_vendor_id;

    -- payload_access_log has no actor_vendor_id; carry the vendor id in detail (schema-accuracy note).
    insert into public.payload_access_log (dispatch_id, event, detail)
    values (p_dispatch_id, 'ingested',
            jsonb_build_object('source_record_id', p_source_record_id, 'actor_vendor_id', v_d.recipient_vendor_id));
    return 'ok';
  exception when others then
    -- the implicit savepoint rolled back the link writes above; record the quarantine (commits w/ the fn).
    v_reason := 'canonical link failed: ' || sqlerrm;
    update public.payload_field_mappings
       set ingested_source_record_id = p_source_record_id, ingested_by_user_id = v_uid,
           failed_at = v_now, failure_reason = v_reason
     where dispatch_id = p_dispatch_id and recipient_vendor_id = v_d.recipient_vendor_id;
    insert into public.failed_ingests
      (dispatch_id, vendor_id, source_type, source_record_id, canonical_asset_id, export_ok, replicated_ok)
    values
      (p_dispatch_id, v_d.recipient_vendor_id, p_source_type, p_source_record_id, v_d.asset_id, false, false)
    on conflict do nothing;
    insert into public.payload_access_log (dispatch_id, event, detail)
    values (p_dispatch_id, 'ingest_canonical_failed',
            jsonb_build_object('source_record_id', p_source_record_id, 'reason', v_reason,
                               'actor_vendor_id', v_d.recipient_vendor_id));
    return 'quarantined';
  end;
end $$;

-- idempotent re-attempt of the canonical link from a quarantined failed_ingests row. Same authz.
-- Returns the source_record_id on success (the route includes it in the response). RAISEs on failure,
-- which rolls back and leaves the failed_ingests row unresolved → still retryable.
-- DROP first: return type changed void→text (see rpc_ingest_payload note).
drop function if exists public.rpc_retry_canonical_link(uuid);
create or replace function public.rpc_retry_canonical_link(p_dispatch_id uuid)
  returns text language plpgsql security definer set search_path = ''
as $$
declare v_uid uuid := (select public.current_uid()); v_fi record; v_d record; v_now timestamptz := now();
begin
  select * into v_d from public.payload_dispatches where id = p_dispatch_id;
  if v_d is null then raise exception 'dispatch not found'; end if;
  if v_d.recipient_vendor_id not in (select public.current_vendor_ids()) then
    raise exception 'not the recipient vendor';
  end if;

  select * into v_fi from public.failed_ingests
   where dispatch_id = p_dispatch_id and vendor_id = v_d.recipient_vendor_id for update;
  if v_fi is null then raise exception 'no failed ingest for this dispatch'; end if;
  if v_fi.resolved_at is not null then raise exception 'already resolved'; end if;

  insert into public.payload_export_records
    (dispatch_id, vendor_id, vendor_source_type, vendor_tool_record_id, canonical_asset_id)
  values
    (p_dispatch_id, v_fi.vendor_id, v_fi.source_type, v_fi.source_record_id, v_fi.canonical_asset_id)
  on conflict (dispatch_id, vendor_id) do nothing;

  insert into public.replicated_assets
    (owner_type, owner_id, source_type, source_record_id, canonical_asset_id, origin, meta)
  values
    ('vendor', v_fi.vendor_id, v_fi.source_type, v_fi.source_record_id, v_fi.canonical_asset_id, 'ingest', '{}'::jsonb)
  on conflict (owner_type, owner_id, source_type, source_record_id) do nothing;

  update public.payload_field_mappings
     set ingested_at = v_now, ingested_source_record_id = v_fi.source_record_id, ingested_by_user_id = v_uid,
         failed_at = null, failure_reason = null
   where dispatch_id = p_dispatch_id and recipient_vendor_id = v_fi.vendor_id;

  update public.failed_ingests
     set resolved_at = v_now, export_ok = true, replicated_ok = true
   where id = v_fi.id;

  return v_fi.source_record_id;
end $$;

-- freeze a vendor→studio estimate share. Supersedes the existing live dispatch + inserts the new one +
-- logs, atomically (the snapshot is computed in Python and passed in). Authz: caller owns the ACTIVE
-- link; recipient studio derived from the link — NEVER a caller arg (plan §6 #5). Supersedes the
-- legacy SECURITY INVOKER create_estimate_share (left in place for transition; drop post-cutover).
create or replace function public.rpc_freeze_estimate_share(
  p_link_id uuid, p_snapshot jsonb, p_label text default null, p_expires_at timestamptz default null)
  returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_link record; v_series uuid; v_superseded uuid; v_dispatch uuid;
begin
  select * into v_link from public.studio_vendor_links where id = p_link_id and status = 'active' for update;
  if v_link is null then raise exception 'active link not found'; end if;
  if v_link.vendor_id not in (select public.current_vendor_ids()) then
    raise exception 'not the link vendor';
  end if;

  insert into public.estimate_share_series (vendor_id, link_id, recipient_studio_id, label)
  values (v_link.vendor_id, p_link_id, v_link.studio_id, p_label)
  on conflict (vendor_id, link_id)
    do update set label = coalesce(excluded.label, public.estimate_share_series.label)
  returning id into v_series;

  update public.estimate_share_dispatches
     set superseded_at = now()
   where series_id = v_series and superseded_at is null and revoked_at is null
  returning id into v_superseded;

  if v_superseded is not null then
    insert into public.estimate_share_access_log (dispatch_id, event, actor_vendor_id)
    values (v_superseded, 'superseded', v_link.vendor_id);
  end if;

  insert into public.estimate_share_dispatches
    (series_id, vendor_id, recipient_studio_id, link_id, snapshot, expires_at)
  values (v_series, v_link.vendor_id, v_link.studio_id, p_link_id, p_snapshot, p_expires_at)
  returning id into v_dispatch;

  insert into public.estimate_share_access_log (dispatch_id, event, actor_vendor_id)
  values (v_dispatch, 'shared', v_link.vendor_id);
  return v_dispatch;
end $$;

-- revoke a live share. Authz: caller is the dispatch's vendor.
create or replace function public.rpc_revoke_estimate_share(p_dispatch_id uuid)
  returns void language plpgsql security definer set search_path = ''
as $$
declare v_d record;
begin
  select * into v_d from public.estimate_share_dispatches where id = p_dispatch_id for update;
  if v_d is null then raise exception 'dispatch not found'; end if;
  if v_d.vendor_id not in (select public.current_vendor_ids()) then raise exception 'not the vendor'; end if;
  if v_d.revoked_at is not null then raise exception 'already revoked'; end if;

  update public.estimate_share_dispatches set revoked_at = now() where id = p_dispatch_id;
  insert into public.estimate_share_access_log (dispatch_id, event, actor_vendor_id)
  values (p_dispatch_id, 'revoked', v_d.vendor_id);
end $$;

-- recipient studio logs that it viewed a share. Authz: caller is the recipient studio. Append-only.
create or replace function public.rpc_log_estimate_share_view(p_dispatch_id uuid)
  returns void language plpgsql security definer set search_path = ''
as $$
declare v_d record;
begin
  select * into v_d from public.estimate_share_dispatches where id = p_dispatch_id;
  if v_d is null then raise exception 'dispatch not found'; end if;
  if v_d.recipient_studio_id not in (select public.current_studio_ids()) then
    raise exception 'not the recipient studio';
  end if;
  insert into public.estimate_share_access_log (dispatch_id, event, actor_studio_id)
  values (p_dispatch_id, 'viewed', v_d.recipient_studio_id);
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Ownership + EXECUTE: own all RPCs by arthound_rpc (non-table-owner → bounded by its policies under
-- FORCE), lock down EXECUTE to authenticated.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.resolve_my_membership()',
    'public.rpc_create_studio_with_owner(text)',
    'public.rpc_create_vendor_with_owner(text, text)',
    'public.rpc_request_join(text)',
    'public.rpc_decide_join_request(text, uuid, text)',
    'public.rpc_update_member_role(text, uuid, uuid, text)',
    'public.rpc_accept_link_invite(uuid)',
    'public.rpc_cancel_link(uuid, text)',
    'public.rpc_ingest_payload(uuid, text, text)',
    'public.rpc_retry_canonical_link(uuid)',
    'public.rpc_freeze_estimate_share(uuid, jsonb, text, timestamptz)',
    'public.rpc_revoke_estimate_share(uuid)',
    'public.rpc_log_estimate_share_view(uuid)'
  ]
  loop
    execute format('alter function %s owner to arthound_rpc', fn);
    execute format('revoke all on function %s from public', fn);
    -- Supabase default privileges also grant EXECUTE to anon + service_role explicitly (not via PUBLIC),
    -- so `revoke ... from public` misses them. Strip both: these are SECURITY DEFINER cross-org WRITE
    -- RPCs and must be reachable by `authenticated` only (the in-fn authz already rejects anon, but
    -- least-privilege + the §9 anon-deny-all contract require the EXECUTE bit gone too). arthound_rpc
    -- (owner) retains EXECUTE implicitly.
    execute format('revoke execute on function %s from anon, service_role', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

-- Ownership reassignment done — drop the transient CREATE so arthound_rpc keeps only USAGE on public.
revoke create on schema public from arthound_rpc;

commit;

-- ── Post-apply guard (run manually / in CI; NOT in the transaction) ───────────────────────────────
-- 1. Every rpc_* / resolve_my_membership is owned by arthound_rpc, prosecdef=true, search_path='':
--      select proname, pg_get_userbyid(proowner) as owner, prosecdef,
--             (select array_agg(c) from unnest(proconfig) c where c like 'search_path=%') as sp
--        from pg_proc where pronamespace='public'::regnamespace
--         and (proname like 'rpc\_%' or proname='resolve_my_membership') order by proname;
-- 2. arthound_rpc holds grants ONLY on the write-set tables above (no drift) — same shape of audit as
--    the system-role scope guard in migration 2.
-- 3. TENANCY TESTS (plan §9) must exercise each cross-org RPC as a NON-party caller and assert it raises
--    (the in-fn authz is the load-bearing guard given the using(true) arthound_rpc policies).
--
-- ── Follow-ups for the §4 code cutover (NOT this migration) ───────────────────────────────────────
--   * Route flip + _user_headers must ship in the SAME deploy as each RPC call (auth.uid()=NULL under
--     service-role → every is_* check false → 42501).
--   * create-org route keeps its GoTrue Admin app_metadata PUT (service-role carve-out, §0c).
--   * payload_field_mappings ingest-RESULT columns (ingested_at, ingested_source_record_id, failed_at,
--     failure_reason) must be made non-vendor-writable (column grant / BEFORE UPDATE trigger) so the
--     vendor's pfm_vendor policy can't spoof ingest state outside rpc_ingest_payload (plan §3 flag).
--   * drop the legacy SECURITY INVOKER create_estimate_share once the route calls rpc_freeze_estimate_share.
