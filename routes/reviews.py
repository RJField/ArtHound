import logging
import os
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lib.attachments import _storage_api_url, _storage_headers
from lib.auth import CurrentUser, get_current_user
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()

_BUCKET = "attachments"
_REVIEW_PREFIX = "reviews"


# ── Auth helpers ──────────────────────────────────────────────────────────────

def _resolve_org(user: CurrentUser) -> tuple[str, str]:
    """Returns (author_org_type, author_org_id). Raises 403 if no org linked."""
    if user.role == "studio":
        if not user.studio_id:
            raise HTTPException(status_code=403, detail="No studio linked to this account")
        return "studio", user.studio_id
    if user.role == "vendor":
        if not user.vendor_id:
            raise HTTPException(status_code=403, detail="No vendor linked to this account")
        return "vendor", user.vendor_id
    raise HTTPException(status_code=403, detail="Unknown role")


def _require_studio_id(user: CurrentUser) -> str:
    if not user.studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this account")
    return user.studio_id


# ── Meta enrichment ───────────────────────────────────────────────────────────

async def _fetch_studio_asset_meta(studio_id: str, canonical_asset_ids: list[str]) -> dict:
    if not canonical_asset_ids:
        return {}
    ids_csv = ",".join(canonical_asset_ids)
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "select": "canonical_asset_id,name,product,source_type,source_record_id,meta",
            "owner_type": "eq.studio",
            "owner_id": f"eq.{studio_id}",
            "canonical_asset_id": f"in.({ids_csv})",
        },
        headers=_headers(),
    )
    if not r.is_success:
        return {}
    return {row["canonical_asset_id"]: row for row in r.json()}


async def _fetch_vendor_asset_meta(vendor_id: str, canonical_asset_ids: list[str]) -> dict:
    """Resolve asset meta from the vendor's received (non-revoked) dispatches."""
    if not canonical_asset_ids:
        return {}
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "recipient_vendor_id": f"eq.{vendor_id}",
            "revoked_at": "is.null",
            "select": "payload_data",
        },
        headers=_headers(),
    )
    if not r.is_success:
        return {}

    meta: dict = {}
    target_set = set(canonical_asset_ids)
    for dispatch in r.json():
        pd = dispatch.get("payload_data") or {}
        # Multi-asset dispatch shape
        for asset_entry in (pd.get("assets") or []):
            aid = asset_entry.get("asset_global_id")
            if aid and aid in target_set and aid not in meta:
                meta[aid] = {
                    "canonical_asset_id": aid,
                    "name": asset_entry.get("name") or asset_entry.get("data", {}).get("Name"),
                    "meta": asset_entry.get("data") or {},
                    "_source": "payload",
                }
        # Single-asset dispatch shape
        single_id = pd.get("asset_global_id")
        if single_id and single_id in target_set and single_id not in meta:
            meta[single_id] = {
                "canonical_asset_id": single_id,
                "name": pd.get("name") or (pd.get("data") or {}).get("Name"),
                "meta": pd.get("data") or {},
                "_source": "payload",
            }
    return meta


async def _enrich(reviews: list[dict], user: CurrentUser) -> list[dict]:
    if not reviews:
        return []
    asset_ids = list({rv["canonical_asset_id"] for rv in reviews})
    if user.role == "studio" and user.studio_id:
        meta = await _fetch_studio_asset_meta(user.studio_id, asset_ids)
    elif user.role == "vendor" and user.vendor_id:
        meta = await _fetch_vendor_asset_meta(user.vendor_id, asset_ids)
    else:
        meta = {}
    return [{**rv, "asset": meta.get(rv["canonical_asset_id"])} for rv in reviews]


# ── Storage helpers ───────────────────────────────────────────────────────────

def _review_storage_path(review_id: str, filename: str) -> str:
    safe = filename.replace("/", "_").replace("..", "_")
    return f"{_REVIEW_PREFIX}/{review_id}/{uuid.uuid4().hex}_{safe}"


