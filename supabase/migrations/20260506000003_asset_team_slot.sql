-- Add team as a standard slot on replicated_assets.
-- Previously team was read directly from meta["Team (from Product)"], an Airtable-specific
-- hardcoded key. As a proper slot it is populated by the normalizer via source_field_mappings
-- and works across all source connectors.
-- Existing records have team = NULL until re-synced.

ALTER TABLE replicated_assets ADD COLUMN team text;

CREATE INDEX ON replicated_assets (owner_type, owner_id, team);
