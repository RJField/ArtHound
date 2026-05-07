import logging
from datetime import datetime, timezone

from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)

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


async def upsert_work(
    owner_type: str,
    owner_id: str,
    source_type: str,
    records: list[dict],
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
            "source_asset_record_id":  r.get("source_asset_record_id"),
            "canonical_asset_id":      r.get("canonical_asset_id"),
            "name":                    r.get("name"),
            "status":                  r.get("status"),
            "estimate":                r.get("estimate"),
            "meta":                    r.get("meta", {}),
            "synced_at":               now,
        }
        for r in records
    ]
    await _upsert("replicated_work", "owner_type,owner_id,source_type,source_record_id", rows)


async def delete_orphaned_records(
    owner_type: str,
    owner_id: str,
    source_type: str,
    fetched_asset_ids: set[str],
    fetched_product_ids: set[str],
    fetched_item_type_ids: set[str],
    full_sync: bool,
    fetched_work_ids: set[str] | None = None,
) -> int:
    """
    Delete rows from replicated tables whose source_record_id is no longer
    present in the source. Called after the write phase of a sync.

    Assets: only checked on full sync — delta fetches only changed records, so
    the fetched set is incomplete and cannot be used for set comparison.

    Products and item_types: always checked — they are always fetched in full
    regardless of sync mode.

    Returns the total number of rows deleted across all tables.
    """
    checks: list[tuple[str, set[str]]] = []
    if full_sync:
        checks.append(("replicated_assets", fetched_asset_ids))
        if fetched_work_ids is not None:
            checks.append(("replicated_work", fetched_work_ids))
    checks.append(("replicated_products", fetched_product_ids))
    checks.append(("replicated_item_types", fetched_item_type_ids))

    base_params = {
        "select":      "source_record_id",
        "owner_type":  f"eq.{owner_type}",
        "owner_id":    f"eq.{owner_id}",
        "source_type": f"eq.{source_type}",
    }

    total_deleted = 0

    for table, fetched_ids in checks:
        r = await db_client.get(
            _url(f"/rest/v1/{table}"),
            params=base_params,
            headers=_headers(),
        )
        r.raise_for_status()
        existing_ids = {row["source_record_id"] for row in r.json()}

        orphaned = existing_ids - fetched_ids
        if not orphaned:
            continue

        del_r = await db_client.delete(
            _url(f"/rest/v1/{table}"),
            params={
                **{k: v for k, v in base_params.items() if k != "select"},
                "source_record_id": f"in.({','.join(orphaned)})",
            },
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if del_r.is_success:
            log.info("Deleted %d orphaned rows from %s for %s/%s", len(orphaned), table, owner_type, owner_id)
            total_deleted += len(orphaned)
        else:
            log.warning("Failed to delete orphans from %s: %s %s", table, del_r.status_code, del_r.text)

    return total_deleted


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
