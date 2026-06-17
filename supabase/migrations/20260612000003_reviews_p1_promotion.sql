-- 20260612000003_reviews_p1_promotion.sql
-- Cross-org reviews P1 — promotion + ad-hoc cross-org + partner status (docs/plans/cross-org-reviews.md §7).
--
-- Delivers: review_trim_templates (vendor-owned trim configs, the payload_templates analogue for
-- review fields/comments/attachments), attachment promotion provenance, and the two DEFINER RPCs:
--   * promote_review     — the ONE path an internal review crosses the org wall: creates a NEW
--                          cross-org review (trimmed copy), copies selected comments (shared lane)
--                          and attachments (same content-addressed storage path, no byte copy),
--                          mirrors the asset junction, events on both sides. ACID — any failure
--                          rolls the whole promotion back.
--   * review_set_status  — the partner-side transition (a studio acting on a vendor submission).
--                          Owner-org edits stay on the ar_upd user policy; the partner has NO user
--                          write policy, so this RPC is their only path, and it events the change.
--
-- RPC conventions follow 20260530000004: owned by arthound_rpc (non-owner ⇒ FORCE RLS still binds it,
-- bounded by the rpc_all policies + exact grants below), SECURITY DEFINER, search_path='', EXECUTE for
-- authenticated only, in-fn authz via the membership/link predicates, FOR UPDATE lock + re-check.
--
-- The ar_sel/rc_sel/rat_sel/rev_sel user policies from P0 were already written in their final
-- cross-org shape, so promoted rows become visible to the link partner with NO policy change here.

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. review_trim_templates — vendor-owned promotion templates (mirrors payload_templates).
--    config jsonb is deliberately schemaless: {fields:{title,description,status}, comments:...,
--    attachments:...} today; granularity is expected to grow (plan §4).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create table public.review_trim_templates (
  id         uuid        primary key default gen_random_uuid(),
  vendor_id  uuid        not null references public.vendors(id) on delete cascade,
  link_id    uuid        references public.studio_vendor_links(id),  -- null = vendor-wide default
  name       text        not null,
  config     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index review_trim_templates_vendor_id_idx on public.review_trim_templates(vendor_id);

alter table public.review_trim_templates enable row level security;
alter table public.review_trim_templates force row level security;

create policy rtt_all on public.review_trim_templates for all to authenticated
  using (vendor_id in (select public.current_vendor_ids()))
  with check (vendor_id in (select public.current_vendor_ids()));

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Attachment promotion provenance. Promoted rows reference the SAME storage path as the source
--    (content-addressed; no byte copy) — blob deletion must check for other referencing rows first
--    (enforced in routes/reviews.py delete_attachment).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.review_attachments
  add column copied_from_attachment_id uuid references public.review_attachments(id) on delete set null;

create index review_attachments_storage_path_idx on public.review_attachments(storage_path);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. arthound_rpc containment: rpc_all policies + EXACT grants on the review subtree write set.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare t text;
begin
  foreach t in array array[
    'asset_reviews', 'review_assets', 'review_comments', 'review_attachments', 'review_events'
  ]
  loop
    execute format('drop policy if exists rpc_all on public.%I', t);
    execute format('create policy rpc_all on public.%I for all to arthound_rpc using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert, update on public.asset_reviews      to arthound_rpc;
grant select, insert         on public.review_assets      to arthound_rpc;
grant select, insert         on public.review_comments    to arthound_rpc;
grant select, insert         on public.review_attachments to arthound_rpc;
grant insert                 on public.review_events      to arthound_rpc;

grant execute on function public.is_link_party_for_studio(uuid, uuid) to arthound_rpc;
grant execute on function public.is_link_party_any_status(uuid)       to arthound_rpc;

-- arthound_system reads review_attachments for the shared-blob deletion guard in
-- routes/reviews.py delete_attachment (the other referencing row may be outside the caller's RLS
-- view). Granted here, not P0, because the guard ships with promotion. (Regression-class #6 guard.)
drop policy if exists sys_read on public.review_attachments;
create policy sys_read on public.review_attachments for select to arthound_system using (true);
grant select on public.review_attachments to arthound_system;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. promote_review — internal → cross-org trimmed copy (plan §5 promotion flow).
--    p_trim: {"fields": {"title": bool, "description": bool, "status": bool},   (default: copy all)
--             "comment_ids": [uuid, ...],                                       (default: none)
--             "attachment_ids": [uuid, ...]}                                    (default: none)
--    Selection lists are EXPLICIT ids — the route resolves a trim template into ids first, so the
--    audited RPC records exactly what crossed. Ids not belonging to the source review are ignored
--    by the ownership-scoped WHERE (no cross-review copy possible).
--    p_actor_email is display-only provenance (arthound_rpc cannot read auth.users).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.promote_review(
  p_review_id uuid,
  p_link_id uuid,
  p_trim jsonb default '{}'::jsonb,
  p_actor_email text default null
) returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select public.current_uid());
  v_r record;
  v_new_id uuid;
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
  -- Active link, caller is a party, link.studio matches the review's studio — one predicate, all three.
  if not public.is_link_party_for_studio(p_link_id, v_r.studio_id) then
    raise exception 'link is not active, not yours, or does not match this review''s studio';
  end if;

  v_comment_ids := coalesce(
    (select array_agg(e::uuid)
       from jsonb_array_elements_text(coalesce(p_trim->'comment_ids', '[]'::jsonb)) e),
    array[]::uuid[]);
  v_attachment_ids := coalesce(
    (select array_agg(e::uuid)
       from jsonb_array_elements_text(coalesce(p_trim->'attachment_ids', '[]'::jsonb)) e),
    array[]::uuid[]);

  insert into public.asset_reviews
    (studio_id, canonical_asset_id, scope, link_id, promoted_from_review_id,
     author_org_type, author_org_id, title, description, status,
     created_by_email, created_by_user_id)
  values
    (v_r.studio_id, v_r.canonical_asset_id, 'cross_org', p_link_id, p_review_id,
     v_r.author_org_type, v_r.author_org_id,
     case when coalesce((v_fields->>'title')::boolean, true) then v_r.title end,
     case when coalesce((v_fields->>'description')::boolean, true) then v_r.description end,
     case when coalesce((v_fields->>'status')::boolean, true) then v_r.status end,
     coalesce(p_actor_email, v_r.created_by_email), v_uid)
  returning id into v_new_id;

  -- Asset junction: mirror the source review's full asset set (plus the primary anchor as a floor).
  insert into public.review_assets (review_id, canonical_asset_id)
  select v_new_id, ra.canonical_asset_id
    from public.review_assets ra where ra.review_id = p_review_id
  on conflict do nothing;
  insert into public.review_assets (review_id, canonical_asset_id)
  values (v_new_id, v_r.canonical_asset_id)
  on conflict do nothing;

  -- Selected comments cross in the SHARED lane, original authorship + timestamps preserved.
  insert into public.review_comments
    (review_id, author_org_type, author_org_id, author_user_id, author_email,
     body, visibility, shared_at, copied_from_comment_id, created_at)
  select v_new_id, c.author_org_type, c.author_org_id, c.author_user_id, c.author_email,
         c.body, 'shared', v_now, c.id, c.created_at
    from public.review_comments c
   where c.review_id = p_review_id and c.id = any(v_comment_ids);

  -- Selected attachments: new rows referencing the SAME storage path (no byte copy).
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
                        'comments_copied', coalesce(array_length(v_comment_ids, 1), 0),
                        'attachments_copied', coalesce(array_length(v_attachment_ids, 1), 0))),
    (p_review_id, 'review', v_new_id, 'promoted', v_uid, v_r.author_org_type, v_r.author_org_id,
     jsonb_build_object('promoted_to', v_new_id, 'link_id', p_link_id));

  return v_new_id;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. review_set_status — partner (or owner) transitions a cross-org review's status.
--    Requires an ACTIVE link (write-block on cancelled links); statuses stay free text (plan req 7).
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
-- 6. Ownership + EXECUTE hardening (20260530000004 conventions).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

do $$ begin execute format('grant arthound_rpc to %I with set true, inherit true', current_user); end $$;
grant usage on schema public to arthound_rpc;
grant create on schema public to arthound_rpc;  -- transient; revoked below

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.promote_review(uuid, uuid, jsonb, text)',
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
-- A. Both fns owned by arthound_rpc, prosecdef, search_path pinned:
--      select proname, pg_get_userbyid(proowner), prosecdef,
--             (select array_agg(c) from unnest(proconfig) c where c like 'search_path=%')
--        from pg_proc where pronamespace='public'::regnamespace
--         and proname in ('promote_review','review_set_status');
-- B. Tenancy: a NON-party caller invoking promote_review / review_set_status must raise; a partner
--    (link party, non-author) must be able to set status but not UPDATE asset_reviews directly.
-- C. rls_grant_audit.py green (rpc grants above self-register in the expected set).
