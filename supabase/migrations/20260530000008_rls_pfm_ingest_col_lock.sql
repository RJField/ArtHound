-- 20260530000008_rls_pfm_ingest_col_lock.sql
-- RLS migration 8 — lock the payload_field_mappings ingest-RESULT columns to the ingest path
-- (plan §4a item 5 / §3 flag).
--
-- The pfm_vendor RLS policy (migration 3) lets a vendor write their own mapping ROW — necessary for the
-- mapping CONFIG (mappings / target_table_id / target_issue_type / …). But a row-level policy cannot stop
-- that same vendor from ALSO writing the ingest-RESULT columns and thereby SPOOFING ingest state
-- (e.g. setting ingested_at to fake a completed ingest, or clearing failed_at). Those five columns belong
-- exclusively to rpc_ingest_payload / rpc_retry_canonical_link (owned by arthound_rpc) and, on the flag-off
-- path, to the service-role backend.
--
-- A BEFORE INSERT OR UPDATE trigger enforces it: a non-trusted role that sets (INSERT) or changes (UPDATE)
-- any result column is rejected. The authority is current_user — the actual Postgres role — NOT a JWT
-- claim (consistent with the §0b is_system rule). Trusted writers:
--   * arthound_rpc  — the ingest RPCs run SECURITY DEFINER, so current_user = arthound_rpc inside them
--   * service_role  — the flag-off backend writes these columns directly (do_ingest / retry)
--   * postgres      — migrations / backfills
-- Idempotent.

begin;

create or replace function public.pfm_guard_ingest_cols()
  returns trigger language plpgsql set search_path = '' as $$
begin
  -- Trusted writers (ingest RPCs / flag-off backend / migrations) may set the result columns.
  if current_user in ('arthound_rpc', 'service_role', 'postgres') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.ingested_at is not null
       or new.ingested_source_record_id is not null
       or new.ingested_by_user_id is not null
       or new.failed_at is not null
       or new.failure_reason is not null then
      raise exception
        'payload_field_mappings ingest-result columns are read-only (set via the ingest RPC)';
    end if;
  else  -- UPDATE
    if new.ingested_at is distinct from old.ingested_at
       or new.ingested_source_record_id is distinct from old.ingested_source_record_id
       or new.ingested_by_user_id is distinct from old.ingested_by_user_id
       or new.failed_at is distinct from old.failed_at
       or new.failure_reason is distinct from old.failure_reason then
      raise exception
        'payload_field_mappings ingest-result columns are read-only (set via the ingest RPC)';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists pfm_guard_ingest on public.payload_field_mappings;
create trigger pfm_guard_ingest
  before insert or update on public.payload_field_mappings
  for each row execute function public.pfm_guard_ingest_cols();

commit;

-- ── Post-apply test (plan §9; run as a vendor JWT) ────────────────────────────────────────────────
--   * a vendor UPDATE of its own row setting ingested_at  → ERROR (read-only).
--   * a vendor UPDATE of its own row setting only mappings → OK.
--   * rpc_ingest_payload (arthound_rpc) setting ingested_at → OK (current_user = arthound_rpc).
