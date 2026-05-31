-- 20260530000005_rls_force.sql
-- RLS migration 5 of N — FORCE ROW LEVEL SECURITY, defense-in-depth (plan §3 + §1a, sequencing §8).
--
-- WHY (plan §3): the user/system/rpc paths are already enforced without FORCE (authenticated,
-- arthound_system, arthound_rpc are NON-owners, so RLS always applies to them). FORCE adds the last
-- layer: it makes even a table's OWNER subject to its policies, closing the SECURITY DEFINER footgun
-- where a postgres-owned definer would otherwise bypass RLS. With FORCE on, the §6 cross-tenant RPCs
-- (owned by the NON-owner arthound_rpc) are correctly bounded by their per-table rpc_all policies.
--
-- THE FOOTGUN THIS FILE MUST AVOID (plan §1a — read before editing):
-- The membership/link predicate functions (current_studio_ids, current_vendor_ids, is_link_party) are
-- SECURITY DEFINER and read studio_members / vendor_members / studio_vendor_links AS THEIR OWNER. They
-- don't recurse today ONLY because of the table-owner exemption (owner reads skip RLS when the table is
-- NOT forced). FORCE-ing those three tables removes that exemption and arms TWO failure modes:
--   1. Recursion: a policy calls current_studio_ids() -> reads studio_members (now forced) -> its own
--      policy calls current_studio_ids() -> ... -> stack-depth error.
--   2. Silent-deny: if the membership policy were non-recursive, the owner-run helper still finds no
--      policy applies to it under FORCE -> returns EMPTY -> every dependent policy denies all rows.
-- Therefore these three tables are PERMANENTLY EXCLUDED from FORCE. They keep RLS ENABLED + policies, so
-- the user path stays fully enforced (authenticated is a non-owner); only the owner-run helper reads get
-- the exemption. They hold low-sensitivity data (who-is-in-which-org, which-orgs-are-linked); the
-- sensitive payloads / rates / assets all live in tables that ARE forced. review_grant JOINS this
-- exclusion list when the cross-org-reviews subtree ships (has_grant reads it as definer).
--
-- The exclusion does NOT rest on the postgres owner's BYPASSRLS attribute (which would also mask the
-- footgun but fragilely) — it rests only on function-owner == table-owner, guaranteed when migrations
-- run as one role. See the preflight assertion at the end.
--
-- Catalog-driven (plan §3 / ops finding): FORCE every public table that has RLS enabled, minus the
-- exclusion set. A hardcoded list would silently miss a future table or abort on a renamed one.
--
-- Idempotent: re-running FORCEs already-forced tables harmlessly. Safe to apply before the app cutover —
-- changes nothing for the service-role path (BYPASSRLS), only tightens owner/definer behaviour.

begin;

do $$
declare
  t text;
  -- PERMANENTLY EXCLUDED — predicate-consulted tables (§1a). Editing this set is a security decision:
  -- adding a table here weakens defense-in-depth; removing one here can recurse/silent-deny the
  -- predicate functions. review_grant is listed pre-emptively (no-op until that table exists).
  excluded text[] := array[
    'studio_members',
    'vendor_members',
    'studio_vendor_links',
    'review_grant'
  ];
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relrowsecurity            -- RLS enabled
       and not c.relforcerowsecurity   -- not already forced (keeps the log/▲ minimal; harmless either way)
       and c.relname <> all(excluded)
  loop
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

commit;

-- ── Preflight / post-apply assertions (run manually / in CI; NOT in the transaction) ──────────────
--
-- A. The §1a invariant the exclusion relies on: the predicate functions' owner == the excluded tables'
--    owner (so the table-owner exemption holds without depending on BYPASSRLS). Expect every row 'OK':
--
--      select t.relname,
--             case when t.relowner = f.proowner then 'OK' else 'MISMATCH — DO NOT SHIP' end as owner_match
--        from pg_class t
--        join pg_namespace n on n.oid = t.relnamespace and n.nspname='public'
--        cross join (select proowner from pg_proc
--                     where pronamespace='public'::regnamespace
--                       and proname='current_studio_ids' limit 1) f
--       where t.relname in ('studio_members','vendor_members','studio_vendor_links');
--
-- B. FORCE-set regression guard (plan §9 test #2b): the excluded tables must NEVER be forced, so a
--    future "force everything" change can't silently re-arm the footgun. Expect ZERO rows:
--
--      select relname from pg_class
--       where relnamespace='public'::regnamespace and relkind='r' and relforcerowsecurity
--         and relname in ('studio_members','vendor_members','studio_vendor_links','review_grant');
--
-- C. Coverage: every RLS-enabled tenant table EXCEPT the exclusion set is forced. Expect only the
--    exclusion-set names (and review_grant once it exists):
--
--      select relname from pg_class
--       where relnamespace='public'::regnamespace and relkind='r'
--         and relrowsecurity and not relforcerowsecurity order by relname;
--
-- D. The §9 live test: as a zero-membership user JWT, resolve_my_membership() returns empty with NO
--    stack-depth error (proves the exclusion prevents recursion under FORCE).