async def _storage_upload_review(path: str, data: bytes, content_type: str) -> None:
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            _storage_api_url(f"/object/{_BUCKET}/{path}"),
            headers=_storage_headers({"Content-Type": content_type, "x-upsert": "true"}),
            content=data,
        )
        if not r.is_success:
            # Storage API puts the real reason (e.g. "Bucket not found") in the body;
            # raise_for_status() alone would drop it from the error log.
            raise RuntimeError(f"storage upload {r.status_code}: {r.text[:300]}")


async def _storage_delete(path: str) -> None:
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.delete(
            _storage_api_url(f"/object/{_BUCKET}"),
            headers=_storage_headers({"Content-Type": "application/json"}),
            json={"prefixes": [path]},
        )
        r.raise_for_status()


# ── Models ────────────────────────────────────────────────────────────────────

class ReviewCreate(BaseModel):
    canonical_asset_id: str
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


class ReviewUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


# ── Asset picker endpoint ─────────────────────────────────────────────────────

@router.get("/assets")
async def list_assets_for_picker(user: CurrentUser = Depends(get_current_user)):
    """Assets available to create a review against — studio or vendor."""
    if user.role == "studio":
        return await _studio_assets(user)
    if user.role == "vendor":
        return await _vendor_assets(user)
    raise HTTPException(status_code=403)


async def _studio_assets(user: CurrentUser) -> list[dict]:
    studio_id = _require_studio_id(user)
    r = await db_client.get(
        _url("/rest/v1/canonical_assets"),
        params={
            "select": "id,source_record_id",
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
            "select": "canonical_asset_id,name,source_record_id,source_type,meta",
            "owner_type": "eq.studio",
            "owner_id": f"eq.{studio_id}",
            "canonical_asset_id": f"in.({ids_csv})",
        },
        headers=_headers(),
    )

    name_map: dict = {}
    source_key_map: dict = {}
    if r2.is_success:
        for row in r2.json():
            cid = row["canonical_asset_id"]
            name_map[cid] = row.get("name", "")
            st = row.get("source_type", "airtable")
            meta = row.get("meta") or {}
            source_key_map[cid] = (
                meta.get("_jira_key") or row.get("source_record_id", "")
                if st == "jira"
                else row.get("source_record_id", "")
            )

    return [
        {
            "id": a["id"],
            "name": name_map.get(a["id"]) or a.get("source_record_id", a["id"]),
            "source_key": source_key_map.get(a["id"]) or a.get("source_record_id"),
        }
        for a in canonical
    ]


async def _vendor_assets(user: CurrentUser) -> list[dict]:
    if not user.vendor_id:
        raise HTTPException(status_code=403, detail="No vendor linked to this account")
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "recipient_vendor_id": f"eq.{user.vendor_id}",
            "revoked_at": "is.null",
            "select": "payload_data",
        },
        headers=_headers(),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch dispatches")

    seen: dict = {}
    for dispatch in r.json():
        pd = dispatch.get("payload_data") or {}
        for asset_entry in (pd.get("assets") or []):
            aid = asset_entry.get("asset_global_id")
            if aid and aid not in seen:
                seen[aid] = asset_entry.get("name") or (asset_entry.get("data") or {}).get("Name") or aid
        single_id = pd.get("asset_global_id")
        if single_id and single_id not in seen:
            seen[single_id] = pd.get("name") or (pd.get("data") or {}).get("Name") or single_id

    return [{"id": aid, "name": name} for aid, name in seen.items()]


# ── Review CRUD ───────────────────────────────────────────────────────────────

