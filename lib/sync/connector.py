from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class RawRecord:
    source_record_id: str
    fields: dict
    source_last_modified_at: str | None = None


@dataclass
class SchemaField:
    id: str
    name: str
    type: str
    category: str
    options: dict = field(default_factory=dict)  # full source field options (choices, linkedTableId, etc.)


class BaseConnector(ABC):
    @abstractmethod
    async def fetch_assets(self, since: str | None = None) -> list[RawRecord]: ...

    @abstractmethod
    async def fetch_products(self) -> list[RawRecord]: ...

    @abstractmethod
    async def fetch_item_types(self) -> list[RawRecord]: ...

    @abstractmethod
    async def fetch_asset_schema(self) -> list[SchemaField]: ...

    async def fetch_entity(
        self,
        table_id: str,
        filter_formula: str | None = None,
        since: str | None = None,
        max_records: int | None = None,
        excluded_field_ids: set[str] | None = None,
    ) -> list[RawRecord]:
        """Fetch records from a named entity table with optional filter and delta cursor.

        excluded_field_ids: field names or IDs to strip from returned records (v1:
        client-side; v2 will push this to the API request layer).
        """
        return []

    async def fetch_single_asset(
        self,
        source_record_id: str,
        table_id: str | None = None,
        excluded_field_ids: set[str] | None = None,
    ) -> RawRecord | None:
        """Fetch one asset record by ID. Returns None if not found. Override in subclasses."""
        return None

    def build_entity_filter(self, entity_def: dict) -> str | None:
        """Return a connector-specific filter expression from an entity definition."""
        return None
