import os
from lib.db import db_client, _url, _headers

# Cached for the lifetime of the process — single-studio setup.
_studio_id: str | None = None


async def get_studio_id() -> str:
    global _studio_id
    if _studio_id:
        return _studio_id

    base_id = os.environ["AIRTABLE_BASE_ID"]
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


async def get_or_create_canonical_ids(airtable_ids: list[str], studio_id: str | None = None) -> dict[str, str]:
    """Returns {airtable_record_id: canonical_uuid} for the given Airtable IDs.
    Mints new UUIDs for any that don't exist yet.
    studio_id comes from the authenticated user; falls back to env-based lookup."""
    if not airtable_ids:
        return {}

    if studio_id is None:
        studio_id = await get_studio_id()
    ids_csv = ",".join(airtable_ids)

    # Upsert: inserts new rows, silently ignores conflicts on existing ones.
    await db_client.post(
        _url(f"/rest/v1/canonical_assets?on_conflict=studio_id,airtable_record_id"),
        json=[{"studio_id": studio_id, "airtable_record_id": aid} for aid in airtable_ids],
        headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
    )

    # Fetch all (new + pre-existing) in one query.
    r = await db_client.get(
        _url(f"/rest/v1/canonical_assets?select=id,airtable_record_id&airtable_record_id=in.({ids_csv})"),
        headers=_headers(),
    )
    return {row["airtable_record_id"]: row["id"] for row in r.json()}
