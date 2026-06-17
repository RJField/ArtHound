-- 20260612000002_reviews_p0_foundations.sql
-- Cross-org reviews P0 — foundations + comments (docs/plans/cross-org-reviews.md §7).
--
-- Delivers: scope/link_id/promoted_from_review_id on asset_reviews (drops the dead shared_at stub),
-- review_assets junction (+ backfill), review_comments (lanes), review_events (append-only audit),
-- review_attachments uploaded_by_user_id hardening, and the RLS replacement that closes the live
-- ar_sel over-breadth (a studio could SELECT vendor-authored reviews on its assets — the opposite
-- of the vendor-internal-privacy this feature requires).
--
-- Enforcement model (plan §5): user-context RLS is the primary boundary. Policies are written in
-- their FINAL cross-org shape now — in P0 no cross_org rows exist, so runtime behaviour only
-- TIGHTENS (vendor-authored rows leave the studio's RLS view; routes already filtered them).
-- Cross-org arms become load-bearing in P1 without touching these policies again.
--
-- Child-table visibility intentionally rides the parent: policies use EXISTS against asset_reviews,
-- which is itself RLS-filtered for the caller (authenticated is a non-owner of a FORCE'd table), so
-- "can see the parent review" is the single source of truth and P1's cross-org arm auto-inherits.
--
-- Junction tenancy note: review_assets rows are validated at the route/RPC layer (the review's
-- studio must own the canonical asset). The RLS floor here is owner-org writes on a visible parent;
-- a forged foreign asset id leaks nothing (asset context is always resolved through the caller's own
-- view — replicated_assets or their dispatches — and the foreign org can never see the junction row).

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Link predicates (same hardening contract as 20260530000001: DEFINER, search_path='', authenticated-only)
--    studio_vendor_links is FORCE-exempt (§1a) precisely so these owner-run reads cannot recurse/deny.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- Party to a link in ANY status — cross-org reviews stay readable after link cancellation
-- (plan §2 behavior default 1); is_link_party (active-only) remains the WRITE gate.
create or replace function public.is_link_party_any_status(p_link_id uuid)
  returns boolean
  language sql security definer stable
  set search_path = ''
as $$
  select exists (
    select 1 from public.studio_vendor_links l
     where l.id = p_link_id
       and ( l.studio_id in (select public.current_studio_ids())
          or l.vendor_id in (select public.current_vendor_ids()) )
  )
$$;

-- ACTIVE link, caller is a party, AND the link's studio matches — the INSERT integrity gate for
-- cross-org reviews (a vendor cannot pin a review for studio B onto their link with studio A).
create or replace function public.is_link_party_for_studio(p_link_id uuid, p_studio_id uuid)
  returns boolean
  language sql security definer stable
  set search_path = ''
as $$
  select exists (
    select 1 from public.studio_vendor_links l
     where l.id = p_link_id and l.status = 'active' and l.studio_id = p_studio_id
       and ( l.studio_id in (select public.current_studio_ids())
          or l.vendor_id in (select public.current_vendor_ids()) )
  )
$$;

revoke all on function public.is_link_party_any_status(uuid)        from public;
revoke all on function public.is_link_party_for_studio(uuid, uuid)  from public;
revoke execute on function
  public.is_link_party_any_status(uuid), public.is_link_party_for_studio(uuid, uuid)
  from anon, service_role;
grant execute on function public.is_link_party_any_status(uuid)       to authenticated;
grant execute on function public.is_link_party_for_studio(uuid, uuid) to authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. asset_reviews — container columns
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.asset_reviews
  add column scope                   text not null default 'internal'
    check (scope in ('internal', 'cross_org')),
  add column link_id                 uuid references public.studio_vendor_links(id),
  add column promoted_from_review_id uuid references public.asset_reviews(id) on delete set null;

alter table public.asset_reviews
  add constraint asset_reviews_scope_link_check
    check ((scope = 'internal' and link_id is null) or (scope = 'cross_org' and link_id is not null));

alter table public.asset_reviews drop column if exists shared_at;

create index asset_reviews_link_id_idx on public.asset_reviews(link_id) where link_id is not null;

-- Identity/provenance columns are immutable after insert (UPDATE policies can't compare OLD/NEW).
create or replace function public.asset_review_guard()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if new.scope                   is distinct from old.scope
     or new.link_id                 is distinct from old.link_id
     or new.promoted_from_review_id is distinct from old.promoted_from_review_id
     or new.canonical_asset_id      is distinct from old.canonical_asset_id
     or new.studio_id               is distinct from old.studio_id
     or new.author_org_type         is distinct from old.author_org_type
     or new.author_org_id           is distinct from old.author_org_id
     or new.created_by_user_id      is distinct from old.created_by_user_id
     or new.created_by_email        is distinct from old.created_by_email
     or new.created_at              is distinct from old.created_at then
    raise exception 'immutable asset_reviews columns cannot be changed';
  end if;
  return new;
end
$$;

drop trigger if exists asset_review_guard on public.asset_reviews;
create trigger asset_review_guard
  before update on public.asset_reviews
  for each row execute function public.asset_review_guard();

-- ── RLS replacement (closes the ar_sel over-breadth) ──────────────────────────────────────────────
drop policy if exists ar_sel on public.asset_reviews;
drop policy if exists ar_ins on public.asset_reviews;
drop policy if exists ar_upd on public.asset_reviews;
drop policy if exists ar_del on public.asset_reviews;

-- Default-private: your org's reviews, plus cross-org reviews on a link you are party to (any link
-- status — delivered records do not vanish on cancellation). Studios NO LONGER blanket-see
-- vendor-authored reviews on their assets.
create policy ar_sel on public.asset_reviews for select to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
      or (scope = 'cross_org' and public.is_link_party_any_status(link_id)));

-- Authoring: own org; cross-org additionally requires an ACTIVE link the author is party to whose
-- studio matches the review's studio (write-block on cancelled links, no link/studio mismatch).
create policy ar_ins on public.asset_reviews for insert to authenticated
  with check (public.is_my_org(author_org_type, author_org_id)
          and (scope = 'internal' or public.is_link_party_for_studio(link_id, studio_id)));

-- Owner-org edits only (partner status transitions arrive as a DEFINER RPC in P1).
create policy ar_upd on public.asset_reviews for update to authenticated
  using (public.is_my_org(author_org_type, author_org_id))
  with check (public.is_my_org(author_org_type, author_org_id));

create policy ar_del on public.asset_reviews for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and created_by_user_id = (select auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. review_assets — m2m junction (canonical_asset_id stays the NOT NULL primary anchor, mirrored here)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create table public.review_assets (
  review_id          uuid not null references public.asset_reviews(id)    on delete cascade,
  canonical_asset_id uuid not null references public.canonical_assets(id) on delete cascade,
  created_at         timestamptz not null default now(),
  primary key (review_id, canonical_asset_id)
);

create index review_assets_canonical_asset_id_idx on public.review_assets(canonical_asset_id);

insert into public.review_assets (review_id, canonical_asset_id)
select id, canonical_asset_id from public.asset_reviews
on conflict do nothing;

alter table public.review_assets enable row level security;
alter table public.review_assets force row level security;

create policy ras_sel on public.review_assets for select to authenticated
  using (exists (select 1 from public.asset_reviews r where r.id = review_assets.review_id));
create policy ras_ins on public.review_assets for insert to authenticated
  with check (exists (select 1 from public.asset_reviews r
                       where r.id = review_assets.review_id
                         and public.is_my_org(r.author_org_type, r.author_org_id)));
create policy ras_del on public.review_assets for delete to authenticated
  using (exists (select 1 from public.asset_reviews r
                  where r.id = review_assets.review_id
                    and public.is_my_org(r.author_org_type, r.author_org_id)));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. review_comments — threaded comments with visibility lanes
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create table public.review_comments (
  id                      uuid        primary key default gen_random_uuid(),
  review_id               uuid        not null references public.asset_reviews(id) on delete cascade,
  author_org_type         text        not null check (author_org_type in ('studio', 'vendor')),
  author_org_id           uuid        not null,
  author_user_id          uuid        not null,
  author_email            text,
  body                    text        not null,
  visibility              text        not null default 'internal'
                                      check (visibility in ('internal', 'shared')),
  shared_at               timestamptz,
  copied_from_comment_id  uuid        references public.review_comments(id) on delete set null,
  edited_at               timestamptz,
  created_at              timestamptz not null default now()
);

create index review_comments_review_id_idx on public.review_comments(review_id, created_at);

-- One-way lane flip (internal→shared only, stamps shared_at), edited_at on body change,
-- author/provenance columns immutable.
create or replace function public.review_comment_guard()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.visibility = 'shared' and new.visibility = 'internal' then
    raise exception 'comment visibility cannot revert from shared to internal';
  end if;
  if new.review_id          is distinct from old.review_id
     or new.author_org_type is distinct from old.author_org_type
     or new.author_org_id   is distinct from old.author_org_id
     or new.author_user_id  is distinct from old.author_user_id
     or new.copied_from_comment_id is distinct from old.copied_from_comment_id
     or new.created_at      is distinct from old.created_at then
    raise exception 'immutable review_comments columns cannot be changed';
  end if;
  if old.visibility = 'internal' and new.visibility = 'shared' and new.shared_at is null then
    new.shared_at := now();
  end if;
  if new.body is distinct from old.body then
    new.edited_at := now();
  end if;
  return new;
end
$$;

drop trigger if exists review_comment_guard on public.review_comments;
create trigger review_comment_guard
  before update on public.review_comments
  for each row execute function public.review_comment_guard();

alter table public.review_comments enable row level security;
alter table public.review_comments force row level security;

-- Read: your org's comments, or shared-lane comments on a review you can see (EXISTS rides the
-- parent's RLS — inert in P0 where only the owner org sees the parent; load-bearing in P1).
create policy rc_sel on public.review_comments for select to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
      or (visibility = 'shared'
          and exists (select 1 from public.asset_reviews r where r.id = review_comments.review_id)));

-- Write: as yourself, on a review you can see; internal-scope reviews accept only the internal
-- lane; cross-org comments additionally require the link to still be ACTIVE (write-block on
-- cancelled links — reads stay open, writes do not).
create policy rc_ins on public.review_comments for insert to authenticated
  with check (public.is_my_org(author_org_type, author_org_id)
          and author_user_id = (select auth.uid())
          and exists (select 1 from public.asset_reviews r
                       where r.id = review_comments.review_id
                         and (r.scope = 'internal' or public.is_link_party(r.link_id))
                         and (review_comments.visibility = 'internal' or r.scope = 'cross_org')));

create policy rc_upd on public.review_comments for update to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and author_user_id = (select auth.uid()))
  with check (public.is_my_org(author_org_type, author_org_id)
          and author_user_id = (select auth.uid()));

