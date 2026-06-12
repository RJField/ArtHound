-- 20260612000005_reviews_p3_acceptance.sql
-- Cross-org reviews P3 — formal delivery acceptance (docs/plans/cross-org-reviews.md §7, final phase).
--
-- Delivers:
--   * accepted_at / accepted_by_user_id / frozen_snapshot / revision_of_review_id on asset_reviews
--   * review_accept DEFINER RPC — ACID: validate (studio party, active link, earlier protocol steps
--     fulfilled for the asset) → assemble frozen_snapshot (review + studio-side asset data +
--     SHARED-lane comments only + attachment refs by storage_path, no byte copy) → stamp
--     accepted_at/by, status 'Approved' → 'accepted' event. The snapshot column is visible to BOTH
--     link parties via ar_sel, so it must never contain internal-lane comments.
--   * Immutability: once accepted, the review subtree is frozen — trigger guard blocks ALL updates,
--     and the user policies (ar_upd/ar_del, rc_*, rat_*) additionally require the parent to be
--     unaccepted, so neither owner nor partner can edit/delete/append after sign-off.
--   * Revision chain: promote_review auto-links a re-promotion to the latest prior cross-org copy
--     of the same internal review on the same link (revision_of_review_id + 'revision_created'
--     event). Ad-hoc revisions pass revision_of_review_id at insert (route-validated).

begin;

-- Replacing functions OWNED BY arthound_rpc (promote_review, review_set_status) requires the
-- migration runner to be a member of that role — grant up front so a fresh-DB replay can't hit the
-- sections below without it (idempotent; re-asserted in §7 for the ALTER OWNER block).
do $$ begin execute format('grant arthound_rpc to %I with set true, inherit true', current_user); end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.asset_reviews
  add column revision_of_review_id uuid references public.asset_reviews(id) on delete set null,
  add column accepted_at           timestamptz,
  add column accepted_by_user_id   uuid,
  add column frozen_snapshot       jsonb;

create index asset_reviews_revision_of_idx on public.asset_reviews(revision_of_review_id)
  where revision_of_review_id is not null;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Guard trigger — accepted reviews are fully immutable; revision_of joins the immutable set.
--    The acceptance transition itself (old.accepted_at IS NULL → set) passes; everything after
--    raises, regardless of role (covers rpc_all/sys paths too — review_set_status included).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.asset_review_guard()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if old.accepted_at is not null then
    raise exception 'accepted reviews are immutable';
  end if;
  if new.scope                   is distinct from old.scope
     or new.link_id                 is distinct from old.link_id
     or new.promoted_from_review_id is distinct from old.promoted_from_review_id
     or new.revision_of_review_id   is distinct from old.revision_of_review_id
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. User-policy freeze — the unaccepted-parent condition on every write path. Acceptance fields
--    can never be set from the user path (WITH CHECK accepted_at IS NULL); only review_accept does.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

drop policy if exists ar_upd on public.asset_reviews;
create policy ar_upd on public.asset_reviews for update to authenticated
  using (public.is_my_org(author_org_type, author_org_id) and accepted_at is null)
  with check (public.is_my_org(author_org_type, author_org_id) and accepted_at is null);

drop policy if exists ar_del on public.asset_reviews;
create policy ar_del on public.asset_reviews for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and created_by_user_id = (select auth.uid())
     and accepted_at is null);

drop policy if exists rc_ins on public.review_comments;
create policy rc_ins on public.review_comments for insert to authenticated
  with check (public.is_my_org(author_org_type, author_org_id)
          and author_user_id = (select auth.uid())
          and exists (select 1 from public.asset_reviews r
                       where r.id = review_comments.review_id
                         and r.accepted_at is null
                         and (r.scope = 'internal' or public.is_link_party(r.link_id))
                         and (review_comments.visibility = 'internal' or r.scope = 'cross_org')));

drop policy if exists rc_upd on public.review_comments;
create policy rc_upd on public.review_comments for update to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and author_user_id = (select auth.uid())
     and exists (select 1 from public.asset_reviews r
                  where r.id = review_comments.review_id and r.accepted_at is null))
  with check (public.is_my_org(author_org_type, author_org_id)
          and author_user_id = (select auth.uid()));

drop policy if exists rc_del on public.review_comments;
create policy rc_del on public.review_comments for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and author_user_id = (select auth.uid())
     and exists (select 1 from public.asset_reviews r
                  where r.id = review_comments.review_id and r.accepted_at is null));

