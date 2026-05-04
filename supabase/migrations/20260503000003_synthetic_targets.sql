-- 20260503000003_synthetic_targets.sql
-- Named Airtable base targets for the admin synthetic data generation feature.
-- Tokens are stored encrypted (same Fernet scheme as source_credentials).
-- p_table/a_table/w_table are nullable — set in the table-mapping step after initial connect.

create table synthetic_targets (
  id            uuid primary key default gen_random_uuid(),
  studio_id     uuid not null references studios(id) on delete cascade,
  name          text not null,
  base_id       text not null,
  token_enc     jsonb not null,
  p_table       text,
  a_table       text,
  w_table       text,
  a_link_field  text,
  w_link_field  text,
  created_at    timestamptz not null default now()
);

create index synthetic_targets_studio_idx on synthetic_targets(studio_id);
