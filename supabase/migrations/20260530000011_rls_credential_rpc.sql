-- 20260530000011_rls_credential_rpc.sql
-- RLS migration 11 — credential writes under RLS (plan §4a item 7, source_credentials half; Option B).
--
-- source_credentials is Pattern F (no user policy — deny-all to users), but it is written by:
--   * USER-initiated connect/save flows (jira_oauth OAuth callback, init, sync connect) — an org member
--     (admin in the app) saving a source's encrypted credentials.
--   * lib/token_refresh — refreshes a Jira token; runs in BOTH the background poll-sync (system identity)
--     and any user route that needs a fresh token (payload ingest / schedule write-back / attachments).
--
-- TWO write paths, by context:
--   (1) USER-facing writes  → rpc_upsert_credential (this file): SECURITY DEFINER, is_my_org() authz, so
--       a member may write ONLY their own org's credentials. The blob is encrypted in Python; a caller
--       can't forge a valid one, so the worst a member can do is garbage-overwrite their OWN org's creds
--       (self-inflicted, never cross-tenant). Owned by arthound_rpc (bounded blast radius).
--   (2) token_refresh in SYSTEM context → the system role writes source_credentials directly under its
--       sys_all policy (migration 2). The refresh is an UPSERT, which needs INSERT in addition to the
--       UPDATE migration 2 granted — added here. (In USER context token_refresh uses path (1).)
-- current_user/auth.uid() is the authority, never request input — the owner is derived from the authed
-- user by the route. Idempotent.

begin;

-- Ownership-reassignment prerequisites (idempotent; see migration 4).
do $$ begin execute format('grant arthound_rpc to %I with set true, inherit true', current_user); end $$;
grant create on schema public to arthound_rpc;  -- transient; revoked after the ownership block

-- (1) arthound_rpc write access to source_credentials (F-table → needs grant + its own policy under FORCE).
-- SELECT is required too: INSERT ... ON CONFLICT DO UPDATE reads the conflict row, so without SELECT the
-- upsert fails with "permission denied for table" (a GRANT error, not an RLS denial).
grant select, insert, update on public.source_credentials to arthound_rpc;
drop policy if exists rpc_all on public.source_credentials;
create policy rpc_all on public.source_credentials for all to arthound_rpc using (true) with check (true);

-- (2) system role needs INSERT for the token_refresh upsert (had SELECT, UPDATE from migration 2).
grant insert on public.source_credentials to arthound_system;

-- rpc_upsert_credential — user-facing credential write (is_my_org authz).
create or replace function public.rpc_upsert_credential(
  p_owner_type text, p_owner_id uuid, p_source_type text, p_credentials jsonb)
  returns void language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_my_org(p_owner_type, p_owner_id) then
    raise exception 'not a member of this org';
  end if;
  if p_credentials is null then raise exception 'credentials required'; end if;
  insert into public.source_credentials (owner_type, owner_id, source_type, credentials)
  values (p_owner_type, p_owner_id, p_source_type, p_credentials)
  on conflict (owner_type, owner_id, source_type)
    do update set credentials = excluded.credentials, updated_at = now();
end $$;

-- is_my_org EXECUTE for the RPC owner (migration 1 granted it to authenticated only).
grant execute on function public.is_my_org(text, uuid) to arthound_rpc;

-- Ownership + EXECUTE lockdown.
alter function public.rpc_upsert_credential(text, uuid, text, jsonb) owner to arthound_rpc;
revoke all     on function public.rpc_upsert_credential(text, uuid, text, jsonb) from public;
revoke execute on function public.rpc_upsert_credential(text, uuid, text, jsonb) from anon, service_role;
grant  execute on function public.rpc_upsert_credential(text, uuid, text, jsonb) to authenticated;

revoke create on schema public from arthound_rpc;  -- drop the transient CREATE

commit;

-- ── Post-apply test (plan §9) ─────────────────────────────────────────────────────────────────────
--   * a member upserts their OWN org's credential via the RPC → OK.
--   * a member calls the RPC for ANOTHER org_id → 'not a member of this org'.
--   * a direct user INSERT/UPDATE on source_credentials (no RPC) → RLS deny (F-table).