drop policy if exists rat_ins on public.review_attachments;
create policy rat_ins on public.review_attachments for insert to authenticated
  with check (public.is_my_org(author_org_type, author_org_id)
          and exists (select 1 from public.asset_reviews r
                       where r.id = review_attachments.review_id
                         and r.accepted_at is null
                         and (r.scope = 'internal' or public.is_link_party(r.link_id))));

drop policy if exists rat_del on public.review_attachments;
create policy rat_del on public.review_attachments for delete to authenticated
  using (public.is_my_org(author_org_type, author_org_id)
     and (uploaded_by_user_id = (select auth.uid())
          or (uploaded_by_user_id is null and uploaded_by = (select auth.jwt() ->> 'email')))
     and exists (select 1 from public.asset_reviews r
                  where r.id = review_attachments.review_id and r.accepted_at is null));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. review_accept — the formal delivery sign-off (ACID; arthound_rpc).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

-- Snapshot reads the studio's replicated asset rows (the delivered context); rpc_all policy exists
-- since migration 4 — only the SELECT grant was missing (INSERT-only until now).
grant select on public.replicated_assets to arthound_rpc;

create or replace function public.review_accept(p_review_id uuid)
  returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select public.current_uid());
  v_r record;
  v_link record;
  v_now timestamptz := now();
  v_snapshot jsonb;
begin
  select * into v_r from public.asset_reviews where id = p_review_id for update;
  if v_r is null then raise exception 'review not found'; end if;
  if v_r.scope <> 'cross_org' then raise exception 'only cross-org reviews can be accepted'; end if;
  if v_r.accepted_at is not null then raise exception 'review is already accepted'; end if;

  select * into v_link from public.studio_vendor_links where id = v_r.link_id;
  if v_link.status <> 'active' then raise exception 'link is not active'; end if;
  if v_link.studio_id not in (select public.current_studio_ids()) then
    raise exception 'only the studio may accept delivery';
  end if;

  -- Protocol gate: when the review fulfils a protocol step, every EARLIER step must already have a
  -- fulfilling submission for the same asset (plan §5 "validate required protocol steps fulfilled").
  if v_r.step_def_id is not null and exists (
       select 1
         from public.review_step_def sd
        where sd.workflow_def_id = v_link.review_protocol_def_id
          and sd.archived_at is null
          and sd.sort < (select sort from public.review_step_def where id = v_r.step_def_id)
          and not exists (
            select 1 from public.asset_reviews r2
             where r2.link_id = v_r.link_id
               and r2.scope = 'cross_org'
               and r2.step_def_id = sd.id
               and r2.canonical_asset_id = v_r.canonical_asset_id)) then
    raise exception 'earlier required submissions are unfulfilled for this asset';
  end if;

  -- SHARED-lane comments only: frozen_snapshot is readable by both parties via ar_sel.
  v_snapshot := jsonb_build_object(
    'review', jsonb_build_object(
      'id', v_r.id, 'title', v_r.title, 'description', v_r.description, 'status', v_r.status,
      'link_id', v_r.link_id, 'step_def_id', v_r.step_def_id,
      'author_org_type', v_r.author_org_type, 'author_org_id', v_r.author_org_id,
      'promoted_from_review_id', v_r.promoted_from_review_id,
      'revision_of_review_id', v_r.revision_of_review_id, 'created_at', v_r.created_at),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'canonical_asset_id', ra.canonical_asset_id,
               'name', rep.name, 'source_type', rep.source_type,
               'source_record_id', rep.source_record_id, 'meta', rep.meta))
        from public.review_assets ra
        left join public.replicated_assets rep
          on rep.canonical_asset_id = ra.canonical_asset_id
         and rep.owner_type = 'studio' and rep.owner_id = v_r.studio_id
       where ra.review_id = p_review_id), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'author_org_type', c.author_org_type, 'author_email', c.author_email,
               'body', c.body, 'created_at', c.created_at) order by c.created_at)
        from public.review_comments c
       where c.review_id = p_review_id and c.visibility = 'shared'), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'filename', a.filename, 'storage_path', a.storage_path,
               'content_type', a.content_type, 'file_size', a.file_size))
        from public.review_attachments a
       where a.review_id = p_review_id), '[]'::jsonb),
    'accepted', jsonb_build_object('at', v_now, 'by_user_id', v_uid, 'by_org_id', v_link.studio_id));

  update public.asset_reviews
     set accepted_at = v_now, accepted_by_user_id = v_uid,
         frozen_snapshot = v_snapshot, status = 'Approved', updated_at = v_now
   where id = p_review_id;

  insert into public.review_events
    (review_id, subject_type, subject_id, event_type, actor_user_id, actor_org_type, actor_org_id, detail)
  values
    (p_review_id, 'review', p_review_id, 'accepted', v_uid, 'studio', v_link.studio_id,
     jsonb_build_object('from_status', v_r.status));
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. review_set_status — friendlier error before the trigger fires on accepted reviews.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.review_set_status(p_review_id uuid, p_status text)
  returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select public.current_uid());
  v_r record;
  v_link record;
  v_actor_org_type text;
  v_actor_org_id uuid;
