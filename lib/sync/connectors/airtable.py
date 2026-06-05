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
_TRANSIENT_STATUS = {429, 500, 502, 503, 504}


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
        self._tables_cache: list[dict] | None = None

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._token}"}

    async def _get(self, url: str, params=None) -> httpx.Response:
        """
        GET with retry/backoff on Airtable rate-limit (429) and transient 5xx,
        mirroring create_record. Returns the response; the caller handles the
        status (so 404 and other non-transient codes stay caller-controlled).
        Raises RuntimeError only after exhausting retries on a transient error.

        Without this, a single 429 from Airtable's rate limiter aborts the whole
        sync at the fetch phase — reads are idempotent, so they retry safely and
        with one more attempt than the write path.
        """
        r = None
        for attempt in range(4):
            if attempt:
                await asyncio.sleep(2 ** attempt)  # 2s, 4s, 8s
            try:
                r = await self._client.get(url, headers=self._headers(), params=params)
            except httpx.TransportError as exc:
                log.warning("Airtable GET network error (attempt %d/4): %s", attempt + 1, exc)
                r = None
                continue
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 10))
                log.warning("Airtable 429 on GET %s — retrying in %ds (attempt %d/4)", url, wait, attempt + 1)
                await asyncio.sleep(wait)
                r = None
                continue
            if r.status_code in _TRANSIENT_STATUS:
                log.warning("Airtable GET %s %s (attempt %d/4): %s", url, r.status_code, attempt + 1, r.text)
                r = None
                continue
            break
        if r is None:
            raise RuntimeError(f"Airtable GET exhausted retries on transient error: {url}")
        return r

    async def _fetch_tables(self) -> list[dict]:
        """
        Fetch and cache the base's table schema (the /meta/bases/{id}/tables
        payload). Cached per connector instance — a single sync calls
        fetch_asset_schema up to 3× (asset + product + item-type name
        resolution); without this cache each call re-hit the meta endpoint,
        multiplying 429 pressure on the exact endpoint that rate-limits first.
        Connectors are built fresh per sync, so the cache never goes stale.
        """
        if self._tables_cache is None:
            r = await self._get(f"{_AT_BASE}/meta/bases/{self._base_id}/tables")
            r.raise_for_status()
            self._tables_cache = r.json().get("tables", [])
        return self._tables_cache

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

            r = await self._get(
                f"{_AT_BASE}/{self._base_id}/{table_enc}",
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
        r = await self._get(
            f"{_AT_BASE}/{self._base_id}/{table_enc}/{source_record_id}",
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

            r = await self._get(
                f"{_AT_BASE}/{self._base_id}/{table_enc}",
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
        tables = await self._fetch_tables()
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
        tables = await self._fetch_tables()
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

    async def create_record(self, table_id: str, fields: dict, qualifier_defaults: dict) -> str:
        """
        Create a record in the given table. Returns the new record ID.

        qualifier_defaults (from lib.sync.qualifiers.airtable_write_defaults) are merged
        under fields so explicit field values always win:
            effective = {**qualifier_defaults, **fields}

        Callers must NOT pre-merge qualifier_defaults into fields — this method is the
        sole merge site. Pass raw fields and the defaults dict separately.
        """
        effective_fields = {**qualifier_defaults, **fields}
        url     = f"{_AT_BASE}/{self._base_id}/{quote(table_id, safe='')}"
        headers = {**self._headers(), "Content-Type": "application/json"}
        payload = {"fields": effective_fields, "typecast": True}
        r = None
        for attempt in range(3):
            if attempt:
                await asyncio.sleep(2 ** attempt)  # 2s, 4s
            try:
                r = await self._client.post(url, headers=headers, json=payload)
            except httpx.TransportError as exc:
                log.warning("Airtable create_record network error (attempt %d/3): %s", attempt + 1, exc)
                r = None
                continue
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", 10))
                log.warning("Airtable 429 on create_record — retrying in %ds (attempt %d)", wait, attempt + 1)
                await asyncio.sleep(wait)
                r = None
                continue
            if r.status_code in _TRANSIENT_STATUS:
                log.warning("Airtable create_record %s (attempt %d/3): %s", r.status_code, attempt + 1, r.text)
                r = None
                continue
            break
        if r is None:
            raise RuntimeError("Airtable create_record: exhausted retries on transient error")
        if r.is_error:
            log.error("Airtable create_record %s — %s %s", r.status_code, r.text, effective_fields)
        r.raise_for_status()
        return r.json()["id"]