create policy rc_del on public.review_comments for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and author_user_id = (select auth.uid()));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. review_events — append-only audit (link_cancellation_audit shape: SELECT only, no INSERT policy
--    for authenticated; writes go through arthound_system — routes wrap the event write in
--    system_identity(), background/RPC paths are system/DEFINER already)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create table public.review_events (
  id              uuid        primary key default gen_random_uuid(),
  review_id       uuid        not null references public.asset_reviews(id) on delete cascade,
  subject_type    text        not null check (subject_type in
                                ('review', 'comment', 'attachment', 'asset_link', 'requirement')),
  subject_id      uuid,
  event_type      text        not null check (event_type in
                                ('created', 'updated', 'status_changed', 'deleted',
                                 'comment_added', 'comment_shared', 'promoted', 'attachment_added',
                                 'requirement_tagged', 'accepted', 'revision_created')),
  actor_user_id   uuid,
  actor_org_type  text        check (actor_org_type in ('studio', 'vendor')),
  actor_org_id    uuid,
  detail          jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index review_events_review_id_idx on public.review_events(review_id, created_at);

alter table public.review_events enable row level security;
alter table public.review_events force row level security;

-- Visible wherever the parent review is visible; immutable from the user path (no INSERT/UPDATE/DELETE).
create policy rev_sel on public.review_events for select to authenticated
  using (exists (select 1 from public.asset_reviews r where r.id = review_events.review_id));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. review_attachments — visibility rides the parent + uploaded_by_user_id hardening
--    (rat_sel had the same studio-side over-breadth as ar_sel; DELETE keyed on a spoof-resistant
--    user id for new rows, email fallback only for legacy rows that predate the column)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.review_attachments add column uploaded_by_user_id uuid;

update public.review_attachments ra
   set uploaded_by_user_id = u.id
  from auth.users u
 where u.email = ra.uploaded_by
   and ra.uploaded_by_user_id is null;

drop policy if exists rat_sel on public.review_attachments;
drop policy if exists rat_ins on public.review_attachments;
drop policy if exists rat_del on public.review_attachments;

create policy rat_sel on public.review_attachments for select to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
      or exists (select 1 from public.asset_reviews r where r.id = review_attachments.review_id));
