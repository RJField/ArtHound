import asyncio
import logging
from urllib.parse import quote

import httpx

log = logging.getLogger(__name__)

import config
from lib.connectors.adapters.airtable import AIRTABLE_MANIFEST  # noqa: F401 — re-exported
from lib.sync.connector import BaseConnector, RawRecord, SchemaField
from routes.schema import FIELD_CATEGORY

_AT_BASE = "https://api.airtable.com/v0"


def build_filter_formula(filters: list[dict]) -> str | None:
    """
    Convert a stored filters array into an Airtable filterByFormula string.
    Each filter: {field_name, operator ('eq'|'neq'|'contains'), value}
    """
    if not filters:
        return None
    parts = []
    for f in filters:
        name  = f["field_name"]
        op    = f.get("operator", "eq")
        value = f.get("value", "")
        if op == "eq":
            parts.append(f'{{{name}}} = "{value}"')
        elif op == "neq":
            parts.append(f'NOT({{{name}}} = "{value}")')
        elif op == "contains":
            parts.append(f'FIND("{value}", {{{name}}}) > 0')
    if not parts:
        return None
    return f'AND({", ".join(parts)})' if len(parts) > 1 else parts[0]


class AirtableConnector(BaseConnector):
    def __init__(
        self,
        api_token: str,
        base_id: str,
        client: httpx.AsyncClient,
        page_delay_s: float = 0.0,
    ):
        self._token = api_token
        self._base_id = base_id
        self._client = client
        self._page_delay_s = page_delay_s

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
            if self._page_delay_s:
                await asyncio.sleep(self._page_delay_s)
            if not offset:
                break

        return records

    async def fetch_single_asset(
        self,
        source_record_id: str,
        table_id: str | None = None,
        excluded_field_ids: set[str] | None = None,
    ) -> RawRecord | None:
        table = table_id or config.tables["assets"]
        table_enc = quote(table, safe="")
        r = await self._client.get(
            f"{_AT_BASE}/{self._base_id}/{table_enc}/{source_record_id}",
            headers=self._headers(),
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        rec = r.json()
        fields = rec.get("fields", {})
        if excluded_field_ids:
            fields = {k: v for k, v in fields.items() if k not in excluded_field_ids}
        return RawRecord(
            source_record_id=rec["id"],
            fields=fields,
            source_last_modified_at=rec.get("createdTime"),
        )

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

    async def fetch_entity(
        self,
        table_id: str,
        filter_formula: str | None = None,
        since: str | None = None,
        max_records: int | None = None,
        excluded_field_ids: set[str] | None = None,
    ) -> list[RawRecord]:
        """
        Fetch records from any table by ID, with optional formula filter and
        delta-sync cursor. Airtable's records API accepts table IDs in the URL
        interchangeably with table names.

        excluded_field_ids: field names to strip from returned records (v1: client-side
        filter; v2 will use Airtable's fields[] param as a whitelist instead).
        """
        table_enc = quote(table_id, safe="")
        records: list[dict] = []
        offset = None

        while True:
            params: list[tuple] = []
            formula_parts = []
            if since:
                formula_parts.append(f"IS_AFTER(LAST_MODIFIED_TIME(), '{since}')")
            if filter_formula:
                formula_parts.append(filter_formula)
            if formula_parts:
                combined = f'AND({", ".join(formula_parts)})' if len(formula_parts) > 1 else formula_parts[0]
                params.append(("filterByFormula", combined))
            if max_records:
                params.append(("maxRecords", str(max_records)))
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
            if self._page_delay_s:
                await asyncio.sleep(self._page_delay_s)
            if not offset or (max_records and len(records) >= max_records):
                break

        return [
            RawRecord(
                source_record_id=r["id"],
                fields={k: v for k, v in r.get("fields", {}).items()
                        if not excluded_field_ids or k not in excluded_field_ids},
                source_last_modified_at=r.get("createdTime"),
            )
            for r in records
        ]

    async def fetch_base_schema(self) -> list[dict]:
        """
        Return full base schema: all tables with all fields including options.
        Shape: [{id, name, fields: [{id, name, type, category, options}]}]
        """
        r = await self._client.get(
            f"{_AT_BASE}/meta/bases/{self._base_id}/tables",
            headers=self._headers(),
        )
        r.raise_for_status()
        tables = r.json().get("tables", [])
        return [
            {
                "id":     t["id"],
                "name":   t["name"],
                "fields": [
                    {
                        "id":       f["id"],
                        "name":     f["name"],
                        "type":     f["type"],
                        "category": FIELD_CATEGORY.get(f["type"], "other"),
                        "options":  f.get("options") or {},
                    }
                    for f in t.get("fields", [])
                ],
            }
            for t in tables
        ]

    def build_entity_filter(self, entity_def: dict) -> str | None:
        return build_filter_formula(entity_def.get("filters") or []) if entity_def else None

    async def fetch_asset_schema(self, table_id: str | None = None) -> list[SchemaField]:
        """
        Return schema fields for the asset table. When table_id is given, looks
        up by ID (entity-definition path); otherwise falls back to config.tables["assets"] by name.
        """
        r = await self._client.get(
            f"{_AT_BASE}/meta/bases/{self._base_id}/tables",
            headers=self._headers(),
        )
        r.raise_for_status()
        tables = r.json().get("tables", [])
        if table_id:
            target = next((t for t in tables if t["id"] == table_id), None)
        else:
            asset_table = config.tables["assets"]
            target = next((t for t in tables if t["name"] == asset_table), None)
        if not target:
            return []
        return [
            SchemaField(
                id=f["id"],
                name=f["name"],
                type=f["type"],
                category=FIELD_CATEGORY.get(f["type"], "other"),
                options=f.get("options") or {},
            )
            for f in target.get("fields", [])
        ]

    async def create_record(self, table_id: str, fields: dict) -> str:
        """Create a record in the given table. Returns the new record ID."""
        r = await self._client.post(
            f"{_AT_BASE}/{self._base_id}/{quote(table_id, safe='')}",
            headers={**self._headers(), "Content-Type": "application/json"},
            json={"fields": fields, "typecast": True},
        )
        if r.is_error:
            log.error("Airtable create_record %s — %s %s", r.status_code, r.text, fields)
        r.raise_for_status()
        return r.json()["id"]
