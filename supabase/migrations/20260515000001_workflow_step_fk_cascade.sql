-- Fix generated_work.workflow_step_id FK to use ON DELETE SET NULL
-- Without this, deleting a workflow step fails if any generated work rows reference it.
alter table generated_work
  drop constraint if exists generated_work_workflow_step_id_fkey;

alter table generated_work
  add constraint generated_work_workflow_step_id_fkey
    foreign key (workflow_step_id) references workflow_steps(id) on delete set null;
