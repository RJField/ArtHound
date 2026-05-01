from urllib.parse import quote

import httpx

import config
from lib.connectors.adapters.airtable import AIRTABLE_MANIFEST  # noqa: F401 — re-exported
from lib.sync.connector import BaseConnector, RawRecord, SchemaField
from routes.schema import FIELD_CATEGORY

_AT_BASE = "https://api.airtable.com/v0"


class AirtableConnector(BaseConnector):
    def __init__(self, api_token: str, base_id: str, client: httpx.AsyncClient):
        self._token = api_token
        self._base_id = base_id
        self._client = client

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._token}"}

    async def _select_all(self, table_name: str, since: str | None = None) -> list[dict]:
        table_enc = quote(table_name, safe="")
        records: list[dict] = []
        offset = None

        while True:
            params: list[tuple] = []
            if since:
                params.append(("filterByFormula", f"IS_AFTER(LAST_MODIFIED_TIME(), '{since}')"))
            if offset:
                params.append(("offset", offset))

            r = await self._client.get(
                f"{_AT_BASE}/{self._base_id}/{table_enc}",
                headers=self._headers(),
                params=params,
            )
            r.raise_for_status()
            data = r.json()
            records.extend(data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break

        return records

    async def fetch_assets(self, since: str | None = None) -> list[RawRecord]:
        records = await self._select_all(config.tables["assets"], since)
        return [
            RawRecord(
                source_record_id=r["id"],
                fields=r.get("fields", {}),
                source_last_modified_at=r.get("createdTime"),
            )
            for r in records
        ]

    async def fetch_products(self) -> list[RawRecord]:
        records = await self._select_all(config.tables["products"])
        return [
            RawRecord(source_record_id=r["id"], fields=r.get("fields", {}))
            for r in records
        ]

    async def fetch_item_types(self) -> list[RawRecord]:
        records = await self._select_all(config.tables["itemTypes"])
        return [
            RawRecord(source_record_id=r["id"], fields=r.get("fields", {}))
            for r in records
        ]

    async def fetch_asset_schema(self) -> list[SchemaField]:
        r = await self._client.get(
            f"{_AT_BASE}/meta/bases/{self._base_id}/tables",
            headers=self._headers(),
        )
        r.raise_for_status()
        tables = r.json().get("tables", [])
        asset_table = config.tables["assets"]
        for table in tables:
            if table["name"] == asset_table:
                return [
                    SchemaField(
                        id=f["id"],
                        name=f["name"],
                        type=f["type"],
                        category=FIELD_CATEGORY.get(f["type"], "other"),
                    )
                    for f in table.get("fields", [])
                ]
        return []
