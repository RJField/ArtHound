-- 20260530000018_rls_rpc_ingest_grants.sql
-- RLS migration fix — re-assert arthound_rpc write GRANTs + policies for the payload-ingest RPCs.
--
-- Symptom: vendor payload ingest fails with
--   "canonical link failed: permission denied for table payload_export_records"  (SQLSTATE 42501)
-- and the record lands in failed_ingests (Retry Link UI). The route correctly calls rpc_ingest_payload
-- (a SECURITY DEFINER fn owned by arthound_rpc, a NON-owner of the tables → still subject to RLS), but
-- its INSERT into payload_export_records is denied because arthound_rpc is missing the table GRANT at
-- runtime. "permission denied for table" is a privilege error (missing GRANT), NOT an RLS policy denial
-- (which would read "new row violates row-level security policy").
--
-- Root cause: file-vs-DB drift. Migration 20260530000004 grants these to arthound_rpc, but the grant
-- block was edited after 4 had already applied to the dev/prod DBs (see its [+ADD]/[~MOD] annotations);
-- a Supabase migration is one transaction recorded by version, so the later edits never re-ran. The
-- function body was present (via create-or-replace at some point) but the new grants were not.
--
-- This migration idempotently re-asserts the GRANTs + the rpc_all policy for the FULL ingest write-set
-- that rpc_ingest_payload / rpc_retry_canonical_link write. Re-granting an existing grant is a no-op;
-- policies are dropped-then-created. Safe to run against an already-correct DB. Mirrors the §6 grant
-- block in migration 20260530000004 — keep the two consistent. Read grants in migration 4 are intact
-- (the RPC reaches the INSERT, i.e. past its payload_dispatches SELECT + authz, before failing).

grant insert         on public.payload_export_records to arthound_rpc;
grant insert         on public.replicated_assets      to arthound_rpc;
grant update         on public.payload_field_mappings to arthound_rpc;
grant insert         on public.payload_access_log     to arthound_rpc;
grant insert, update on public.failed_ingests         to arthound_rpc;

-- FORCE RLS requires arthound_rpc (non-owner) to also hold a policy per table (plan §6).
do $$
declare t text;
begin
  foreach t in array array[
    'payload_export_records','replicated_assets','payload_field_mappings',
    'payload_access_log','failed_ingests'
  ]
  loop
    execute format('drop policy if exists rpc_all on public.%I', t);
    execute format('create policy rpc_all on public.%I for all to arthound_rpc using (true) with check (true)', t);
  end loop;
end $$;
