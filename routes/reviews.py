from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers

router = APIRouter()


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _fetch_asset_meta(studio_id: str, canonical_asset_ids: list[str]) -> dict:
    if not canonical_asset_ids:
        return {}
    ids_csv = ",".join(canonical_asset_ids)
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "select": "canonical_asset_id,name,item_type,priority,product,status",
            "owner_type": "eq.studio",
            "owner_id": f"eq.{studio_id}",
            "canonical_asset_id": f"in.({ids_csv})",
        },
        headers=_headers(),
    )
    if not r.is_success:
        return {}
    return {row["canonical_asset_id"]: row for row in r.json()}


async def _enrich(reviews: list[dict], studio_id: str) -> list[dict]:
    if not reviews:
        return []
    asset_ids = list({rv["canonical_asset_id"] for rv in reviews})
    meta = await _fetch_asset_meta(studio_id, asset_ids)
    return [{**rv, "asset": meta.get(rv["canonical_asset_id"])} for rv in reviews]


def _require_studio_id(user: CurrentUser) -> str:
    if not user.studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this account")
    return user.studio_id


# ── Models ─────────────────────────────────────────────────────────────────────

class ReviewCreate(BaseModel):
    canonical_asset_id: str
    source_record_id: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


class StatusUpdate(BaseModel):
    status: Optional[str] = None


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/assets")
async def list_assets_for_picker(user: CurrentUser = Depends(require_studio)):
    """Return canonical assets with replicated names for the create-review picker."""
    studio_id = _require_studio_id(user)

    r = await db_client.get(
        _url("/rest/v1/canonical_assets"),
        params={
            "select": "id,airtable_record_id",
            "studio_id": f"eq.{studio_id}",
            "order": "created_at.asc",
        },
        headers=_headers(),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch assets")

    canonical = r.json()
    if not canonical:
        return []

    ids_csv = ",".join(a["id"] for a in canonical)
    r2 = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "select": "canonical_asset_id,name,source_record_id",
            "owner_type": "eq.studio",
            "owner_id": f"eq.{studio_id}",
            "canonical_asset_id": f"in.({ids_csv})",
        },
        headers=_headers(),
    )

    name_map: dict = {}
    source_map: dict = {}
    if r2.is_success:
        for row in r2.json():
            name_map[row["canonical_asset_id"]] = row.get("name", "")
            source_map[row["canonical_asset_id"]] = row.get("source_record_id", "")

    return [
        {
            "id": a["id"],
            "name": name_map.get(a["id"]) or a.get("airtable_record_id", a["id"]),
            "source_record_id": source_map.get(a["id"]) or a.get("airtable_record_id"),
        }
        for a in canonical
    ]


@router.get("")
@router.get("/")
async def list_reviews(
    canonicalAssetId: Optional[str] = Query(None),
    user: CurrentUser = Depends(require_studio),
):
    studio_id = _require_studio_id(user)

    params: dict = {
        "select":     "*",
        "studio_id":  f"eq.{studio_id}",
        "order":      "created_at.desc",
    }
    if canonicalAssetId:
        params["canonical_asset_id"] = f"eq.{canonicalAssetId}"

    r = await db_client.get(
        _url("/rest/v1/asset_reviews"),
        params=params,
        headers=_headers(),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch reviews")

    return await _enrich(r.json(), studio_id)


@router.post("")
async def create_review(body: ReviewCreate, user: CurrentUser = Depends(require_studio)):
    studio_id = _require_studio_id(user)

    # Verify the canonical_asset belongs to this studio — prevents cross-studio writes.
    check = await db_client.get(
        _url("/rest/v1/canonical_assets"),
        params={
            "select": "id",
            "id": f"eq.{body.canonical_asset_id}",
            "studio_id": f"eq.{studio_id}",
        },
        headers=_headers(),
    )
    if not check.is_success or not check.json():
        raise HTTPException(status_code=404, detail="Asset not found in this studio")

    r = await db_client.post(
        _url("/rest/v1/asset_reviews"),
        json={
            "studio_id": studio_id,
            "canonical_asset_id": body.canonical_asset_id,
            "source_record_id": body.source_record_id or None,
            "description": body.description or None,
            "status": body.status or None,
            "created_by_email": user.email,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to create review")

    rows = r.json()
    if not rows:
        raise HTTPException(status_code=502, detail="Review created but not returned")

    enriched = await _enrich([rows[0]], studio_id)
    return enriched[0]


@router.get("/{review_id}")
async def get_review(review_id: str, user: CurrentUser = Depends(require_studio)):
    studio_id = _require_studio_id(user)

    r = await db_client.get(
        _url("/rest/v1/asset_reviews"),
        params={
            "select": "*",
            "id": f"eq.{review_id}",
            "studio_id": f"eq.{studio_id}",
        },
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Review not found")

    enriched = await _enrich([r.json()[0]], studio_id)
    return enriched[0]


@router.patch("/{review_id}/status")
async def update_review_status(
    review_id: str, body: StatusUpdate, user: CurrentUser = Depends(require_studio)
):
    studio_id = _require_studio_id(user)

    r = await db_client.patch(
        _url("/rest/v1/asset_reviews"),
        params={
            "id": f"eq.{review_id}",
            "studio_id": f"eq.{studio_id}",
        },
        json={"status": body.status or None},
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to update status")
    if not r.json():
        raise HTTPException(status_code=404, detail="Review not found")
    return {"ok": True}


@router.delete("/{review_id}")
async def delete_review(review_id: str, user: CurrentUser = Depends(require_studio)):
    studio_id = _require_studio_id(user)

    # Filter by both studio_id and created_by_email — only the creator can delete.
    r = await db_client.delete(
        _url("/rest/v1/asset_reviews"),
        params={
            "id": f"eq.{review_id}",
            "studio_id": f"eq.{studio_id}",
            "created_by_email": f"eq.{user.email}",
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to delete review")
    if not r.json():
        raise HTTPException(status_code=404, detail="Review not found or you are not the creator")
    return {"ok": True}
