-- Run this in the Supabase SQL editor after 001_canonical_layer.sql

create table studio_members (
  studio_id  uuid not null references studios(id),
  user_id    uuid not null,
  created_at timestamptz default now(),
  primary key (studio_id, user_id)
);

-- Seed your own membership (replace the user_id with your Supabase Auth UID):
-- insert into studio_members (studio_id, user_id)
-- select id, '<your-supabase-user-id>' from studios limit 1;
