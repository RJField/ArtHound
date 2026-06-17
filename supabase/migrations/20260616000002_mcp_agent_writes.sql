-- 20260616000002_mcp_agent_writes.sql
-- MCP server — Phase 2: lightweight agent write surfaces (docs/plans/mcp-server.md §3 Phase 2).
--
-- Three ArtHound-native "paper trail" tables an agent writes to via the MCP write tools. None mutate
-- production state — each records agent REASONING for a human to act on, with mandatory actor
-- attribution (actor_type/actor_ref). They are owner-org-scoped under the standard user-path RLS
-- (is_my_org) so the producing org's members see and triage them; arthound_system gets SELECT so the
-- future notification loop can consume them without an RLS regression (same proactive grant the
-- reviews subtree took, 20260612000002 §7).
--
-- Anchoring:
--   • asset_flags, review_requests  → canonical_asset_id NOT NULL (CLAUDE.md: everything links to its
--     canonical asset; the tool aborts rather than write an orphan).
--   • estimate_adjustment_proposals → canonical_asset_id NULLABLE by design: an estimate is a tier
--     ABOVE any single asset (per workflow-step × variable combination), exactly the documented
--     carve-out for estimate_share_dispatches ("rate card is a tier above any asset"). workflow_step_id
--     is the real subject; an optional asset gives context.
--
-- actor_ref is deliberately NOT FK'd to agent_credentials — audit outlives the credential (precedent:
-- review_events actor fields, estimate_share_access_log). Grants to `authenticated` come from Supabase
-- default privileges (as in 20260612000002); RLS policies are the gate.

begin;

