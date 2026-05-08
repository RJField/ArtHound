# Canonical Identity Layer

## Purpose

Every asset in ArtHound has a stable internal UUID (`canonical_assets.id`) that is independent of the source tool it came from. This means features built on top of ArtHound — schedules, reviews, dispatched payloads — reference an identity that survives source-tool migrations.

If a studio moves from Airtable to Jira, the Airtable record IDs change. The canonical UUID does not. All downstream data remains intact.

## Schema

```sql
-- migrations/001_canonical_layer.sql

canonical_assets (
  id                 uuid primary key   -- stable ArtHound identity
  studio_id          uuid not null      -- owning studio
  airtable_record_id text not null      -- source tool record ID
  created_at         timestamptz

  unique(studio_id, airtable_record_id)
)
```

The `airtable_record_id` column is named for the current source tool. When additional connectors are added (Jira, ShotGrid), a `source_type` column and a composite unique constraint on `(studio_id, source_type, source_record_id)` will replace the current single-column constraint. The UUID column itself requires no migration.

## Where canonical IDs appear

| Table | Column | Role |
|---|---|---|
| `replicated_assets` | `canonical_asset_id` | Links a synced asset row to its stable identity |
| `payload_dispatches` | `asset_id` | Payload is permanently tied to canonical UUID, not source record ID |
| `generated_tasks` | `canonical_asset_id` | Task snapshots reference canonical ID, not Airtable ID |
| `payload_data` (jsonb) | `asset_global_id` | Self-describing field in frozen snapshots |

## Minting flow

Canonical IDs are minted during sync, in `lib/canonical.py`.

```
sync → get_or_create_canonical_ids(airtable_ids, studio_id)
       ├─ upsert canonical_assets rows (on_conflict = ignore-duplicates)
       └─ return {airtable_record_id → canonical_uuid} map
```

The upsert is idempotent. Running it twice for the same asset produces one row. The returned map is used immediately to populate `replicated_assets.canonical_asset_id` on the same sync pass.

**Entry point:** [`lib/canonical.py:33`](../lib/canonical.py#L33) — `get_or_create_canonical_ids()`

## Key invariants

- A canonical UUID is minted **once** and never changed or reused.
- Canonical rows are **never deleted**, even if the source record is deleted. Downstream tables (generated_tasks, payload_dispatches) hold foreign keys against canonical IDs — hard deletion would violate referential integrity.
- The canonical layer is **studio-scoped**. Two studios can have assets that happen to share the same Airtable record ID without collision because the `UNIQUE` constraint is on `(studio_id, airtable_record_id)`.
- Canonical IDs are only minted for studio-owned assets. Vendors receive canonical IDs via dispatched payloads (the `asset_global_id` field), but do not mint their own.

## What changes when a new source connector is added

1. Add a `source_type` column to `canonical_assets` with a default of `'airtable'` for existing rows.
2. Change the unique constraint from `(studio_id, airtable_record_id)` to `(studio_id, source_type, source_record_id)`.
3. Rename `airtable_record_id` to `source_record_id` (or add a new column and backfill).
4. Update `get_or_create_canonical_ids()` to accept a `source_type` parameter.

No other tables need to change. All foreign keys are against `canonical_assets.id`, which is unaffected.
