-- Studio↔vendor handshake layer.
-- Adds: vendors.handle, studio_vendor_invites, studio_vendor_links,
--       vendor_studio_ingest_templates, link_cancellation_audit,
--       link_cancellation_dispatches.
--
-- Invite model: direct handle lookup in-system (no email required).
-- Payload snapshot: taken at acceptance time from studio's current template.
-- Template: survives link cancellation (keyed on vendor+studio pair, not link).
-- Cancellation: immediately revokes all outstanding dispatches; writes audit trail.


-- ── vendors.handle ────────────────────────────────────────────────────────────
-- Globally readable for search; immutable post-set (admin-only change path).
-- Nullable so existing vendors aren't broken; required before they appear in search.

alter table vendors add column if not exists handle text unique;

create index if not exists vendors_handle_lower_idx on vendors (lower(handle));


-- ── studio_vendor_invites ─────────────────────────────────────────────────────
-- One pending invite per studio+vendor pair at a time (partial unique index).
-- No payload snapshot on the invite — studio's live template is fetched at preview/accept.

create table studio_vendor_invites (
  id         uuid primary key default gen_random_uuid(),
  studio_id  uuid not null references studios(id),
  vendor_id  uuid not null references vendors(id),
  review_collaboration_mode text not null default 'none'
    check (review_collaboration_mode in ('none', 'isolated', 'collaborative')),
  status     text not null default 'pending'
    check (status in ('pending', 'accepted', 'expired', 'cancelled')),
  resend_count int not null default 0,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- One pending invite per pair; cancelled/accepted/expired rows accumulate for audit
create unique index studio_vendor_invites_pending_unique
  on studio_vendor_invites (studio_id, vendor_id)
  where status = 'pending';

create index on studio_vendor_invites (vendor_id, status);

alter table studio_vendor_invites enable row level security;

-- Studio sees all their sent invites
create policy "svi_studio" on studio_vendor_invites for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
-- Vendor sees invites addressed to them (select only — accept/reject via API)
create policy "svi_vendor_select" on studio_vendor_invites for select using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);


-- ── studio_vendor_links ───────────────────────────────────────────────────────
-- Active relationships. One active link per studio+vendor pair at a time.
-- Cancelled rows stay for audit; re-invite creates a new row.
-- payload_format_snapshot: studio's current template at moment of acceptance.

create table studio_vendor_links (
  id         uuid primary key default gen_random_uuid(),
  studio_id  uuid not null references studios(id),
  vendor_id  uuid not null references vendors(id),
  invite_id  uuid not null references studio_vendor_invites(id),
  status     text not null default 'active'
    check (status in ('active', 'cancelled_by_studio', 'cancelled_by_vendor')),
  payload_format_snapshot      jsonb,
  review_collaboration_mode    text not null default 'none'
    check (review_collaboration_mode in ('none', 'isolated', 'collaborative')),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One active link per pair; cancelled rows accumulate
create unique index studio_vendor_links_active_unique
  on studio_vendor_links (studio_id, vendor_id)
  where status = 'active';

create index on studio_vendor_links (vendor_id, status);

alter table studio_vendor_links enable row level security;

create policy "svl_studio" on studio_vendor_links for all using (
  studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
);
create policy "svl_vendor" on studio_vendor_links for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);


-- ── vendor_studio_ingest_templates ───────────────────────────────────────────
-- Vendor's saved default field mapping for payloads from a specific studio.
-- Keyed on vendor+studio pair (not link) so it survives cancellation/re-invite.
-- link_id is updated to the current link on first ingest under a new link.

create table vendor_studio_ingest_templates (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id),
  studio_id   uuid not null references studios(id),
  link_id     uuid not null references studio_vendor_links(id),
  field_mappings      jsonb not null default '{}',
  meta_summary_config jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (vendor_id, studio_id)
);

alter table vendor_studio_ingest_templates enable row level security;

-- Vendor can read/write their own templates; studios have no access
create policy "vsit_vendor" on vendor_studio_ingest_templates for all using (
  vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
);


-- ── link_cancellation_audit ───────────────────────────────────────────────────
-- Written by the cancel endpoint. dispatch_count is denormalized for quick display.
-- Readable by both parties of the cancelled link.

create table link_cancellation_audit (
  id             uuid primary key default gen_random_uuid(),
  link_id        uuid not null references studio_vendor_links(id),
  cancelled_by   uuid not null references auth.users(id),
  dispatch_count int not null default 0,
  revoked_at     timestamptz not null default now()
);

alter table link_cancellation_audit enable row level security;

create policy "lca_studio" on link_cancellation_audit for select using (
  link_id in (
    select id from studio_vendor_links
    where studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  )
);
create policy "lca_vendor" on link_cancellation_audit for select using (
  link_id in (
    select id from studio_vendor_links
    where vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
  )
);


-- ── link_cancellation_dispatches ─────────────────────────────────────────────
-- Join table: one row per dispatch revoked by a link cancellation.
-- Avoids uuid[] array on audit; enables indexed lookup + future per-dispatch recovery state.

create table link_cancellation_dispatches (
  link_cancellation_id uuid not null references link_cancellation_audit(id),
  dispatch_id          uuid not null references payload_dispatches(id),
  primary key (link_cancellation_id, dispatch_id)
);

create index on link_cancellation_dispatches (dispatch_id);

alter table link_cancellation_dispatches enable row level security;

create policy "lcd_studio" on link_cancellation_dispatches for select using (
  link_cancellation_id in (
    select lca.id from link_cancellation_audit lca
    join studio_vendor_links svl on svl.id = lca.link_id
    where svl.studio_id = (auth.jwt()->'app_metadata'->>'studio_id')::uuid
  )
);
create policy "lcd_vendor" on link_cancellation_dispatches for select using (
  link_cancellation_id in (
    select lca.id from link_cancellation_audit lca
    join studio_vendor_links svl on svl.id = lca.link_id
    where svl.vendor_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid
  )
);