create policy rat_ins on public.review_attachments for insert to authenticated
  with check (public.is_my_org(author_org_type, author_org_id)
          and exists (select 1 from public.asset_reviews r
                       where r.id = review_attachments.review_id
                         and (r.scope = 'internal' or public.is_link_party(r.link_id))));
create policy rat_del on public.review_attachments for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and (uploaded_by_user_id = (select auth.uid())
          or (uploaded_by_user_id is null and uploaded_by = (select auth.jwt() ->> 'email'))));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. arthound_system — least-privilege grants + policies (20260530000002 conventions).
--    SELECT up front on the review subtree so the future notification loop cannot hit RLS
--    regression class #6/#7; INSERT on review_events is the system event-writer path.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array['asset_reviews', 'review_assets', 'review_comments'] loop
    execute format('drop policy if exists sys_read on public.%I', t);
    execute format('create policy sys_read on public.%I for select to arthound_system using (true)', t);
  end loop;
end $$;

drop policy if exists sys_all on public.review_events;
create policy sys_all on public.review_events for all to arthound_system using (true) with check (true);

grant select         on public.asset_reviews   to arthound_system;
grant select         on public.review_assets   to arthound_system;
grant select         on public.review_comments to arthound_system;
grant select, insert on public.review_events   to arthound_system;

commit;

-- ── Post-apply checks (run manually / in CI; NOT part of the transaction) ─────────────────────────
-- A. New tables are RLS-enabled AND forced (audit check 3 / rls_grant_audit.py):
--      select relname, relrowsecurity, relforcerowsecurity from pg_class
--       where relnamespace = 'public'::regnamespace
--         and relname in ('review_assets','review_comments','review_events');
--      -- expect t/t on all three.
-- B. The over-breadth fix: as a studio member whose studio has vendor-authored reviews on its assets,
--      select count(*) from asset_reviews where author_org_type = 'vendor';
--      -- expect 0 under a studio JWT (was >0 before this migration).
-- C. rls_persona_matrix.py + rls_grant_audit.py both green (the audit's expected set self-updates
--    from this file's grant lines).
