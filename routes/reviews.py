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
from lib.system_auth import system_identity

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


# ── Event log ─────────────────────────────────────────────────────────────────

async def _log_event(
    review_id: str,
    subject_type: str,
    subject_id: Optional[str],
    event_type: str,
    user: CurrentUser,
    org_type: str,
    org_id: str,
    detail: Optional[dict] = None,
) -> None:
    """Append to review_events as arthound_system (the table has no user INSERT policy by design).
    Best-effort: an event-write failure is logged loudly but never fails the action it records."""
    try:
        async with system_identity():
            r = await db_client.post(
                _url("/rest/v1/review_events"),
                json={
                    "review_id": review_id,
                    "subject_type": subject_type,
                    "subject_id": subject_id,
                    "event_type": event_type,
                    "actor_user_id": user.id,
                    "actor_org_type": org_type,
                    "actor_org_id": org_id,
                    "detail": detail or {},
                },
                headers=_headers({"Prefer": "return=minimal"}),
            )
            if not r.is_success:
                log.error(
                    "review event write failed review=%s type=%s: %s",
                    review_id, event_type, r.text[:200],
                )
    except Exception as exc:
        log.error("review event write failed review=%s type=%s: %s", review_id, event_type, exc)


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
    org_type, org_id = _resolve_org(user)
    return [
        {
            **rv,
            "asset": meta.get(rv["canonical_asset_id"]),
            "is_author": rv.get("author_org_type") == org_type and rv.get("author_org_id") == org_id,
        }
        for rv in reviews
    ]


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
    link_id: Optional[str] = None  # set → ad-hoc cross-org review on that link


class PromoteRequest(BaseModel):
    link_id: str
    trim: Optional[dict] = None  # {"fields": {...}, "comment_ids": [...], "attachment_ids": [...]}


class StatusRequest(BaseModel):
    status: str


class TrimTemplateCreate(BaseModel):
    name: str
    config: dict
    link_id: Optional[str] = None


class TrimTemplateUpdate(BaseModel):
    name: Optional[str] = None
    config: Optional[dict] = None


class ReviewUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


class CommentCreate(BaseModel):
    body: str
    visibility: str = "internal"


class CommentUpdate(BaseModel):
    body: Optional[str] = None
    visibility: Optional[str] = None  # one-way: internal → shared only


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


# ── Trim templates (vendor-owned promote defaults; payload_templates analogue) ─
# Registered BEFORE the /{review_id} routes so the literal path isn't shadowed.

def _require_vendor_id(user: CurrentUser) -> str:
    if user.role != "vendor" or not user.vendor_id:
        raise HTTPException(status_code=403, detail="Vendor account required")
    return user.vendor_id


