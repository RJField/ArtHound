-- Meta bucket classification system
-- Adds three supporting tables/columns for PAW-anchored field categorisation.
-- The meta JSONB blobs themselves are unchanged; classification lives in
-- source_field_mappings mapping entries (meta_bucket, display_tier,
-- ingest_suppressed) which are JSONB — no column migration required there.

-- ── 1. Override log ───────────────────────────────────────────────────────────
-- Append-only record of every bucket reassignment a studio makes.
-- Used to identify where the auto-classification heuristic is wrong.

create table field_bucket_override_log (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null,
    source_type     text not null,
    paw_level       text not null check (paw_level in ('asset', 'product', 'work', 'item_type')),
    source_field_id text not null,
    field_name      text not null,
    field_type      text,
    from_bucket     text,           -- null = first manual assignment (no prior auto value)
    to_bucket       text not null,
    changed_at      timestamptz not null default now()
);

alter table field_bucket_override_log enable row level security;

-- Studios can read their own override log; writes are service-role only.
create policy "studios read own override log"
    on field_bucket_override_log for select
    using (
        owner_id = (
            select studio_id from studio_members
            where user_id = auth.uid()
            limit 1
        )
    );

create index field_bucket_override_log_owner_idx
    on field_bucket_override_log (owner_id, source_type);


-- ── 2. Schema drift events ────────────────────────────────────────────────────
-- Populated by the daily schema comparison job. One row per detected change.
-- resolved_at is set when the studio reviews and saves updated mappings.

create table schema_drift_events (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null,
    source_type     text not null,
    paw_level       text not null check (paw_level in ('asset', 'product', 'work', 'item_type')),
    signal          text not null check (signal in ('field_added', 'field_removed', 'field_type_changed')),
    source_field_id text not null,
    field_name      text not null,
    old_type        text,
    new_type        text,
    detected_at     timestamptz not null default now(),
    resolved_at     timestamptz
);

alter table schema_drift_events enable row level security;

create policy "studios read own drift events"
    on schema_drift_events for select
    using (
        owner_id = (
            select studio_id from studio_members
            where user_id = auth.uid()
            limit 1
        )
    );

create index schema_drift_events_owner_idx
    on schema_drift_events (owner_id, source_type, resolved_at);


-- ── 3. pending_schema_review flag on source_field_mappings ───────────────────
-- Set to true by the drift job when unresolved field changes are detected.
-- Cleared by PUT /init/field-mappings when the studio saves reviewed mappings.

alter table source_field_mappings
    add column if not exists pending_schema_review boolean not null default false;
