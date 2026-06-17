-- 20260612000004_reviews_p2_link_protocol.sql
-- Cross-org reviews P2 — link protocol / required submissions (docs/plans/cross-org-reviews.md §7).
--
-- Delivers: review_workflow_def + review_step_def (org-scoped protocol templates, the org-scope
-- stack convention: dual nullable FK + num_nonnulls=1 + generated owner_key), the link's sanctioned
-- protocol FK + vendor-acknowledgment stub columns, asset_reviews.step_def_id (which required
-- submission a cross-org review fulfils), and two RPC changes:
--   * review_set_link_protocol — studio assigns/clears the link's protocol (links have NO user
--     write policy, D-pattern: link mutations are DEFINER RPCs). Resets the acknowledgment stub.
--   * promote_review — recreated with p_step_def_id: a promotion can fulfil a protocol step;
--     validated against the LINK's protocol inside the RPC.
--
-- The requirement checklist is COMPUTED at read time (route layer): for each live-dispatched asset
-- on the link × each protocol step → the latest cross-org review tagged with that step_def_id
-- (none = unfulfilled; status 'Approved' = complete). No materialized state.
--
-- Tag-integrity containment: ad-hoc creates can write any step_def_id their RLS can see (the route
-- validates link-protocol membership for clean errors); the checklist only counts step_def_ids that
-- ARE in the link's protocol, so a forged/foreign tag is inert. The promote path validates in-RPC.

begin;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. Definition tables (org-scope stack convention; v1 authoring UI is studio-side only, schema is
--    org-generic so vendor-owned protocols slot in later without rework)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create table public.review_workflow_def (
  id          uuid        primary key default gen_random_uuid(),
  studio_id   uuid        references public.studios(id),
  vendor_id   uuid        references public.vendors(id),
  owner_key   uuid        generated always as (coalesce(studio_id, vendor_id)) stored,
  name        text        not null,
  description text,
  is_default  boolean     not null default false,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint rwd_one_owner check (num_nonnulls(studio_id, vendor_id) = 1)
);

create index review_workflow_def_owner_key_idx on public.review_workflow_def(owner_key);

