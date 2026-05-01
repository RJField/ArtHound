from datetime import datetime, timezone

from lib.db import db_client, _url, _headers

_BATCH = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _upsert(table: str, on_conflict: str, rows: list[dict]) -> None:
    for i in range(0, len(rows), _BATCH):
        batch = rows[i : i + _BATCH]
        r = await db_client.post(
            _url(f"/rest/v1/{table}?on_conflict={on_conflict}"),
            headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            json=batch,
        )
        r.raise_for_status()


async def load_existing_hashes(
    owner_type: str, owner_id: str, source_type: str
) -> dict[str, str]:
    """Fetch {source_record_id: source_hash} for existing rows — used by the differ."""
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "select": "source_record_id,source_hash",
            "owner_type": f"eq.{owner_type}",
            "owner_id": f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return {row["source_record_id"]: row["source_hash"] for row in r.json()}


async def upsert_assets(
    owner_type: str,
    owner_id: str,
    source_type: str,
    records: list[dict],
    canonical_map: dict[str, str] | None = None,
) -> None:
    if not records:
        return

    now = _now()
    rows = [
        {
            "owner_type":              owner_type,
            "owner_id":                owner_id,
            "source_type":             source_type,
            "source_record_id":        r["source_record_id"],
            "source_last_modified_at": r.get("source_last_modified_at"),
            "source_hash":             r.get("source_hash"),
            "canonical_asset_id":      (canonical_map or {}).get(r["source_record_id"]),
            "name":                    r.get("name"),
            "dev_name":                r.get("dev_name"),
            "item_type":               r.get("item_type"),
            "priority":                r.get("priority"),
            "product":                 r.get("product"),
            "project_date":            r.get("project_date"),
            "status":                  r.get("status"),
            "asset_number":            r.get("asset_number"),
            "meta":                    r.get("meta", {}),
            "synced_at":               now,
        }
        for r in records
    ]

    await _upsert(
        "replicated_assets",
        "owner_type,owner_id,source_type,source_record_id",
        rows,
    )


async def upsert_products(
    owner_type: str, owner_id: str, source_type: str, records: list[dict]
) -> None:
    if not records:
        return
    now = _now()
    rows = [
        {
            "owner_type":       owner_type,
            "owner_id":         owner_id,
            "source_type":      source_type,
            "source_record_id": r["source_record_id"],
            "name":             r.get("name", ""),
            "meta":             r.get("meta", {}),
            "synced_at":        now,
        }
        for r in records
    ]
    await _upsert("replicated_products", "owner_type,owner_id,source_type,source_record_id", rows)


async def upsert_item_types(
    owner_type: str, owner_id: str, source_type: str, records: list[dict]
) -> None:
    if not records:
        return
    now = _now()
    rows = [
        {
            "owner_type":       owner_type,
            "owner_id":         owner_id,
            "source_type":      source_type,
            "source_record_id": r["source_record_id"],
            "name":             r.get("name", ""),
            "meta":             r.get("meta", {}),
            "synced_at":        now,
        }
        for r in records
    ]
    await _upsert("replicated_item_types", "owner_type,owner_id,source_type,source_record_id", rows)


async def save_default_mappings(
    owner_type: str, owner_id: str, source_type: str, mappings: list[dict]
) -> None:
    await _upsert(
        "source_field_mappings",
        "owner_type,owner_id,source_type",
        [{
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": source_type,
            "mappings":    mappings,
            "updated_at":  _now(),
        }],
    )
