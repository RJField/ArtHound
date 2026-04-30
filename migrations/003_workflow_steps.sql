-- Workflow steps: native ArtHound representation of task template structure.
-- Initially seeded from Airtable templates; later can be authored directly in ArtHound.
create table workflow_steps (
  id                   uuid primary key default gen_random_uuid(),
  studio_id            uuid not null references studios(id),
  name                 text not null,
  craft                text,
  airtable_template_id text,              -- bridge to Airtable source; null for native steps
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  unique(studio_id, airtable_template_id)
);

-- Step ordering / dependency graph (mirrors Airtable "Depended upon" links)
create table workflow_step_dependencies (
  step_id            uuid not null references workflow_steps(id) on delete cascade,
  depends_on_step_id uuid not null references workflow_steps(id) on delete cascade,
  primary key (step_id, depends_on_step_id)
);

-- Per-studio record of which variable fields drive the estimate matrix
create table estimate_config (
  studio_id       uuid primary key references studios(id),o 
  variable_fields text[] not null,   -- sorted alphabetically
  updated_at      timestamptz default now()
);

-- The estimate matrix: one row per (workflow step × variable combination)
create table estimate_matrix (
  id                uuid primary key default gen_random_uuid(),
  studio_id         uuid not null references studios(id),
  workflow_step_id  uuid not null references workflow_steps(id) on delete cascade,
  variable_values   jsonb not null,           -- e.g. {"Item Type":"Axe","Status":"ToDo"}
  estimate_days     numeric(10,2) not null default 0,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  unique(studio_id, workflow_step_id, variable_values)
);

create index on estimate_matrix(studio_id, workflow_step_id);
create index on estimate_matrix using gin(variable_values);
