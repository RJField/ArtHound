from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class EntitySpec:
    arthound_concept: str   # "asset" | "product" | "item_type" | "team"
    delta_field: str        # field used for change detection in the source system
    supabase_table: str     # destination table in Supabase
    depends_on: list[str] = field(default_factory=list)  # concepts that must sync first


@dataclass
class ConnectorManifest:
    connector_type: str                  # "airtable" | "jira" | "shotgrid"
    primary_entities: list[EntitySpec]   # the core asset-like records features read from
    reference_entities: list[EntitySpec] # lookup tables that primary entities link to
    write_support: bool = False

    def sync_order(self) -> list[EntitySpec]:
        """Reference entities first, then primary — always dependency-safe."""
        return self.reference_entities + self.primary_entities
