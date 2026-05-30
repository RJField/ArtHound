-- M-03/04/05 + RPC / Phase 2: vendor → studio estimate-share snapshots
-- (vendor-estimate-share plan §3.4–§3.6, §4.4, §6.8).
--
-- A vendor shares a frozen, granularity-controlled projection of their effective matrix with a
-- linked studio. Delivery is the route-scoped inbox (routes use the service-role client; RLS here is
-- defense-in-depth, plan §2.4/§1.7). A series is the per-relationship channel keyed (vendor_id,
-- link_id) — granularity is a per-share property carried in the snapshot, NOT a channel key (R3
-- replace semantics, plan §2.6). At-most-one live dispatch per channel is structural (uq_esd_one_live).

begin;

-- ── estimate_share_series: one channel per (vendor, studio link) ───────────────
create table estimate_share_series (
  id                  uuid primary key default gen_random_uuid(),
  vendor_id           uuid not null references vendors(id),
  link_id             uuid not null references studio_vendor_links(id),
  recipient_studio_id uuid not null references studios(id),  -- denormalized from link for the inbox filter
  label               text,
  created_at          timestamptz not null default now(),
  -- one channel per relationship; granularity is a per-share dispatch property (in the snapshot),
  -- NOT a channel key — replace semantics (plan §2.6).
  unique (vendor_id, link_id)
);
create index on estimate_share_series (recipient_studio_id);

alter table estimate_share_series enable row level security;  -- defense-in-depth (plan §2.4)
create policy "ess_vendor" on estimate_share_series for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid);
create policy "ess_studio_read" on estimate_share_series for select using (
  recipient_studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid);

-- ── estimate_share_dispatches: frozen snapshot, one row per share ──────────────
-- NOTE: deliberately NOT FK'd to canonical_assets. An estimation matrix is a rate card keyed on
-- asset profiles (variable combos), a tier above any individual asset. Intentional, reviewed
-- exception to the canonical-asset linkage rule (plan §2.5).
create table estimate_share_dispatches (
  id                  uuid primary key default gen_random_uuid(),
  series_id           uuid not null references estimate_share_series(id),
  vendor_id           uuid not null references vendors(id),          -- sender (denormalized)
  recipient_studio_id uuid not null references studios(id),          -- denormalized for the inbox filter
  link_id             uuid not null references studio_vendor_links(id),
  snapshot            jsonb not null,                                -- frozen self-describing projection (carries granularity)
  delivery_mode       text not null default 'route_inbox'
                        check (delivery_mode in ('route_inbox')),    -- widen when token strategy lands
  expires_at          timestamptz,                                   -- nullable: open-ended share allowed
  revoked_at          timestamptz,
  superseded_at       timestamptz,                                   -- set on re-share (plan §2.6) / future REFRESH
  created_at          timestamptz not null default now()
);
create index on estimate_share_dispatches (series_id);
create index on estimate_share_dispatches (recipient_studio_id);
create index on estimate_share_dispatches (vendor_id);

-- At-most-one LIVE dispatch per channel — structural, not route-layer (plan §2.6, §6.8).
-- A concurrent double-share makes the losing insert fail this unique. Expiry is intentionally
-- excluded (time-based, not indexable; an expired share is not an accretion duplicate).
create unique index uq_esd_one_live on estimate_share_dispatches (series_id)
  where superseded_at is null and revoked_at is null;

alter table estimate_share_dispatches enable row level security;  -- defense-in-depth (plan §2.4)
create policy "esd_vendor" on estimate_share_dispatches for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid);
create policy "esd_studio_read" on estimate_share_dispatches for select using (
  recipient_studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  and revoked_at is null
  and (expires_at is null or expires_at > now()));

-- ── estimate_share_access_log: append-only audit (mirrors payload_access_log) ──
create table estimate_share_access_log (
  id               uuid primary key default gen_random_uuid(),
  dispatch_id      uuid not null references estimate_share_dispatches(id) on delete cascade,
  event            text not null,   -- 'shared' | 'viewed' | 'revoked' | 'superseded'
  actor_vendor_id  uuid references vendors(id),
  actor_studio_id  uuid references studios(id),
  detail           jsonb,
  created_at       timestamptz not null default now()
);
create index on estimate_share_access_log (dispatch_id);
create index on estimate_share_access_log (created_at desc);

alter table estimate_share_access_log enable row level security;  -- defense-in-depth (plan §2.4)
-- SELECT for both parties via the dispatch FK chain; NO INSERT policy (service-role writes only),
-- mirroring payload_access_log.
create policy "esal_vendor_select" on estimate_share_access_log for select using (
  dispatch_id in (select id from estimate_share_dispatches
                  where vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid));
create policy "esal_studio_select" on estimate_share_access_log for select using (
  dispatch_id in (select id from estimate_share_dispatches
                  where recipient_studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid));

-- ── create_estimate_share: atomic find-or-create series + supersede + insert ───
-- The supersede + insert must be one transaction so there is no transient no-live window; the
-- uq_esd_one_live index is the structural backstop on concurrent double-share (plan §4.4, §6.8).
-- SECURITY INVOKER (default): the route always calls this as the service role (BYPASSRLS), so it can
-- write the access log (which has no INSERT policy) without a SECURITY DEFINER footgun.
create or replace function create_estimate_share(
  p_vendor_id           uuid,
  p_link_id             uuid,
  p_recipient_studio_id uuid,
  p_snapshot            jsonb,
  p_label               text,
  p_expires_at          timestamptz
) returns estimate_share_dispatches
language plpgsql
set search_path = public
as $$
declare
  v_series_id     uuid;
  v_superseded_id uuid;
  v_dispatch      estimate_share_dispatches;
begin
  -- find-or-create the (vendor, link) channel
  insert into estimate_share_series (vendor_id, link_id, recipient_studio_id, label)
  values (p_vendor_id, p_link_id, p_recipient_studio_id, p_label)
  on conflict (vendor_id, link_id)
    do update set label = coalesce(excluded.label, estimate_share_series.label)
  returning id into v_series_id;

  -- supersede the existing live dispatch (at most one, by uq_esd_one_live)
  update estimate_share_dispatches
     set superseded_at = now()
   where series_id = v_series_id and superseded_at is null and revoked_at is null
  returning id into v_superseded_id;

  if v_superseded_id is not null then
    insert into estimate_share_access_log (dispatch_id, event, actor_vendor_id)
    values (v_superseded_id, 'superseded', p_vendor_id);
  end if;

  insert into estimate_share_dispatches
    (series_id, vendor_id, recipient_studio_id, link_id, snapshot, expires_at)
  values
    (v_series_id, p_vendor_id, p_recipient_studio_id, p_link_id, p_snapshot, p_expires_at)
  returning * into v_dispatch;

  insert into estimate_share_access_log (dispatch_id, event, actor_vendor_id)
  values (v_dispatch.id, 'shared', p_vendor_id);

  return v_dispatch;
end;
$$;

commit;