begin
  if p_status is null or length(btrim(p_status)) = 0 or length(p_status) > 80 then
    raise exception 'invalid status';
  end if;

  select * into v_r from public.asset_reviews where id = p_review_id for update;
  if v_r is null then raise exception 'review not found'; end if;
  if v_r.scope <> 'cross_org' then raise exception 'not a cross-org review'; end if;
  if v_r.accepted_at is not null then raise exception 'review is accepted and immutable'; end if;
  if not public.is_link_party(v_r.link_id) then
    raise exception 'not a party to this link, or the link is no longer active';
  end if;

  select * into v_link from public.studio_vendor_links where id = v_r.link_id;
  if v_link.studio_id in (select public.current_studio_ids()) then
    v_actor_org_type := 'studio'; v_actor_org_id := v_link.studio_id;
  elsif v_link.vendor_id in (select public.current_vendor_ids()) then
    v_actor_org_type := 'vendor'; v_actor_org_id := v_link.vendor_id;
  else
    raise exception 'not a party to this link';
  end if;

  update public.asset_reviews set status = p_status, updated_at = now() where id = p_review_id;

  insert into public.review_events
    (review_id, subject_type, subject_id, event_type, actor_user_id, actor_org_type, actor_org_id, detail)
  values
    (p_review_id, 'review', p_review_id, 'status_changed', v_uid, v_actor_org_type, v_actor_org_id,
     jsonb_build_object('from', v_r.status, 'to', p_status));
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. promote_review — auto revision chain: a re-promotion of the same internal review on the same
--    link links to the latest prior copy (re-delivery IS re-promotion; plan §6 flow 4). Signature
--    unchanged from P2 — CREATE OR REPLACE, no overload risk.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.promote_review(
  p_review_id uuid,
  p_link_id uuid,
  p_trim jsonb default '{}'::jsonb,
  p_actor_email text default null,
  p_step_def_id uuid default null
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select public.current_uid());
  v_r record;
  v_new_id uuid;
  v_revision_of uuid;
  v_fields jsonb := coalesce(p_trim->'fields', '{}'::jsonb);
  v_comment_ids uuid[];
  v_attachment_ids uuid[];
  v_now timestamptz := now();
