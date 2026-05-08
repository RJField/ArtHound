-- 20260509000001_p4_debt.sql
-- P4 debt: asset_reviews.created_by_user_id + vendors.initialized_at backfill

begin;


-- ── 1. asset_reviews.created_by_user_id ──────────────────────────────────────
-- Fixes: ar_creator_delete keyed on email — user who changes Supabase email loses
-- delete access to their own reviews. Switch to auth.uid() instead.

alter table asset_reviews
  add column if not exists created_by_user_id uuid
    references auth.users(id) on delete set null;

-- Backfill existing rows where the email still matches a live auth user.
update asset_reviews ar
set created_by_user_id = u.id
from auth.users u
where u.email = ar.created_by_email
  and ar.created_by_user_id is null;

-- Replace ar_creator_delete: primary key is auth.uid(); fall back to email for
-- rows where the auth user was deleted before backfill ran.
drop policy if exists "ar_creator_delete" on asset_reviews;
create policy "ar_creator_delete" on asset_reviews for delete using (
  (
    (author_org_type = 'studio' and studio_id    = (auth.jwt()->'app_metadata'->>'studio_id')::uuid)
    or
    (author_org_type = 'vendor' and author_org_id = (auth.jwt()->'app_metadata'->>'vendor_id')::uuid)
  )
  and (
    created_by_user_id = auth.uid()
    or (created_by_user_id is null and created_by_email = (auth.jwt()->>'email'))
  )
);


-- ── 2. vendors.initialized_at backfill ───────────────────────────────────────
-- Column added retroactively in 20260506000004. Vendors that completed setup
-- before that migration have NULL, causing InitGuard to redirect them to the
-- wizard on every login. Set it for vendors that have source credentials
-- (proof they completed init before the column existed).

update vendors v
set initialized_at = coalesce(
  (
    select min(sc.created_at)
    from source_credentials sc
    where sc.owner_type = 'vendor'
      and sc.owner_id = v.id
  ),
  now()
)
where v.initialized_at is null
  and exists (
    select 1 from source_credentials sc
    where sc.owner_type = 'vendor'
      and sc.owner_id = v.id
  );


commit;
