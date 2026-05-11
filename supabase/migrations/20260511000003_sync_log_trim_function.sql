-- trim_sync_log(keep_rows int) — deletes old sync_log entries per owner,
-- keeping the N most recent rows. Skips rows still in 'running' state so an
-- in-progress sync's log entry is never removed mid-flight.
-- Called by the Python sync_log_trim_loop in main.py via PostgREST RPC.

create or replace function trim_sync_log(keep_rows int default 100)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_count int;
begin
  delete from sync_log
  where id in (
    select id
    from (
      select id,
             row_number() over (
               partition by owner_type, owner_id
               order by started_at desc
             ) as rn
      from sync_log
      where status <> 'running'
    ) ranked
    where rn > keep_rows
  );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Callable by service_role only (the backend uses the service role key)
revoke execute on function trim_sync_log(int) from public, anon, authenticated;
grant  execute on function trim_sync_log(int) to service_role;
