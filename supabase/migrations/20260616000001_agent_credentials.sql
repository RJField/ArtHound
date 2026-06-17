-- 20260616000001_agent_credentials.sql
-- MCP server — Phase 0: agent identity (docs/plans/mcp-server.md §0/§3, identity model A1).
--
-- A1 in one line: an external MCP agent acts on behalf of an org as a dedicated, non-admin
-- "service-account" MEMBER, authenticated at the MCP boundary by an API key. The server resolves
-- the key to that member's principal uuid, mints a short-lived authenticated JWT for it (reusing the
-- system ES256 signer in lib/system_auth.py — Supabase's JWKS already trusts that key), and binds it
-- as the request identity. From there EVERY existing RLS policy applies UNCHANGED: the agent sees
-- exactly what current_studio_ids()/current_vendor_ids() resolve for its principal. No new Postgres
-- role, no new per-table policies, no app_metadata dependency (migration 1 dissolved that). Writes
-- record actor_type='agent' / actor_ref=agent_credentials.id.
--
-- This migration ships ONLY the identity substrate (the credential store + the principal role value +
-- the access log). The MCP transport and tools land in later phases; nothing here changes existing
-- runtime behaviour until lib/agent_auth.py + the /mcp surface are wired up.
--
-- Why a member row at all: the RLS predicate functions resolve tenancy from studio_members /
-- vendor_members keyed on auth.uid() (= the JWT sub). So an agent principal MUST be a member row for
-- RLS to scope it — that is the whole mechanism of A1. The principal_user_id is a synthetic uuid; it is
-- deliberately NOT a GoTrue auth.users account (studio_members.user_id has no FK to auth.users, and
-- auth.uid() reads the sub claim without an existence check). The agent never logs in via GoTrue —
-- tokens are minted directly for it — so it needs no email/password. member_role='agent' keeps it a
-- NON-admin (is_org_admin checks 'owner'/'admin' only) and tags it so the human member roster can
-- filter it out (UI follow-up, Phase 1).
--
-- Containment posture mirrors the RLS migration: RLS ENABLED + FORCE'd on both new tables, a single
-- per-table sys_all policy, least-privilege GRANTs to arthound_system (the runtime reads/updates these
-- under system_identity(), before any agent identity exists), and an explicit REVOKE from anon +
-- authenticated so a leaked policy can never expose key hashes to a user/agent token. Issuance is an
-- offline service-role CLI (scripts/agent_keys.py), which bypasses RLS — so arthound_system needs no
-- INSERT on agent_credentials. The grant/coverage guards (scripts/rls_grant_audit.py) validate the
-- new grants + RLS posture automatically from this file; no guard edit required.

begin;

-- ── Allow the 'agent' principal role on the membership tables ─────────────────────────────────────
-- Additive widening of the existing CHECK (was IN ('owner','admin','user')). 'agent' is strictly LESS
-- privileged than 'user' for our purposes: it is excluded from is_org_admin() and marks "not a human
-- seat". The original CHECK was created inline by ADD COLUMN, so its name is the Postgres default
-- (<table>_member_role_check) — but rather than trust that, drop EVERY check constraint on the column
-- by catalog (bulletproof + idempotent), then add the widened one under a known name.
do $$
declare
  tbl  text;
  cons text;
begin
  foreach tbl in array array['studio_members', 'vendor_members'] loop
    for cons in
      select c.conname
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace n on n.oid = t.relnamespace
       where n.nspname = 'public' and t.relname = tbl and c.contype = 'c'
         and pg_get_constraintdef(c.oid) ilike '%member_role%'
    loop
      execute format('alter table public.%I drop constraint %I', tbl, cons);
    end loop;
    execute format(
      'alter table public.%I add constraint %I check (member_role in (''owner'',''admin'',''user'',''agent''))',
      tbl, tbl || '_member_role_check');
  end loop;
end $$;

