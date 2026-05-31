-- 20260530000014_rls_counterparty_directory.sql
-- RLS migration 14 — link/invite-authorized cross-org reads (post-cutover regression fix).
--
-- Under FORCE RLS, studios.st_sel / vendors.v_sel scope each org to its OWN row, so every place the app
-- resolves a COUNTERPARTY org's display name (connections lists, the Send-to-Vendor dropdown, estimate
-- shares, pending invites) returned nothing → "Unknown Studio"/"Unknown Vendor" + an empty vendor
-- dropdown. A blanket SELECT policy is NOT safe: studios/vendors carry `invite_code` (the org join gate),
-- and RLS is row-level, so widening the policy would leak it. Instead expose ONLY safe fields
-- (id, name, handle) through SECURITY DEFINER read-RPCs, authorized by an actual relationship.
--
-- Three RPCs (postgres-owned + BYPASSRLS, like the migration-6 bootstrap reads — they can call the
-- auth.uid()-based predicate fns and read the FORCE'd tables without per-table policies; created as
-- postgres and never reassigned, so they stay postgres-owned):
--   * rpc_org_directory(org_type)   — id/name/handle for orgs the caller OWNS, is LINKED to
--                                      (studio_vendor_links), or has a pending INVITE with
--                                      (studio_vendor_invites), in EITHER direction. NEVER invite_code.
--   * rpc_search_vendors(query)     — global vendor handle discovery for the studio "connect a vendor"
--                                      flow (vendors are discoverable by handle BY DESIGN). Safe fields.
--   * rpc_invite_studio_templates(invite_id) — the inviting studio's payload_templates, for a vendor to
--                                      preview before accepting (pt_all is studio-only → vendor-blocked).
--                                      Authorized by a pending invite addressed to the caller's vendor.
-- Idempotent (create-or-replace + revoke/grant). Routes call these only flag-on; flag-off keeps the
-- legacy service-role reads (byte-identical).

begin;

-- ── rpc_org_directory — counterparty (and own) org names, safe fields only ──────────────────────────
create or replace function public.rpc_org_directory(p_org_type text)
  returns table(id uuid, name text, handle text)
  language sql security definer stable set search_path = ''
as $$
  select s.id, s.name, null::text
    from public.studios s
   where p_org_type = 'studio'
     and ( s.id in (select public.current_studio_ids())
        or exists (select 1 from public.studio_vendor_links l
                    where l.studio_id = s.id and l.vendor_id in (select public.current_vendor_ids()))
        or exists (select 1 from public.studio_vendor_invites i
                    where i.studio_id = s.id and i.vendor_id in (select public.current_vendor_ids())) )
  union
  select v.id, v.name, v.handle
    from public.vendors v
   where p_org_type = 'vendor'
     and ( v.id in (select public.current_vendor_ids())
        or exists (select 1 from public.studio_vendor_links l
                    where l.vendor_id = v.id and l.studio_id in (select public.current_studio_ids()))
        or exists (select 1 from public.studio_vendor_invites i
                    where i.vendor_id = v.id and i.studio_id in (select public.current_studio_ids())) );
$$;

-- ── rpc_search_vendors — global vendor discovery by handle (safe fields) ────────────────────────────
create or replace function public.rpc_search_vendors(p_query text)
  returns table(id uuid, name text, handle text)
  language sql security definer stable set search_path = ''
as $$
  select v.id, v.name, v.handle
    from public.vendors v
   where length(coalesce(trim(p_query), '')) >= 2
     and v.handle ilike trim(p_query) || '%'
   order by v.name asc
   limit 10;
$$;

-- ── rpc_invite_studio_templates — inviting studio's templates for a pending invite to the caller ────
create or replace function public.rpc_invite_studio_templates(p_invite_id uuid)
  returns table(id uuid, name text, field_schema jsonb)
  language sql security definer stable set search_path = ''
as $$
  select t.id, t.name, t.field_schema
    from public.studio_vendor_invites i
    join public.payload_templates t on t.studio_id = i.studio_id
   where i.id = p_invite_id
     and i.vendor_id in (select public.current_vendor_ids())
   order by t.name asc;
$$;

-- ── EXECUTE lockdown (Supabase default-grants anon+authenticated+service_role on every new fn) ──────
-- authenticated only (all three need a logged-in caller; strip anon + service_role).
revoke all on function public.rpc_org_directory(text)             from public;
revoke all on function public.rpc_search_vendors(text)            from public;
revoke all on function public.rpc_invite_studio_templates(uuid)   from public;
revoke execute on function public.rpc_org_directory(text), public.rpc_search_vendors(text),
  public.rpc_invite_studio_templates(uuid) from anon, service_role;
grant  execute on function public.rpc_org_directory(text), public.rpc_search_vendors(text),
  public.rpc_invite_studio_templates(uuid) to authenticated;

commit;

-- ── Post-apply test (plan §9) ──────────────────────────────────────────────────────────────────────
--   * a vendor linked to studio S: rpc_org_directory('studio') returns S (name, no invite_code).
--   * a studio NOT linked/invited to vendor V: rpc_org_directory('vendor') does NOT return V.
--   * rpc_search_vendors('ac') returns vendors whose handle starts 'ac' (id/name/handle only).
--   * neither RPC ever returns invite_code (the columns aren't selected).