@router.get("/trim-templates")
async def list_trim_templates(
    linkId: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    vendor_id = _require_vendor_id(user)
    params: dict = {
        "select": "*",
        "vendor_id": f"eq.{vendor_id}",
        "order": "updated_at.desc",
    }
    if linkId:
        params["or"] = f"(link_id.eq.{linkId},link_id.is.null)"
    r = await db_client.get(
        _url("/rest/v1/review_trim_templates"), params=params, headers=_headers()
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch templates")
    return r.json()


@router.post("/trim-templates")
async def create_trim_template(
    body: TrimTemplateCreate, user: CurrentUser = Depends(get_current_user)
):
    vendor_id = _require_vendor_id(user)
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="Template name is empty")
    r = await db_client.post(
        _url("/rest/v1/review_trim_templates"),
        json={
            "vendor_id": vendor_id,
            "link_id": body.link_id or None,
            "name": body.name,
            "config": body.config,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=502, detail="Failed to create template")
    return r.json()[0]


@router.patch("/trim-templates/{template_id}")
async def update_trim_template(
    template_id: str, body: TrimTemplateUpdate, user: CurrentUser = Depends(get_current_user)
):
    vendor_id = _require_vendor_id(user)
    patch: dict = {}
    if body.name is not None:
        patch["name"] = body.name
    if body.config is not None:
        patch["config"] = body.config
    if not patch:
        return {"ok": True}
    from datetime import datetime, timezone
    patch["updated_at"] = datetime.now(timezone.utc).isoformat()
    r = await db_client.patch(
        _url("/rest/v1/review_trim_templates"),
        params={"id": f"eq.{template_id}", "vendor_id": f"eq.{vendor_id}"},
        json=patch,
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Template not found")
    return r.json()[0]


@router.delete("/trim-templates/{template_id}")
async def delete_trim_template(
    template_id: str, user: CurrentUser = Depends(get_current_user)
):
    vendor_id = _require_vendor_id(user)
    r = await db_client.delete(
        _url("/rest/v1/review_trim_templates"),
        params={"id": f"eq.{template_id}", "vendor_id": f"eq.{vendor_id}"},
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to delete template")
    if not r.json():
        raise HTTPException(status_code=404, detail="Template not found")
    return {"ok": True}


# ── Review CRUD ───────────────────────────────────────────────────────────────

@router.get("")
@router.get("/")
async def list_reviews(
    canonicalAssetId: Optional[str] = Query(None),
    scope: Optional[str] = Query(None),
    user: CurrentUser = Depends(get_current_user),
):
    org_type, org_id = _resolve_org(user)

    params: dict = {"select": "*", "order": "created_at.desc"}
    if scope == "cross_org":
        # No author filter: RLS (ar_sel) returns own-authored + link-partner cross-org reviews —
        # this IS the cross-org inbox/outbox.
        params["scope"] = "eq.cross_org"
    elif scope == "internal":
        params["scope"] = "eq.internal"
        params["author_org_type"] = f"eq.{org_type}"
        params["author_org_id"] = f"eq.{org_id}"
    elif scope == "all":
        # Everything the caller's RLS view exposes: own-authored + link-party cross-org.
        pass
    else:
        # Legacy default: everything the org authored (both scopes).
        params["author_org_type"] = f"eq.{org_type}"
        params["author_org_id"] = f"eq.{org_id}"
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
            "scope": "cross_org" if body.link_id else "internal",
            "link_id": body.link_id or None,
            "title": body.title or None,
            "description": body.description or None,
            "status": body.status or None,
            "created_by_email": user.email,
            "created_by_user_id": user.id,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        # RLS ar_ins rejects a cross-org insert when the link isn't active/yours/this studio's.
        if body.link_id and ("42501" in r.text or r.status_code in (401, 403)):
            raise HTTPException(status_code=403, detail="Link is not active or does not match this asset's studio")
        raise HTTPException(status_code=502, detail="Failed to create review")

    rows = r.json()
    if not rows:
        raise HTTPException(status_code=502, detail="Review created but not returned")
    review = rows[0]

    # Mirror the primary asset into the m2m junction (multi-asset reads go via review_assets).
    jr = await db_client.post(
        _url("/rest/v1/review_assets"),
        json={"review_id": review["id"], "canonical_asset_id": body.canonical_asset_id},
        headers=_headers({"Prefer": "return=minimal"}),
    )
    if not jr.is_success:
        log.error("review_assets mirror insert failed review=%s: %s", review["id"], jr.text[:200])

    await _log_event(review["id"], "review", review["id"], "created", user, org_type, org_id)

    enriched = await _enrich([review], user)
    return enriched[0]


@router.get("/{review_id}")
async def get_review(review_id: str, user: CurrentUser = Depends(get_current_user)):
    _resolve_org(user)
    review = await _fetch_visible_review(review_id)
    enriched = await _enrich([review], user)
    return enriched[0]


@router.patch("/{review_id}")
async def update_review(
    review_id: str, body: ReviewUpdate, user: CurrentUser = Depends(get_current_user)
):
    org_type, org_id = _resolve_org(user)
    existing = await _fetch_review(review_id, org_type, org_id)  # ownership check

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

        if "status" in patch and patch["status"] != existing.get("status"):
            await _log_event(
                review_id, "review", review_id, "status_changed", user, org_type, org_id,
                detail={"from": existing.get("status"), "to": patch["status"]},
            )
        else:
            await _log_event(
                review_id, "review", review_id, "updated", user, org_type, org_id,
                detail={"fields": [k for k in patch if k != "updated_at"]},
            )
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


# ── Promotion + cross-org status ──────────────────────────────────────────────

@router.post("/{review_id}/promote")
async def promote_review(
    review_id: str, body: PromoteRequest, user: CurrentUser = Depends(get_current_user)
):
    """Promote an internal review to a cross-org review on a link — the ONE path a review
    crosses the org wall. All validation + the trimmed copy happen atomically in the
    promote_review DEFINER RPC (in-fn authz: author-org member, active link, studio match)."""
    org_type, org_id = _resolve_org(user)
    await _fetch_review(review_id, org_type, org_id)  # owner gate for a clean 404

    r = await db_client.post(
        _url("/rest/v1/rpc/promote_review"),
        json={
            "p_review_id": review_id,
            "p_link_id": body.link_id,
            "p_trim": body.trim or {},
            "p_actor_email": user.email,
        },
        headers=_headers(),
    )
    if not r.is_success:
        detail = "Promotion failed"
        try:
            detail = r.json().get("message") or detail
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(status_code=400, detail=detail)

    new_id = r.json()
    new_review = await _fetch_visible_review(new_id)
    enriched = await _enrich([new_review], user)
    return enriched[0]


@router.post("/{review_id}/status")
async def set_review_status(
    review_id: str, body: StatusRequest, user: CurrentUser = Depends(get_current_user)
):
    """Cross-org status transition (either link party, active link) via the review_set_status
    DEFINER RPC. Owner-org edits on internal reviews keep using PATCH."""
    _resolve_org(user)
    await _fetch_visible_review(review_id)

    r = await db_client.post(
        _url("/rest/v1/rpc/review_set_status"),
        json={"p_review_id": review_id, "p_status": body.status},
        headers=_headers(),
    )
    if not r.is_success:
        detail = "Status update failed"
        try:
            detail = r.json().get("message") or detail
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(status_code=400, detail=detail)
    return {"ok": True}


# ── Comment CRUD ──────────────────────────────────────────────────────────────
# Visibility lanes (P0: internal only in practice — 'shared' requires a cross-org parent, which
# lands in P1). RLS enforces lane + authorship; the route mirrors those checks for clean errors.

@router.get("/{review_id}/comments")
async def list_comments(review_id: str, user: CurrentUser = Depends(get_current_user)):
    _resolve_org(user)
    await _fetch_visible_review(review_id)

    r = await db_client.get(
        _url("/rest/v1/review_comments"),
        params={"select": "*", "review_id": f"eq.{review_id}", "order": "created_at.asc"},
        headers=_headers(),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch comments")
    return r.json()


@router.post("/{review_id}/comments")
async def create_comment(
    review_id: str, body: CommentCreate, user: CurrentUser = Depends(get_current_user)
):
    org_type, org_id = _resolve_org(user)
    review = await _fetch_visible_review(review_id)

    if not body.body.strip():
        raise HTTPException(status_code=422, detail="Comment body is empty")
    if body.visibility not in ("internal", "shared"):
        raise HTTPException(status_code=422, detail="Invalid visibility")
    if body.visibility == "shared" and review.get("scope") != "cross_org":
        raise HTTPException(status_code=400, detail="Shared comments require a cross-org review")

    r = await db_client.post(
        _url("/rest/v1/review_comments"),
        json={
            "review_id": review_id,
            "author_org_type": org_type,
            "author_org_id": org_id,
            "author_user_id": user.id,
            "author_email": user.email,
            "body": body.body,
            "visibility": body.visibility,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=502, detail="Failed to create comment")
    comment = r.json()[0]

    await _log_event(review_id, "comment", comment["id"], "comment_added", user, org_type, org_id)
    return comment


@router.patch("/{review_id}/comments/{comment_id}")
async def update_comment(
    review_id: str,
    comment_id: str,
    body: CommentUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    org_type, org_id = _resolve_org(user)
    review = await _fetch_visible_review(review_id)

    patch: dict = {}
    if body.body is not None:
        if not body.body.strip():
            raise HTTPException(status_code=422, detail="Comment body is empty")
        patch["body"] = body.body
    if body.visibility is not None:
        if body.visibility != "shared":
            raise HTTPException(status_code=400, detail="Visibility can only move internal → shared")
        if review.get("scope") != "cross_org":
            raise HTTPException(status_code=400, detail="Shared comments require a cross-org review")
        patch["visibility"] = "shared"

    if not patch:
        return {"ok": True}

    # edited_at / shared_at are stamped by the review_comment_guard trigger.
    r = await db_client.patch(
        _url("/rest/v1/review_comments"),
        params={
            "id": f"eq.{comment_id}",
            "review_id": f"eq.{review_id}",
            "author_user_id": f"eq.{user.id}",
        },
        json=patch,
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Comment not found or you are not the author")
    comment = r.json()[0]

    if "visibility" in patch:
        await _log_event(review_id, "comment", comment_id, "comment_shared", user, org_type, org_id)
    return comment


@router.delete("/{review_id}/comments/{comment_id}")
async def delete_comment(
    review_id: str, comment_id: str, user: CurrentUser = Depends(get_current_user)
):
    _resolve_org(user)
    await _fetch_visible_review(review_id)

    r = await db_client.delete(
        _url("/rest/v1/review_comments"),
        params={
            "id": f"eq.{comment_id}",
            "review_id": f"eq.{review_id}",
            "author_user_id": f"eq.{user.id}",
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to delete comment")
    if not r.json():
        raise HTTPException(status_code=404, detail="Comment not found or you are not the author")
    return {"ok": True}


# ── Event history ─────────────────────────────────────────────────────────────

@router.get("/{review_id}/events")
async def list_events(review_id: str, user: CurrentUser = Depends(get_current_user)):
    _resolve_org(user)
    await _fetch_visible_review(review_id)

    r = await db_client.get(
        _url("/rest/v1/review_events"),
        params={"select": "*", "review_id": f"eq.{review_id}", "order": "created_at.asc"},
        headers=_headers(),
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail="Failed to fetch events")
    return r.json()


# ── Attachment CRUD ───────────────────────────────────────────────────────────

@router.get("/{review_id}/attachments")
async def list_attachments(review_id: str, user: CurrentUser = Depends(get_current_user)):
    _resolve_org(user)
    await _fetch_visible_review(review_id)

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
    # uploading any bytes — a caller who can't see the review can't attach to it. Visibility-based:
    # a link partner may attach to a shared cross-org review (rat_ins still binds the row to their org).
    org_type, org_id = _resolve_org(user)
    review = await _fetch_visible_review(review_id)

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
            "uploaded_by_user_id": user.id,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=502, detail="Failed to save attachment record")
    attachment = r.json()[0]

    await _log_event(
        review_id, "attachment", attachment["id"], "attachment_added", user, org_type, org_id,
        detail={"filename": attachment.get("filename")},
    )
    return attachment


@router.get("/{review_id}/attachments/{attachment_id}/content")
async def serve_attachment(
    review_id: str,
    attachment_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    # §7 STORAGE GATE: two user-context reads authorize the byte stream below. The visibility fetch
    # (RLS `ar_sel`) hides a review the caller's org can't see; the review_attachments read (RLS
    # `rat_sel`) hides the attachment row. Either invisible → 404 before any blob is fetched. Both
    # run as the caller (`_headers()`); the byte stream itself is the §0c service-role carve-out.
    _resolve_org(user)
    await _fetch_visible_review(review_id)

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
    _resolve_org(user)
    await _fetch_visible_review(review_id)

    r = await db_client.get(
        _url("/rest/v1/review_attachments"),
        params={
            "select": "id,storage_path,uploaded_by,uploaded_by_user_id",
            "id": f"eq.{attachment_id}",
            "review_id": f"eq.{review_id}",
        },
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Attachment not found")

    att = r.json()[0]
    # Spoof-resistant uploader check; email fallback only for legacy rows predating the column.
    is_uploader = (
        att.get("uploaded_by_user_id") == user.id
        if att.get("uploaded_by_user_id")
        else att["uploaded_by"] == user.email
    )
    if not is_uploader:
        raise HTTPException(status_code=403, detail="Only the uploader can delete this attachment")

    # Promoted copies reference the SAME storage path (no byte copy) — only delete the blob when no
    # OTHER row still points at it. Checked as arthound_system: the other referencing row may live on
    # a review outside the caller's RLS view.
    blob_shared = False
    try:
        async with system_identity():
            refs = await db_client.get(
                _url("/rest/v1/review_attachments"),
                params={
                    "select": "id",
                    "storage_path": f"eq.{att['storage_path']}",
                    "id": f"neq.{attachment_id}",
                    "limit": "1",
                },
                headers=_headers(),
            )
            blob_shared = refs.is_success and bool(refs.json())
    except Exception as exc:
        log.warning("shared-blob check failed for %s (keeping blob): %s", att["storage_path"], exc)
        blob_shared = True  # fail safe: never delete a possibly-referenced blob

    if not blob_shared:
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
    """Owner-org fetch: the review must be AUTHORED by the caller's org. Gate for edits/promotion."""
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


async def _fetch_visible_review(review_id: str) -> dict:
    """Visibility fetch: any review the caller's RLS view exposes — own-org authored, or a
    cross-org review on a link their org is party to (ar_sel). Gate for reads, comments,
    attachments on shared reviews. Runs as the caller (§7 storage-gate contract holds)."""
    r = await db_client.get(
        _url("/rest/v1/asset_reviews"),
        params={"select": "*", "id": f"eq.{review_id}"},
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=404, detail="Review not found")
    return r.json()[0]