-- ── agent_credentials: API key → org-scoped principal ─────────────────────────────────────────────
create table if not exists public.agent_credentials (
  id                uuid        not null default gen_random_uuid() primary key,
  owner_type        text        not null check (owner_type in ('studio', 'vendor')),
  owner_id          uuid        not null,                      -- the org this agent acts for
  principal_user_id uuid        not null,                      -- = auth.uid() the minted token carries; a
                                                               --   studio_members/vendor_members.user_id
  key_hash          text        not null unique,               -- sha256(raw key) hex; raw key is NEVER stored
  label             text        not null,                      -- human label ("LoreBot prod", "vendor X agent")
  scopes            jsonb       not null default '{"mode":"read","tools":["*"]}'::jsonb,
                                                               -- APP-LAYER enforcement (read|write, tool allowlist);
                                                               --   RLS gives org-scoping, scopes narrow within it
  created_at        timestamptz not null default now(),
  created_by        uuid,                                      -- human who issued it (CLI: nullable)
  expires_at        timestamptz,                               -- null = no expiry
  revoked_at        timestamptz,                               -- non-null = dead; resolve refuses it
  last_used_at      timestamptz
);

-- Auth hot path: look up a live credential by key hash.
create unique index if not exists agent_credentials_key_hash_idx
  on public.agent_credentials (key_hash);
-- "which agents does org X have?" + active-only filtering.
create index if not exists agent_credentials_owner_idx
  on public.agent_credentials (owner_type, owner_id);
create index if not exists agent_credentials_active_idx
  on public.agent_credentials (owner_type, owner_id)
  where revoked_at is null;

-- ── agent_access_log: append-only audit of the agent identity lifecycle ───────────────────────────
create table if not exists public.agent_access_log (
  id                  uuid        not null default gen_random_uuid() primary key,
  agent_credential_id uuid        not null,                    -- deliberately NOT FK'd: audit outlives the
                                                               --   credential (precedent: estimate_share_access_log)
  owner_type          text        not null,
  owner_id            uuid        not null,
  event               text        not null
                        check (event in ('issued','authenticated','revoked','tool_call','denied','expired')),
  tool                text,                                    -- set for tool_call / denied
  detail              jsonb,
  occurred_at         timestamptz not null default now()
);

create index if not exists agent_access_log_cred_idx
  on public.agent_access_log (agent_credential_id, occurred_at desc);
create index if not exists agent_access_log_owner_idx
  on public.agent_access_log (owner_type, owner_id, occurred_at desc);

-- ── RLS: system-only at the DB layer; users/agents get NOTHING here ───────────────────────────────
alter table public.agent_credentials force row level security;
alter table public.agent_credentials enable  row level security;
alter table public.agent_access_log  force row level security;
alter table public.agent_access_log  enable  row level security;

-- One uniform system policy per table (the GRANT below is the real op-level containment).
drop policy if exists sys_all on public.agent_credentials;
create policy sys_all on public.agent_credentials
  for all to arthound_system using (true) with check (true);

drop policy if exists sys_all on public.agent_access_log;
create policy sys_all on public.agent_access_log
  for all to arthound_system using (true) with check (true);

-- Runtime (system_identity()) reads a credential to establish identity and stamps last_used_at;
-- it appends to the access log. It never CREATES credentials (that is the service-role CLI).
grant select, update on public.agent_credentials to arthound_system;
grant select, insert on public.agent_access_log  to arthound_system;

-- Key hashes + the principal map are secrets: no anon/authenticated reach, policy or not.
revoke all on public.agent_credentials from anon, authenticated;
revoke all on public.agent_access_log  from anon, authenticated;

commit;

-- ── Post-apply guards (run manually / in CI; NOT in the transaction) ──────────────────────────────
-- A. scripts/rls_grant_audit.py picks up the two new grants from this file automatically and asserts
--    the live DB received them + both tables are RLS-enabled, FORCE'd, and policied. Run it green.
-- B. member_role widening took: expect 'agent' present in both check constraints —
--      select conrelid::regclass, pg_get_constraintdef(oid)
--        from pg_constraint where conname in
--        ('studio_members_member_role_check','vendor_members_member_role_check');
-- C. No user reach: as an authenticated JWT, a read of agent_credentials returns ZERO rows (deny-all);
--    as an arthound_system token it returns rows. (scripts/test_agent_scoping.py covers this.)
