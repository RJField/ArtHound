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


class BaseConnector(ABC):
    @abstractmethod
    async def fetch_assets(self, since: str | None = None) -> list[RawRecord]: ...

    @abstractmethod
    async def fetch_products(self) -> list[RawRecord]: ...

    @abstractmethod
    async def fetch_item_types(self) -> list[RawRecord]: ...

    @abstractmethod
    async def fetch_asset_schema(self) -> list[SchemaField]: ...
