-- M-01 / Phase 0: org-scope the estimation stack (vendor-estimate-share plan §3.2).
--
-- Generalizes workflow_steps / estimate_config / estimate_matrix from studio-only to
-- (studio | vendor) ownership via a dual nullable FK + num_nonnulls=1 check, with a generated
-- owner_key = coalesce(studio_id, vendor_id) as the single per-owner unique enforcer AND PostgREST
-- on_conflict arbiter (plan §2.1, §2.2). Existing studio rows keep studio_id — backfill is a no-op.
--
-- RLS note (plan §1.7, §2.4, §6.4): the runtime isolation boundary is the route-layer owner filter;
-- routes use the service-role client, which bypasses RLS. The vendor policies added below are
-- DEFENSE-IN-DEPTH only, extending the pre-existing studio-only policies so vendor rows stay visible
-- to any user-JWT reader (keeping the posture consistent). They do not change runtime behaviour.
--
-- Constraint names are discovered via pg_constraint rather than hardcoded (autonames can truncate).
-- No irreversible step: studio_id is retained, only made nullable.

begin;

-- ── estimate_matrix ───────────────────────────────────────────────────────────
alter table estimate_matrix add column if not exists vendor_id uuid references vendors(id);
alter table estimate_matrix alter column studio_id drop not null;
alter table estimate_matrix add constraint em_one_owner
  check (num_nonnulls(studio_id, vendor_id) = 1);
alter table estimate_matrix add column owner_key uuid
  generated always as (coalesce(studio_id, vendor_id)) stored;

-- drop the old single-owner unique (studio_id, workflow_step_id, variable_values), whatever its name
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'estimate_matrix'::regclass and contype = 'u';
  if cname is not null then
    execute format('alter table estimate_matrix drop constraint %I', cname);
  end if;
end $$;

-- owner_key full unique (sole enforcer + arbiter). link_id is added in M-02, which recreates this.
create unique index uq_em_owner on estimate_matrix (owner_key, workflow_step_id, variable_values);

-- ── estimate_config (PK swap — verified no inbound FKs, plan §1.8) ─────────────
alter table estimate_config add column if not exists id uuid not null default gen_random_uuid();
alter table estimate_config add column if not exists vendor_id uuid references vendors(id);

-- drop the PRIMARY KEY (studio_id) before dropping NOT NULL (a PK column cannot drop NOT NULL)
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'estimate_config'::regclass and contype = 'p';
  if cname is not null then
    execute format('alter table estimate_config drop constraint %I', cname);
  end if;
end $$;

alter table estimate_config alter column studio_id drop not null;
alter table estimate_config add constraint estimate_config_pkey primary key (id);
alter table estimate_config add constraint ec_one_owner
  check (num_nonnulls(studio_id, vendor_id) = 1);
alter table estimate_config add column owner_key uuid
  generated always as (coalesce(studio_id, vendor_id)) stored;
create unique index uq_ec_owner on estimate_config (owner_key);

-- ── workflow_steps ─────────────────────────────────────────────────────────────
alter table workflow_steps add column if not exists vendor_id uuid references vendors(id);
alter table workflow_steps alter column studio_id drop not null;
alter table workflow_steps add constraint ws_one_owner
  check (num_nonnulls(studio_id, vendor_id) = 1);
alter table workflow_steps add column owner_key uuid
  generated always as (coalesce(studio_id, vendor_id)) stored;

-- drop the old unique (studio_id, airtable_template_id), whatever its name
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'workflow_steps'::regclass and contype = 'u';
  if cname is not null then
    execute format('alter table workflow_steps drop constraint %I', cname);
  end if;
end $$;

-- NULLS DISTINCT (default): multiple native steps (airtable_template_id IS NULL) coexist per owner.
create unique index uq_ws_owner on workflow_steps (owner_key, airtable_template_id);

-- ── extend the existing studio-only RLS to vendor rows (defense-in-depth, plan §1.7) ──
-- Pre-existing ws_studio / ec_studio / em_studio policies are left in place; permissive policies OR
-- together, so studio users match the studio policy and vendor users match the new vendor policy.
drop policy if exists "ws_vendor" on workflow_steps;
create policy "ws_vendor" on workflow_steps for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid);

drop policy if exists "ec_vendor" on estimate_config;
create policy "ec_vendor" on estimate_config for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid);

drop policy if exists "em_vendor" on estimate_matrix;
create policy "em_vendor" on estimate_matrix for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid);

-- workflow_step_dependencies: replace the studio-only FK-chain policy with an owner-aware one.
drop policy if exists "wsd_studio" on workflow_step_dependencies;
drop policy if exists "wsd_owner"  on workflow_step_dependencies;
create policy "wsd_owner" on workflow_step_dependencies for all using (
  step_id in (
    select id from workflow_steps
    where studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
       or vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
  ));

commit;
