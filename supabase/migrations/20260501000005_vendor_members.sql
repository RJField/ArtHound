-- Vendor membership: mirrors studio_members pattern.
-- Vendor Account -> Add vendor links a Supabase auth user to a vendor row.
create table vendor_members (
  vendor_id  uuid not null references vendors(id),
  user_id    uuid not null,
  created_at timestamptz default now(),
  primary key (vendor_id, user_id)
);

create index on vendor_members(user_id);
