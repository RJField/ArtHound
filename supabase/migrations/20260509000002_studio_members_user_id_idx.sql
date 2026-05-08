-- Auth query is WHERE user_id=$1 — suffix scan on the (studio_id, user_id) PK.
-- vendor_members already has this index; studio never got it.
-- Fires on every authenticated studio request on cache miss (60s TTL).
create index if not exists studio_members_user_id_idx on studio_members (user_id);
