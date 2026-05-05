import os
from typing import Any
from urllib.parse import quote
import httpx

BASE_URL = "https://api.airtable.com/v0"

# Shared client — reuses TCP+TLS connections across all requests.
# Creating a new AsyncClient per call (the anti-pattern) costs a full TLS
# handshake (~100-200ms) on every Airtable request. This client is closed
# via the FastAPI lifespan in main.py.
http_client = httpx.AsyncClient(
    timeout=30.0,
    limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
)


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


async def select_all(
    table_name: str,
    options: dict = {},
    *,
    token: str | None = None,
    base_id: str | None = None,
) -> list:
    resolved_base_id = base_id or _base_id()
    resolved_headers = {"Authorization": f"Bearer {token}"} if token else _headers()
    table_enc = quote(table_name, safe="")
    records = []
    offset = None

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
        if "cellFormat" in options:
            params.append(("cellFormat", options["cellFormat"]))
        if "timeZone" in options:
            params.append(("timeZone", options["timeZone"]))
        if "userLocale" in options:
            params.append(("userLocale", options["userLocale"]))
        if offset:
            params.append(("offset", offset))

        r = await http_client.get(
            f"{BASE_URL}/{resolved_base_id}/{table_enc}",
            headers=resolved_headers,
            params=params,
        )
        r.raise_for_status()
        data = r.json()
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break

    return records


async def find_record(table_name: str, record_id: str, *, token: str | None = None, base_id: str | None = None) -> dict:
    resolved_base_id = base_id or _base_id()
    resolved_headers = {"Authorization": f"Bearer {token}"} if token else _headers()
    table_enc = quote(table_name, safe="")
    r = await http_client.get(
        f"{BASE_URL}/{resolved_base_id}/{table_enc}/{record_id}",
        headers=resolved_headers,
    )
    r.raise_for_status()
    return r.json()


async def create_records(
    table_name: str,
    fields_list: list[dict],
    *,
    token: str | None = None,
    base_id: str | None = None,
) -> list[dict]:
    resolved_base_id = base_id or _base_id()
    resolved_headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"} if token else {**_headers(), "Content-Type": "application/json"}
    table_enc = quote(table_name, safe="")
    results = []
    for i in range(0, len(fields_list), 10):
        batch = [{"fields": f} for f in fields_list[i : i + 10]]
        r = await http_client.post(
            f"{BASE_URL}/{resolved_base_id}/{table_enc}",
            headers=resolved_headers,
            json={"records": batch},
        )
        r.raise_for_status()
        results.extend(r.json().get("records", []))
    return results


async def fetch_base_schema(token: str, base_id: str) -> list:
    r = await http_client.get(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not r.is_success:
        body = r.json()
        raise ValueError(
            body.get("error", {}).get("message") or f"Schema API returned {r.status_code}"
        )
    return r.json().get("tables", [])


async def update_records(table_name: str, updates: list[dict]) -> list[dict]:
    base_id = _base_id()
    table_enc = quote(table_name, safe="")
    results = []
    for i in range(0, len(updates), 10):
        batch = updates[i : i + 10]
        r = await http_client.patch(
            f"{BASE_URL}/{base_id}/{table_enc}",
            headers={**_headers(), "Content-Type": "application/json"},
            json={"records": batch},
        )
        r.raise_for_status()
        results.extend(r.json().get("records", []))
    return results
