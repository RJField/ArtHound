-- The generated_work table was renamed from generated_tasks, so the old FK
-- constraint retained its original name. Drop it and ensure the SET NULL one exists.
alter table generated_work
  drop constraint if exists generated_tasks_workflow_step_id_fkey;

-- The new constraint from 20260515000001 may already exist; if so this is a no-op.
-- Using a safe re-add pattern.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_name = 'generated_work'
      and constraint_name = 'generated_work_workflow_step_id_fkey'
  ) then
    alter table generated_work
      add constraint generated_work_workflow_step_id_fkey
        foreign key (workflow_step_id) references workflow_steps(id) on delete set null;
  end if;
end
$$;
