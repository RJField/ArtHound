-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)

create table studios (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  airtable_base_id text unique,
  created_at       timestamptz default now()
);

create table vendors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz default now()
);

create table canonical_assets (
  id                 uuid primary key default gen_random_uuid(),
  studio_id          uuid not null references studios(id),
  airtable_record_id text not null,
  created_at         timestamptz default now(),
  unique(studio_id, airtable_record_id)
);

create index on canonical_assets(airtable_record_id);
