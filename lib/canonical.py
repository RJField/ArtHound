import os
from lib.db import db_client, _url, _headers

# Cached for the lifetime of the process — single-studio setup.
_studio_id: str | None = None


async def get_studio_id() -> str:
    global _studio_id
    if _studio_id:
        return _studio_id

    base_id = os.environ.get("AIRTABLE_BASE_ID")
    if not base_id:
        raise RuntimeError("AIRTABLE_BASE_ID is not set and no studio_id was provided — cannot resolve studio")
    r = await db_client.get(
        _url("/rest/v1/studios"),
        params={"select": "id", "airtable_base_id": f"eq.{base_id}"},
        headers=_headers(),
    )
    rows = r.json()
    if rows:
        _studio_id = rows[0]["id"]
        return _studio_id

    r = await db_client.post(
        _url("/rest/v1/studios"),
        json={"name": "Default Studio", "airtable_base_id": base_id},
        headers=_headers({"Prefer": "return=representation"}),
    )
    _studio_id = r.json()[0]["id"]
    return _studio_id


async def get_or_create_canonical_ids(
    source_record_ids: list[str],
    studio_id: str | None = None,
    source_type: str = "airtable",
) -> dict[str, str]:
    """Returns {source_record_id: canonical_uuid} for the given source IDs.
    Mints new UUIDs for any that don't exist yet. Studio-side only — vendor
    canonical IDs are linked via payload_export_records, not minted here."""
    if not source_record_ids:
        return {}

    if studio_id is None:
        studio_id = await get_studio_id()
    ids_csv = ",".join(source_record_ids)

    # Upsert: insert new rows, silently skip conflicts on existing ones.
    await db_client.post(
        _url("/rest/v1/canonical_assets?on_conflict=studio_id,source_record_id,source_type"),
        json=[
            {"studio_id": studio_id, "source_record_id": rid, "source_type": source_type}
            for rid in source_record_ids
        ],
        headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
    )

    # Fetch all (new + pre-existing) in one query, scoped to this studio + source_type.
    r = await db_client.get(
        _url("/rest/v1/canonical_assets"),
        params={
            "select":            "id,source_record_id",
            "studio_id":         f"eq.{studio_id}",
            "source_type":       f"eq.{source_type}",
            "source_record_id":  f"in.({ids_csv})",
        },
        headers=_headers(),
    )
    return {row["source_record_id"]: row["id"] for row in r.json()}