@router.get("")
@router.get("/")
async def list_reviews(
    canonicalAssetId: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    org_type, org_id = _resolve_org(user)

    params: dict = {
        "select": "*",
        "author_org_type": f"eq.{org_type}",
        "author_org_id": f"eq.{org_id}",
        "order": "created_at.desc",
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

    return await _enrich(r.json(), user)


@router.post("")
async def create_review(body: ReviewCreate, user: CurrentUser = Depends(get_current_user)):
    org_type, org_id = _resolve_org(user)

    # Verify asset ownership
    if org_type == "studio":
        check = await db_client.get(
            _url("/rest/v1/canonical_assets"),
            params={
                "select": "id,studio_id",
                "id": f"eq.{body.canonical_asset_id}",
                "studio_id": f"eq.{user.studio_id}",
            },
            headers=_headers(),
        )
        if not check.is_success or not check.json():
            raise HTTPException(status_code=404, detail="Asset not found in this studio")
        studio_id = user.studio_id
    else:
        # Vendor: confirm the asset exists in one of their dispatches
        check = await _vendor_assets(user)
        if not any(a["id"] == body.canonical_asset_id for a in check):
            raise HTTPException(status_code=404, detail="Asset not found in your received payloads")
        # Resolve the studio that owns this canonical asset
        ca_r = await db_client.get(
            _url("/rest/v1/canonical_assets"),
            params={"select": "studio_id", "id": f"eq.{body.canonical_asset_id}"},
            headers=_headers(),
        )
        if not ca_r.is_success or not ca_r.json():
            raise HTTPException(status_code=404, detail="Asset not found")
        studio_id = ca_r.json()[0]["studio_id"]

    r = await db_client.post(
        _url("/rest/v1/asset_reviews"),
        json={
            "studio_id": studio_id,
            "canonical_asset_id": body.canonical_asset_id,
            "author_org_type": org_type,
            "author_org_id": org_id,
            "title": body.title or None,
            "description": body.description or None,
            "status": body.status or None,
            "created_by_email": user.email,
            "created_by_user_id": user.id,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to create review")

    rows = r.json()
    if not rows:
        raise HTTPException(status_code=502, detail="Review created but not returned")

    enriched = await _enrich([rows[0]], user)
    return enriched[0]


@router.get("/{review_id}")
async def get_review(review_id: str, user: CurrentUser = Depends(get_current_user)):
    org_type, org_id = _resolve_org(user)
    review = await _fetch_review(review_id, org_type, org_id)
    enriched = await _enrich([review], user)
    return enriched[0]


@router.patch("/{review_id}")
async def update_review(
    review_id: str, body: ReviewUpdate, user: CurrentUser = Depends(get_current_user)
):
    org_type, org_id = _resolve_org(user)
    await _fetch_review(review_id, org_type, org_id)  # ownership check

    patch: dict = {}
    if body.title is not None:
        patch["title"] = body.title or None
    if body.description is not None:
        patch["description"] = body.description or None
    if body.status is not None:
        patch["status"] = body.status or None

    if patch:
        from datetime import datetime, timezone
        patch["updated_at"] = datetime.now(timezone.utc).isoformat()
        r = await db_client.patch(
            _url("/rest/v1/asset_reviews"),
            params={"id": f"eq.{review_id}", "author_org_type": f"eq.{org_type}", "author_org_id": f"eq.{org_id}"},
            json=patch,
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if not r.is_success:
            raise HTTPException(status_code=502, detail="Failed to update review")
    return {"ok": True}


@router.delete("/{review_id}")
async def delete_review(review_id: str, user: CurrentUser = Depends(get_current_user)):
    org_type, org_id = _resolve_org(user)

    r = await db_client.delete(
        _url("/rest/v1/asset_reviews"),
        params={
            "id": f"eq.{review_id}",
            "author_org_type": f"eq.{org_type}",
            "author_org_id": f"eq.{org_id}",
            "created_by_email": f"eq.{user.email}",
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to delete review")
    if not r.json():
        raise HTTPException(status_code=404, detail="Review not found or you are not the creator")
    return {"ok": True}


# ── Attachment CRUD ───────────────────────────────────────────────────────────

@router.get("/{review_id}/attachments")
async def list_attachments(review_id: str, user: CurrentUser = Depends(get_current_user)):
    org_type, org_id = _resolve_org(user)
    await _fetch_review(review_id, org_type, org_id)

    r = await db_client.get(
        _url("/rest/v1/review_attachments"),
        params={
            "select": "id,filename,content_type,file_size,storage_path,uploaded_by,created_at",
            "review_id": f"eq.{review_id}",
            "order": "created_at.asc",
        },
        headers=_headers(),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch attachments")
    return r.json()


@router.post("/{review_id}/attachments")
async def upload_attachment(
    review_id: str,
    file: UploadFile = File(...),
    user: CurrentUser = Depends(get_current_user),
):
    # §7 STORAGE GATE (write side): authorize via a user-context review read (RLS `ar_sel`) BEFORE
    # uploading any bytes — a caller who can't see the review can't attach to it.
    org_type, org_id = _resolve_org(user)
    review = await _fetch_review(review_id, org_type, org_id)

    data = await file.read()
    if len(data) > 100 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 100 MB)")

    content_type = file.content_type or "application/octet-stream"
    storage_path = _review_storage_path(review_id, file.filename or "upload")

    try:
        await _storage_upload_review(storage_path, data, content_type)
    except Exception as exc:
        log.error("review attachment upload failed review=%s: %s", review_id, exc)
        raise HTTPException(status_code=502, detail="Storage upload failed")

    r = await db_client.post(
        _url("/rest/v1/review_attachments"),
        json={
            "review_id": review_id,
            "studio_id": review["studio_id"],
            "author_org_type": org_type,
            "author_org_id": org_id,
            "filename": file.filename or "upload",
            "storage_path": storage_path,
            "content_type": content_type,
            "file_size": len(data),
            "uploaded_by": user.email,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=502, detail="Failed to save attachment record")
    return r.json()[0]


@router.get("/{review_id}/attachments/{attachment_id}/content")
async def serve_attachment(
    review_id: str,
    attachment_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    # §7 STORAGE GATE: two user-context reads authorize the byte stream below. `_fetch_review` (RLS
    # `ar_sel`) hides a review the caller's org can't see; the review_attachments read (RLS `rat_sel`)
    # hides the attachment row. Either invisible → 404 before any blob is fetched. Both run as the
    # caller (`_headers()`); the byte stream itself is the §0c service-role carve-out.
    org_type, org_id = _resolve_org(user)
    await _fetch_review(review_id, org_type, org_id)

    r = await db_client.get(
        _url("/rest/v1/review_attachments"),
        params={
            "select": "storage_path,filename,content_type",
            "id": f"eq.{attachment_id}",
            "review_id": f"eq.{review_id}",
        },
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Attachment not found")

    att = r.json()[0]
    storage_url = _storage_api_url(f"/object/{_BUCKET}/{att['storage_path']}")

    async def stream():
        async with httpx.AsyncClient(timeout=120.0) as client:
            async with client.stream(
                "GET", storage_url, headers=_storage_headers()
            ) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(65536):
                    yield chunk

    return StreamingResponse(
        stream(),
        media_type=att.get("content_type") or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{att["filename"]}"'},
    )


@router.delete("/{review_id}/attachments/{attachment_id}")
async def delete_attachment(
    review_id: str,
    attachment_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    org_type, org_id = _resolve_org(user)
    await _fetch_review(review_id, org_type, org_id)

    r = await db_client.get(
        _url("/rest/v1/review_attachments"),
        params={
            "select": "id,storage_path,uploaded_by",
            "id": f"eq.{attachment_id}",
            "review_id": f"eq.{review_id}",
        },
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Attachment not found")

    att = r.json()[0]
    if att["uploaded_by"] != user.email:
        raise HTTPException(status_code=403, detail="Only the uploader can delete this attachment")

    try:
        await _storage_delete(att["storage_path"])
    except Exception as exc:
        log.warning("storage delete failed for %s: %s", att["storage_path"], exc)

    await db_client.delete(
        _url("/rest/v1/review_attachments"),
        params={"id": f"eq.{attachment_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
    )
    return {"ok": True}


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _fetch_review(review_id: str, org_type: str, org_id: str) -> dict:
    r = await db_client.get(
        _url("/rest/v1/asset_reviews"),
        params={
            "select": "*",
            "id": f"eq.{review_id}",
            "author_org_type": f"eq.{org_type}",
            "author_org_id": f"eq.{org_id}",
        },
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Review not found")
    return r.json()[0]
