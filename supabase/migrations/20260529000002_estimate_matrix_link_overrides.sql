-- M-02 / Phase 1: per-link estimate overrides on estimate_matrix (vendor-estimate-share plan §3.3).
--
-- Adds link_id (FK studio_vendor_links): base rows have link_id NULL; override rows set link_id and
-- override estimate_days for a specific (workflow_step_id, variable_values). The effective matrix for
-- a link = base rows overlaid with that link's override rows. workflow_steps / estimate_config stay
-- vendor-global — only rates diverge per link.
--
-- uq_em_owner is recreated to include link_id with NULLS NOT DISTINCT so two base rows (link_id NULL)
-- for the same (owner_key, workflow_step_id, variable_values) still collide. NULLS NOT DISTINCT needs
-- PG15+; dev is PG17 (plan §6.2). on_conflict must list link_id alongside owner_key after this — the
-- matrix routes are updated in lockstep.
--
-- em_link_vendor_only keeps link_id structurally restricted to vendor-owned rows (plan §6.6).
-- Additive / reversible.

begin;

alter table estimate_matrix
  add column if not exists link_id uuid references studio_vendor_links(id);

alter table estimate_matrix add constraint em_link_vendor_only
  check (link_id is null or vendor_id is not null);

-- recreate the owner_key unique to include link_id; NULLS NOT DISTINCT so base rows (link_id null) collide
drop index if exists uq_em_owner;
create unique index uq_em_owner on estimate_matrix
  (owner_key, workflow_step_id, variable_values, link_id) nulls not distinct;

create index if not exists estimate_matrix_link_id_idx
  on estimate_matrix (link_id) where link_id is not null;

commit;
