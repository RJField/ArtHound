-- 20260509000003_schema_renames.sql
-- P2 schema shape fixes:
--   1. canonical_assets.airtable_record_id → source_record_id + source_type column
--   2. replicated_work.estimate text → numeric (can now aggregate)
--   3. replicated_assets.priority int → text (Airtable/Jira priorities are strings)

begin;


-- ── 1. canonical_assets: rename + add source_type ────────────────────────────

alter table canonical_assets rename column airtable_record_id to source_record_id;

alter table canonical_assets add column if not exists source_type text;

-- Backfill from replicated_assets (all rows for a canonical_id share the same source_type)
update canonical_assets ca
set source_type = ra.source_type
from (
    select distinct on (canonical_asset_id)
        canonical_asset_id, source_type
    from replicated_assets
    where canonical_asset_id is not null
    order by canonical_asset_id
) ra
where ra.canonical_asset_id = ca.id
  and ca.source_type is null;

-- Any remaining rows (no replicated_assets yet) are Airtable-origin
update canonical_assets set source_type = 'airtable' where source_type is null;

alter table canonical_assets alter column source_type set not null;

-- Rebuild unique constraint: include source_type to prevent false matches on
-- source migration (Jira key could collide with a legacy Airtable record ID)
alter table canonical_assets
    drop constraint if exists canonical_assets_studio_id_airtable_record_id_key;
alter table canonical_assets
    add constraint canonical_assets_studio_source_unique
    unique (studio_id, source_record_id, source_type);

-- Rebuild index on new column name
drop index if exists canonical_assets_airtable_record_id_idx;
create index if not exists canonical_assets_source_record_id_idx
    on canonical_assets (source_record_id);


-- ── 2. replicated_work.estimate: text → numeric ──────────────────────────────
-- NULLIF handles empty strings; non-numeric values become NULL rather than error.

-- NULL out any values that can't cast to numeric.
-- Cast to text explicitly so this is safe whether the column is still text or already numeric.
update replicated_work
set estimate = null
where estimate::text is not null
  and (trim(estimate::text) = '' or estimate::text !~ '^-?[0-9]*\.?[0-9]+$');

alter table replicated_work
    alter column estimate type numeric
    using estimate::text::numeric;


-- ── 3. replicated_assets.priority: int → text ────────────────────────────────
-- Airtable and Jira priorities are strings ("P4", "High", etc.).
-- Non-numeric values were silently NULLed before; text column preserves them.

alter table replicated_assets
    alter column priority type text
    using priority::text;


commit;