-- Shared updated_at touch (status transitions by the producer's UI).
create or replace function public.touch_updated_at()
  returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. asset_flags — agent-raised delivery/quality/dependency risk on a specific asset
-- ════════════════════════════════════════════════════════════════════════════════════════════════
create table public.asset_flags (
  id                 uuid        primary key default gen_random_uuid(),
  owner_type         text        not null check (owner_type in ('studio', 'vendor')),
  owner_id           uuid        not null,
  canonical_asset_id uuid        not null references public.canonical_assets(id) on delete cascade,
  risk_type          text        not null check (risk_type in ('delivery', 'quality', 'dependency', 'other')),
  severity           text        check (severity in ('low', 'medium', 'high')),
  summary            text        not null,
  evidence           jsonb       not null default '{}'::jsonb,
  actor_type         text        not null check (actor_type in ('agent', 'user')),
  actor_ref          uuid,
  status             text        not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index asset_flags_owner_idx on public.asset_flags(owner_type, owner_id, status);
create index asset_flags_asset_idx on public.asset_flags(canonical_asset_id);

create trigger asset_flags_touch before update on public.asset_flags
  for each row execute function public.touch_updated_at();

alter table public.asset_flags enable row level security;
alter table public.asset_flags force  row level security;

create policy af_sel on public.asset_flags for select to authenticated
  using (public.is_my_org(owner_type, owner_id));
create policy af_ins on public.asset_flags for insert to authenticated
  with check (public.is_my_org(owner_type, owner_id));
create policy af_upd on public.asset_flags for update to authenticated
  using (public.is_my_org(owner_type, owner_id)) with check (public.is_my_org(owner_type, owner_id));
create policy af_del on public.asset_flags for delete to authenticated
  using (public.is_my_org(owner_type, owner_id));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. review_requests — agent escalates to a human review on a specific asset
-- ════════════════════════════════════════════════════════════════════════════════════════════════
create table public.review_requests (
  id                 uuid        primary key default gen_random_uuid(),
  owner_type         text        not null check (owner_type in ('studio', 'vendor')),
  owner_id           uuid        not null,
  canonical_asset_id uuid        not null references public.canonical_assets(id) on delete cascade,
  subject            text        not null,
  context            text,
  actor_type         text        not null check (actor_type in ('agent', 'user')),
  actor_ref          uuid,
  status             text        not null default 'open' check (status in ('open', 'addressed')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index review_requests_owner_idx on public.review_requests(owner_type, owner_id, status);
create index review_requests_asset_idx on public.review_requests(canonical_asset_id);

create trigger review_requests_touch before update on public.review_requests
  for each row execute function public.touch_updated_at();

alter table public.review_requests enable row level security;
alter table public.review_requests force  row level security;

create policy rr_sel on public.review_requests for select to authenticated
  using (public.is_my_org(owner_type, owner_id));
create policy rr_ins on public.review_requests for insert to authenticated
  with check (public.is_my_org(owner_type, owner_id));
create policy rr_upd on public.review_requests for update to authenticated
  using (public.is_my_org(owner_type, owner_id)) with check (public.is_my_org(owner_type, owner_id));
create policy rr_del on public.review_requests for delete to authenticated
  using (public.is_my_org(owner_type, owner_id));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. estimate_adjustment_proposals — agent proposes a matrix-cell estimate change (NumberBot pattern,
--    externalized). Tier-above-asset → canonical_asset_id nullable (estimate_share carve-out).
-- ════════════════════════════════════════════════════════════════════════════════════════════════
create table public.estimate_adjustment_proposals (
  id                     uuid        primary key default gen_random_uuid(),
  owner_type             text        not null check (owner_type in ('studio', 'vendor')),
  owner_id               uuid        not null,
  workflow_step_id       uuid        references public.workflow_steps(id) on delete set null,
  canonical_asset_id     uuid        references public.canonical_assets(id) on delete set null,
  current_estimate_days  numeric,
  proposed_estimate_days numeric     not null,
  variable_values        jsonb,
  reasoning              text        not null,
  actor_type             text        not null check (actor_type in ('agent', 'user')),
  actor_ref              uuid,
  status                 text        not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index estimate_adjustment_proposals_owner_idx on public.estimate_adjustment_proposals(owner_type, owner_id, status);

create trigger estimate_adjustment_proposals_touch before update on public.estimate_adjustment_proposals
  for each row execute function public.touch_updated_at();

alter table public.estimate_adjustment_proposals enable row level security;
alter table public.estimate_adjustment_proposals force  row level security;

create policy eap_sel on public.estimate_adjustment_proposals for select to authenticated
  using (public.is_my_org(owner_type, owner_id));
create policy eap_ins on public.estimate_adjustment_proposals for insert to authenticated
  with check (public.is_my_org(owner_type, owner_id));
create policy eap_upd on public.estimate_adjustment_proposals for update to authenticated
  using (public.is_my_org(owner_type, owner_id)) with check (public.is_my_org(owner_type, owner_id));
create policy eap_del on public.estimate_adjustment_proposals for delete to authenticated
  using (public.is_my_org(owner_type, owner_id));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. arthound_system — SELECT + sys_read (future notification loop consumes these; regression-proof)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array['asset_flags', 'review_requests', 'estimate_adjustment_proposals'] loop
    execute format('drop policy if exists sys_read on public.%I', t);
    execute format('create policy sys_read on public.%I for select to arthound_system using (true)', t);
  end loop;
end $$;

grant select on public.asset_flags                    to arthound_system;
grant select on public.review_requests                to arthound_system;
grant select on public.estimate_adjustment_proposals  to arthound_system;

commit;

-- ── Post-apply checks (manual / CI; NOT in the transaction) ───────────────────────────────────────
-- A. All three RLS-enabled + forced + policied (rls_grant_audit.py coverage sweep):
--      select relname, relrowsecurity, relforcerowsecurity from pg_class
--       where relnamespace='public'::regnamespace
--         and relname in ('asset_flags','review_requests','estimate_adjustment_proposals');  -- expect t/t
-- B. rls_persona_matrix.py + rls_grant_audit.py green (audit's expected set self-updates from this file).
