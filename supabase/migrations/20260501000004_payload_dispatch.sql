-- Payload dispatch: secure asset snapshot exchange between studios.
--
-- Flow: sender builds a template (which fields to expose), dispatches an
-- immutable snapshot against a canonical asset, and receives a one-time
-- plaintext token. Recipients redeem the token to read the self-describing
-- payload and save a field mapping into their own schema.
--
-- Security invariants:
--   - token_hash stores SHA-256(plaintext); plaintext is returned once and never stored.
--   - Payload data is frozen at dispatch time — no live queries against sender's data.
--   - Revocation and expiry are checked on every token redemption.
--   - payload_access_log is append-only; rows are never updated or deleted.

-- ── payload_templates ────────────────────────────────────────────────────────
-- Reusable definitions of which asset fields a studio exposes outbound.
-- field_schema: [{key, label, type}] — must match keys in the asset's metadata.
create table payload_templates (
  id           uuid primary key default gen_random_uuid(),
  studio_id    uuid not null references studios(id),
  name         text not null,
  field_schema jsonb not null default '[]',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index on payload_templates(studio_id);

-- ── payload_dispatches ───────────────────────────────────────────────────────
-- One row per dispatch: an immutable snapshot sent to a recipient.
-- token_hash: SHA-256 hex of the one-time plaintext token; never stored in plain.
-- recipient_vendor_id: null when sent to an external / not-yet-registered recipient.
create table payload_dispatches (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid not null references canonical_assets(id),
  sender_studio_id    uuid not null references studios(id),
  recipient_vendor_id uuid references vendors(id),
  template_id         uuid references payload_templates(id),
  -- frozen snapshot: {asset_global_id, schema:[{key,label,type}], data:{...}, dispatched_at}
  payload_data        jsonb not null,
  token_hash          text unique not null,
  expires_at          timestamptz not null,
  received_at         timestamptz,   -- set on first valid redemption
  revoked_at          timestamptz,   -- sender revokes; blocks all future access immediately
  created_at          timestamptz default now()
);

create index on payload_dispatches(sender_studio_id);
create index on payload_dispatches(recipient_vendor_id);
create index on payload_dispatches(token_hash);
create index on payload_dispatches(expires_at);

-- ── payload_field_mappings ───────────────────────────────────────────────────
-- Recipient's mapping of payload field keys → their own internal field keys.
-- applied_at is null until the recipient commits the import.
create table payload_field_mappings (
  id                  uuid primary key default gen_random_uuid(),
  dispatch_id         uuid not null references payload_dispatches(id) on delete cascade,
  recipient_vendor_id uuid not null references vendors(id),
  -- {payload_field_key: recipient_internal_field_key}
  mappings            jsonb not null default '{}',
  applied_at          timestamptz,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique(dispatch_id, recipient_vendor_id)
);

create index on payload_field_mappings(dispatch_id);

-- ── payload_access_log ───────────────────────────────────────────────────────
-- Append-only audit trail. Never update or delete rows.
-- event: 'dispatched' | 'received' | 'mapped' | 'applied' | 'revoked' | 'denied'
create table payload_access_log (
  id              uuid primary key default gen_random_uuid(),
  dispatch_id     uuid not null references payload_dispatches(id) on delete cascade,
  event           text not null,
  actor_studio_id uuid references studios(id),
  detail          jsonb,
  created_at      timestamptz default now()
);

create index on payload_access_log(dispatch_id);
create index on payload_access_log(created_at desc);
