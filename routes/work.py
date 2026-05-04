from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Optional

from lib.auth import CurrentUser, get_current_user
from lib.db import db_client, _url, _headers, _user_headers

router = APIRouter()


def _owner(user: CurrentUser) -> tuple[str, str]:
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")
    return owner_type, owner_id


def _fmt_work(row: dict) -> dict:
    return {
        "id":                     row["id"],
        "source_record_id":       row["source_record_id"],
        "source_asset_record_id": row.get("source_asset_record_id"),
        "canonical_asset_id":     row.get("canonical_asset_id"),
        "name":                   row.get("name"),
        "status":                 row.get("status"),
        "estimate":               row.get("estimate"),
        "meta":                   row.get("meta") or {},
        "synced_at":              row.get("synced_at"),
    }


@router.get("/")
async def list_work(
    asset_source_id:    Optional[str] = Query(None),
    canonical_asset_id: Optional[str] = Query(None),
    current_user: CurrentUser = Depends(get_current_user),
):
    owner_type, owner_id = _owner(current_user)

    params: dict = {
        "owner_type":  f"eq.{owner_type}",
        "owner_id":    f"eq.{owner_id}",
        "source_type": "eq.airtable",
        "select":      "id,source_record_id,source_asset_record_id,canonical_asset_id,name,status,estimate,meta,synced_at",
        "order":       "name.asc",
    }

    if asset_source_id:
        params["source_asset_record_id"] = f"eq.{asset_source_id}"
    elif canonical_asset_id:
        params["canonical_asset_id"] = f"eq.{canonical_asset_id}"

    r = await db_client.get(
        _url("/rest/v1/replicated_work"),
        params=params,
        headers=_user_headers(current_user.token),
    )
    r.raise_for_status()
    return [_fmt_work(row) for row in r.json()]


@router.get("/{work_id}")
async def get_work(
    work_id: str,
    current_user: CurrentUser = Depends(get_current_user),
):
    owner_type, owner_id = _owner(current_user)

    r = await db_client.get(
        _url("/rest/v1/replicated_work"),
        params={
            "owner_type":       f"eq.{owner_type}",
            "owner_id":         f"eq.{owner_id}",
            "source_record_id": f"eq.{work_id}",
            "select":           "id,source_record_id,source_asset_record_id,canonical_asset_id,name,status,estimate,meta,synced_at",
        },
        headers=_user_headers(current_user.token),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Work item not found")
    return _fmt_work(rows[0])
