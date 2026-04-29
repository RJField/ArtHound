import os
from typing import Any
from urllib.parse import quote
import httpx

BASE_URL = "https://api.airtable.com/v0"


def _headers() -> dict:
    token = os.environ.get("AIRTABLE_TOKEN")
    if not token:
        raise ValueError("AIRTABLE_TOKEN must be set in .env")
    return {"Authorization": f"Bearer {token}"}


def _base_id() -> str:
    base_id = os.environ.get("AIRTABLE_BASE_ID")
    if not base_id:
        raise ValueError("AIRTABLE_BASE_ID must be set in .env")
    return base_id


async def select_all(table_name: str, options: dict = {}) -> list:
    base_id = _base_id()
    table_enc = quote(table_name, safe="")
    records = []
    offset = None

    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            params: list[tuple[str, Any]] = []
            for field in options.get("fields", []):
                params.append(("fields[]", field))
            for i, s in enumerate(options.get("sort", [])):
                params.append((f"sort[{i}][field]", s["field"]))
                params.append((f"sort[{i}][direction]", s.get("direction", "asc")))
            if "filterByFormula" in options:
                params.append(("filterByFormula", options["filterByFormula"]))
            if "maxRecords" in options:
                params.append(("maxRecords", str(options["maxRecords"])))
            if offset:
                params.append(("offset", offset))

            r = await client.get(
                f"{BASE_URL}/{base_id}/{table_enc}",
                headers=_headers(),
                params=params,
            )
            r.raise_for_status()
            data = r.json()
            records.extend(data.get("records", []))
            offset = data.get("offset")
            if not offset:
                break

    return records


async def find_record(table_name: str, record_id: str) -> dict:
    base_id = _base_id()
    table_enc = quote(table_name, safe="")
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(
            f"{BASE_URL}/{base_id}/{table_enc}/{record_id}",
            headers=_headers(),
        )
        r.raise_for_status()
        return r.json()


async def create_records(table_name: str, fields_list: list[dict]) -> list[dict]:
    base_id = _base_id()
    table_enc = quote(table_name, safe="")
    results = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i in range(0, len(fields_list), 10):
            batch = [{"fields": f} for f in fields_list[i : i + 10]]
            r = await client.post(
                f"{BASE_URL}/{base_id}/{table_enc}",
                headers={**_headers(), "Content-Type": "application/json"},
                json={"records": batch},
            )
            r.raise_for_status()
            results.extend(r.json().get("records", []))
    return results


async def update_records(table_name: str, updates: list[dict]) -> list[dict]:
    base_id = _base_id()
    table_enc = quote(table_name, safe="")
    results = []
    async with httpx.AsyncClient(timeout=30.0) as client:
        for i in range(0, len(updates), 10):
            batch = updates[i : i + 10]
            r = await client.patch(
                f"{BASE_URL}/{base_id}/{table_enc}",
                headers={**_headers(), "Content-Type": "application/json"},
                json={"records": batch},
            )
            r.raise_for_status()
            results.extend(r.json().get("records", []))
    return results