create table public.review_step_def (
  id              uuid        primary key default gen_random_uuid(),
  workflow_def_id uuid        not null references public.review_workflow_def(id) on delete cascade,
  name            text        not null,
  description     text,
  sort            integer     not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index review_step_def_workflow_def_id_idx on public.review_step_def(workflow_def_id);

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. Link protocol FK + vendor-acknowledgment stub (v1: visible + actionable only; explicit vendor
--    acceptance is a deferred flow — the columns exist so it lands without a migration)
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.studio_vendor_links
  add column review_protocol_def_id   uuid references public.review_workflow_def(id),
  add column protocol_acknowledged_at timestamptz,
  add column protocol_acknowledged_by uuid;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. asset_reviews.step_def_id — which required submission this review fulfils (NULL = ad-hoc).
--    Owner-org mutable (re-tagging a mis-tagged review is legitimate; ar_upd already gates it).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.asset_reviews
  add column step_def_id uuid references public.review_step_def(id);

create index asset_reviews_step_def_id_idx on public.asset_reviews(step_def_id)
  where step_def_id is not null;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. RLS — own-org full control; the link PARTNER may read the protocol referenced by their link
--    (vendors must see the studio's required submissions). Step defs ride the parent def's
--    visibility for SELECT; writes are own-org only.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

alter table public.review_workflow_def enable row level security;
alter table public.review_workflow_def force row level security;
alter table public.review_step_def     enable row level security;
alter table public.review_step_def     force row level security;

create policy rwd_own on public.review_workflow_def for all to authenticated
  using ((studio_id is not null and studio_id in (select public.current_studio_ids()))
      or (vendor_id is not null and vendor_id in (select public.current_vendor_ids())))
  with check ((studio_id is not null and studio_id in (select public.current_studio_ids()))
           or (vendor_id is not null and vendor_id in (select public.current_vendor_ids())));

-- Partner read: the def is some link's sanctioned protocol and the caller is a party (any link
-- status — the protocol stays readable alongside the reviews after cancellation). The subquery on
-- studio_vendor_links runs under the caller's svl_sel (party-only), so this cannot widen beyond
-- the caller's own links.
create policy rwd_partner_sel on public.review_workflow_def for select to authenticated
  using (exists (select 1 from public.studio_vendor_links l
                  where l.review_protocol_def_id = review_workflow_def.id));

-- Step defs: SELECT rides the parent def's visibility (own org OR link partner); writes own-org only.
create policy rsd_sel on public.review_step_def for select to authenticated
  using (exists (select 1 from public.review_workflow_def d
                  where d.id = review_step_def.workflow_def_id));
create policy rsd_ins on public.review_step_def for insert to authenticated
  with check (exists (select 1 from public.review_workflow_def d
                       where d.id = review_step_def.workflow_def_id
                         and ((d.studio_id is not null and d.studio_id in (select public.current_studio_ids()))
                           or (d.vendor_id is not null and d.vendor_id in (select public.current_vendor_ids())))));
create policy rsd_upd on public.review_step_def for update to authenticated
  using (exists (select 1 from public.review_workflow_def d
                  where d.id = review_step_def.workflow_def_id
                    and ((d.studio_id is not null and d.studio_id in (select public.current_studio_ids()))
                      or (d.vendor_id is not null and d.vendor_id in (select public.current_vendor_ids())))));
create policy rsd_del on public.review_step_def for delete to authenticated
  using (exists (select 1 from public.review_workflow_def d
                  where d.id = review_step_def.workflow_def_id
                    and ((d.studio_id is not null and d.studio_id in (select public.current_studio_ids()))
                      or (d.vendor_id is not null and d.vendor_id in (select public.current_vendor_ids())))));

-- System read (future notification loop; regression-class #6 posture) + RPC reads (validations).
do $$
declare t text;
begin
  foreach t in array array['review_workflow_def', 'review_step_def'] loop
    execute format('drop policy if exists sys_read on public.%I', t);
    execute format('create policy sys_read on public.%I for select to arthound_system using (true)', t);
    execute format('drop policy if exists rpc_sel on public.%I', t);
    execute format('create policy rpc_sel on public.%I for select to arthound_rpc using (true)', t);
  end loop;
end $$;

grant select on public.review_workflow_def to arthound_system;
grant select on public.review_step_def     to arthound_system;
grant select on public.review_workflow_def to arthound_rpc;
grant select on public.review_step_def     to arthound_rpc;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 5. review_set_link_protocol — the studio assigns/clears the link's sanctioned protocol.
--    Links have no user write policy (D-pattern), so this is the one write path. Changing the
--    protocol resets the acknowledgment stub (the vendor acknowledges a SPECIFIC protocol).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.review_set_link_protocol(p_link_id uuid, p_def_id uuid)
  returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_link record;
begin
  select * into v_link from public.studio_vendor_links where id = p_link_id for update;
  if v_link is null then raise exception 'link not found'; end if;
  if v_link.status <> 'active' then raise exception 'link is not active'; end if;
  if v_link.studio_id not in (select public.current_studio_ids()) then
    raise exception 'only the link''s studio may set the review protocol';
  end if;
  if p_def_id is not null and not exists (
       select 1 from public.review_workflow_def d
        where d.id = p_def_id and d.studio_id = v_link.studio_id and d.archived_at is null) then
    raise exception 'protocol not found in your studio (or archived)';
  end if;

  update public.studio_vendor_links
     set review_protocol_def_id   = p_def_id,
         protocol_acknowledged_at = null,
         protocol_acknowledged_by = null,
         updated_at               = now()
   where id = p_link_id;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 6. promote_review — recreated with p_step_def_id (signature change ⇒ DROP first; an overload
--    would make PostgREST RPC dispatch ambiguous). Body identical to P1 plus the step validation
--    and tag. The route is the only caller and ships in the same deploy.
-- ════════════════════════════════════════════════════════════════════════════════════════════════

drop function if exists public.promote_review(uuid, uuid, jsonb, text);

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
  -- A fulfilment tag must point at a live step of THIS link's sanctioned protocol.
  if p_step_def_id is not null and not exists (
       select 1
         from public.review_step_def sd
         join public.studio_vendor_links l on l.id = p_link_id
        where sd.id = p_step_def_id
          and sd.workflow_def_id = l.review_protocol_def_id
          and sd.archived_at is null) then
    raise exception 'step does not belong to this link''s review protocol';
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
    (studio_id, canonical_asset_id, scope, link_id, promoted_from_review_id, step_def_id,
     author_org_type, author_org_id, title, description, status,
     created_by_email, created_by_user_id)
  values
    (v_r.studio_id, v_r.canonical_asset_id, 'cross_org', p_link_id, p_review_id, p_step_def_id,
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
                        'step_def_id', p_step_def_id,
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

  return v_new_id;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 7. Ownership + EXECUTE hardening (20260530000004 conventions).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

do $$ begin execute format('grant arthound_rpc to %I with set true, inherit true', current_user); end $$;
grant usage on schema public to arthound_rpc;
grant create on schema public to arthound_rpc;  -- transient; revoked below

do $$
declare fn text;
begin
  foreach fn in array array[
    'public.promote_review(uuid, uuid, jsonb, text, uuid)',
    'public.review_set_link_protocol(uuid, uuid)'
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
-- A. Ownership/secdef/search_path for promote_review (new signature) + review_set_link_protocol.
-- B. The OLD 4-arg promote_review signature is GONE (no PostgREST overload ambiguity):
--      select count(*) from pg_proc where proname='promote_review';  -- expect 1
-- C. Partner read: a vendor party to a link with a protocol can SELECT that def + its steps but
--    NOT the studio's other (unassigned) defs.
-- D. rls_grant_audit.py + rls_persona_matrix.py green.