begin
  select * into v_r from public.asset_reviews where id = p_review_id for update;
  if v_r is null then raise exception 'review not found'; end if;
  if not public.is_my_org(v_r.author_org_type, v_r.author_org_id) then
    raise exception 'not a member of the authoring org';
  end if;
  if v_r.scope <> 'internal' then
    raise exception 'only internal reviews can be promoted';
  end if;
  if not public.is_link_party_for_studio(p_link_id, v_r.studio_id) then
    raise exception 'link is not active, not yours, or does not match this review''s studio';
  end if;
  if p_step_def_id is not null and not exists (
       select 1
         from public.review_step_def sd
         join public.studio_vendor_links l on l.id = p_link_id
        where sd.id = p_step_def_id
          and sd.workflow_def_id = l.review_protocol_def_id
          and sd.archived_at is null) then
    raise exception 'step does not belong to this link''s review protocol';
  end if;

  -- Revision chain: latest prior promoted copy of this internal review on this link.
  select id into v_revision_of
    from public.asset_reviews
   where promoted_from_review_id = p_review_id and link_id = p_link_id and scope = 'cross_org'
   order by created_at desc limit 1;

  v_comment_ids := coalesce(
    (select array_agg(e::uuid)
       from jsonb_array_elements_text(coalesce(p_trim->'comment_ids', '[]'::jsonb)) e),
    array[]::uuid[]);
  v_attachment_ids := coalesce(
    (select array_agg(e::uuid)
       from jsonb_array_elements_text(coalesce(p_trim->'attachment_ids', '[]'::jsonb)) e),
    array[]::uuid[]);

  insert into public.asset_reviews
    (studio_id, canonical_asset_id, scope, link_id, promoted_from_review_id, revision_of_review_id,
     step_def_id, author_org_type, author_org_id, title, description, status,
     created_by_email, created_by_user_id)
  values
    (v_r.studio_id, v_r.canonical_asset_id, 'cross_org', p_link_id, p_review_id, v_revision_of,
     p_step_def_id, v_r.author_org_type, v_r.author_org_id,
     case when coalesce((v_fields->>'title')::boolean, true) then v_r.title end,
     case when coalesce((v_fields->>'description')::boolean, true) then v_r.description end,
     case when coalesce((v_fields->>'status')::boolean, true) then v_r.status end,
     coalesce(p_actor_email, v_r.created_by_email), v_uid)
  returning id into v_new_id;

  insert into public.review_assets (review_id, canonical_asset_id)
  select v_new_id, ra.canonical_asset_id
    from public.review_assets ra where ra.review_id = p_review_id
  on conflict do nothing;
  insert into public.review_assets (review_id, canonical_asset_id)
  values (v_new_id, v_r.canonical_asset_id)
  on conflict do nothing;

  insert into public.review_comments
    (review_id, author_org_type, author_org_id, author_user_id, author_email,
     body, visibility, shared_at, copied_from_comment_id, created_at)
  select v_new_id, c.author_org_type, c.author_org_id, c.author_user_id, c.author_email,
         c.body, 'shared', v_now, c.id, c.created_at
    from public.review_comments c
   where c.review_id = p_review_id and c.id = any(v_comment_ids);

  insert into public.review_attachments
    (review_id, studio_id, author_org_type, author_org_id, filename, storage_path,
     content_type, file_size, uploaded_by, uploaded_by_user_id, copied_from_attachment_id)
  select v_new_id, a.studio_id, a.author_org_type, a.author_org_id, a.filename, a.storage_path,
         a.content_type, a.file_size, a.uploaded_by, a.uploaded_by_user_id, a.id
    from public.review_attachments a
   where a.review_id = p_review_id and a.id = any(v_attachment_ids);

  insert into public.review_events
    (review_id, subject_type, subject_id, event_type, actor_user_id, actor_org_type, actor_org_id, detail)
  values
    (v_new_id, 'review', v_new_id, 'promoted', v_uid, v_r.author_org_type, v_r.author_org_id,
     jsonb_build_object('promoted_from', p_review_id, 'link_id', p_link_id,
                        'step_def_id', p_step_def_id, 'revision_of', v_revision_of,
                        'comments_copied', coalesce(array_length(v_comment_ids, 1), 0),
                        'attachments_copied', coalesce(array_length(v_attachment_ids, 1), 0))),
    (p_review_id, 'review', v_new_id, 'promoted', v_uid, v_r.author_org_type, v_r.author_org_id,
     jsonb_build_object('promoted_to', v_new_id, 'link_id', p_link_id));

  if p_step_def_id is not null then
    insert into public.review_events
      (review_id, subject_type, subject_id, event_type, actor_user_id, actor_org_type, actor_org_id, detail)
    values
      (v_new_id, 'requirement', p_step_def_id, 'requirement_tagged', v_uid,
       v_r.author_org_type, v_r.author_org_id, jsonb_build_object('link_id', p_link_id));
  end if;

  if v_revision_of is not null then
    insert into public.review_events
      (review_id, subject_type, subject_id, event_type, actor_user_id, actor_org_type, actor_org_id, detail)
    values
      (v_new_id, 'review', v_revision_of, 'revision_created', v_uid,
       v_r.author_org_type, v_r.author_org_id, jsonb_build_object('supersedes', v_revision_of));
  end if;

  return v_new_id;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. Ownership + EXECUTE hardening (review_accept is new; the recreated fns keep their owner).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

do $$ begin execute format('grant arthound_rpc to %I with set true, inherit true', current_user); end $$;
grant usage on schema public to arthound_rpc;
grant create on schema public to arthound_rpc;  -- transient; revoked below

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.review_accept(uuid)',
    'public.promote_review(uuid, uuid, jsonb, text, uuid)',
    'public.review_set_status(uuid, text)'
  ]
  loop
    execute format('alter function %s owner to arthound_rpc', fn);
    execute format('revoke all on function %s from public', fn);
    execute format('revoke execute on function %s from anon, service_role', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end $$;

revoke create on schema public from arthound_rpc;

commit;

-- ── Post-apply checks (run manually / in CI; NOT part of the transaction) ─────────────────────────
-- A. review_accept owned by arthound_rpc, prosecdef, search_path pinned.
-- B. Immutability: after accepting a review, (1) owner PATCH on it → 0 rows (ar_upd), (2) partner
--    review_set_status → 'accepted and immutable', (3) comment INSERT on it → RLS violation,
--    (4) any direct UPDATE raises 'accepted reviews are immutable' (trigger).
-- C. frozen_snapshot.comments contains ONLY shared-lane comments.
-- D. rls_grant_audit.py + rls_persona_matrix.py green.
