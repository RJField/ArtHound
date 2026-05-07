import hashlib
import logging
import os

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse

from lib.attachments import (
    _source_fetch_headers, _get_studio_source_creds,
    _storage_api_url, _storage_headers, _storage_exists, _storage_upload,
    _BUCKET, _storage_object_path,
)
from lib.auth import CurrentUser, get_current_user, require_admin, require_studio
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()


# ── auth predicate ────────────────────────────────────────────────────────────

async def _authorize_payload_attachment(
    dispatch_id: str,
    canonical_asset_id: str,
    caller: CurrentUser,
) -> dict:
    """
    Returns the dispatch row on success. All failures that leak existence
    information use 404; explicit revocation uses 403.

    Checks (in order):
      (a) dispatch row exists
      (b) caller is the vendor on this dispatch, or a studio member of the dispatching studio
      (c) dispatch has not been revoked
      (d) the requested canonical_asset_id is present in payload_data
    """
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "id": f"eq.{dispatch_id}",
            "select": "id,sender_studio_id,recipient_vendor_id,revoked_at,expires_at,payload_data",
        },
        headers=_headers(),
    )
    rows = r.json()

    # (a) exists
    if not rows:
        raise HTTPException(404)
    dispatch = rows[0]

    # (b) caller identity
    if caller.role == "vendor":
        if dispatch["recipient_vendor_id"] != caller.vendor_id:
            raise HTTPException(404)
    elif caller.role == "studio":
        if dispatch["sender_studio_id"] != caller.studio_id:
            raise HTTPException(404)
    else:
        raise HTTPException(403)

    # (c) not revoked
    if dispatch["revoked_at"] is not None:
        raise HTTPException(403, detail="This dispatch has been revoked")

    # (d) asset is actually in this dispatch
    assets_in_payload = [
        item.get("asset_global_id")
        for item in (dispatch["payload_data"].get("assets") or [])
    ]
    # Also support the single-asset shape used by dispatch_bulk
    single_id = dispatch["payload_data"].get("asset_global_id")
    if canonical_asset_id not in assets_in_payload and canonical_asset_id != single_id:
        raise HTTPException(404)

    return dispatch


# ── studio asset proxy (copy-on-first-view) ───────────────────────────────────

@router.get("/asset/{canonical_asset_id}/{field_key}/{idx}")
async def get_asset_attachment(
    canonical_asset_id: str,
    field_key: str,
    idx: int,
    caller: CurrentUser = Depends(require_studio),
):
    """
    Serve a studio attachment from Supabase Storage, copying it from the source
    tool on first view. Subsequent views are served directly from Storage.
    Studio-only. Copy is scoped to explicit user intent (opening the attachment).
    """
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "canonical_asset_id": f"eq.{canonical_asset_id}",
            "owner_type": "eq.studio",
            "owner_id": f"eq.{caller.studio_id}",
            "select": "meta,source_record_id",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(404)

    meta: dict = rows[0].get("meta") or {}
    field_data = meta.get(field_key)
    if not isinstance(field_data, list) or idx >= len(field_data):
        raise HTTPException(404)

    item = field_data[idx]
    mimetype = item.get("mimetype") or "application/octet-stream"
    filename = item.get("filename", "attachment")
    content_hash = item.get("content_hash")

    # Fast path: already copied — serve directly from Supabase Storage.
    if content_hash:
        storage_url = _storage_api_url(f"/object/{_BUCKET}/{_storage_object_path(content_hash)}")
        async with httpx.AsyncClient(timeout=60.0) as _sc:
            r_s = await _sc.get(storage_url, headers=_storage_headers())

        if r_s.is_success:
            return Response(
                content=r_s.content,
                media_type=mimetype,
                headers={
                    "Cache-Control": "private, max-age=3600",
                    "Content-Disposition": f'inline; filename="{filename}"',
                },
            )

        if r_s.status_code != 404:
            raise HTTPException(502, detail=f"Storage returned {r_s.status_code}")

        # 404 — blob was purged while content_hash was still in meta.
        # Clear the stale hash so the next view also re-downloads from source.
        cleaned = list(field_data)
        cleaned[idx] = {k: v for k, v in item.items() if k != "content_hash"}
        await db_client.patch(
            _url("/rest/v1/replicated_assets"),
            params={
                "canonical_asset_id": f"eq.{canonical_asset_id}",
                "owner_type": "eq.studio",
                "owner_id": f"eq.{caller.studio_id}",
            },
            headers=_headers({"Prefer": "return=minimal"}),
            json={"meta": {**meta, field_key: cleaned}},
        )
        # Fall through to first-view path to re-download from source.

    # First-view: download from source, copy to Storage, patch meta, return bytes.
    source_url = item.get("url")
    if not source_url:
        raise HTTPException(404)

    async with httpx.AsyncClient(timeout=120.0) as client:
        source_type, creds = await _get_studio_source_creds(caller.studio_id, client)
        fetch_headers = _source_fetch_headers(source_type, creds)
        r_file = await client.get(source_url, headers=fetch_headers, follow_redirects=True)

        if r_file.status_code == 410:
            # CDN URL expired — re-sync just this record to get fresh signed URLs,
            # then re-read the asset meta so subsequent operations use the updated values.
            from lib.sync.runner import sync_single_asset
            source_record_id = rows[0].get("source_record_id")
            log.warning(
                "attachment 410 on first fetch: asset=%s field=%s idx=%d source_record_id=%s",
                canonical_asset_id, field_key, idx, source_record_id,
            )
            if source_record_id:
                sync_result = await sync_single_asset("studio", caller.studio_id, source_record_id, source_type)
                log.warning("sync_single_asset result: %s", sync_result)
            else:
                from lib.sync.runner import run_sync
                await run_sync("studio", caller.studio_id, source_type, trigger="attachment_refresh")

            r_fresh = await db_client.get(
                _url("/rest/v1/replicated_assets"),
                params={
                    "canonical_asset_id": f"eq.{canonical_asset_id}",
                    "owner_type": "eq.studio",
                    "owner_id": f"eq.{caller.studio_id}",
                    "select": "meta",
                },
                headers=_headers(),
            )
            fresh_rows = r_fresh.json()
            old_url = source_url
            if fresh_rows:
                meta = fresh_rows[0].get("meta") or meta
                fresh_field = meta.get(field_key)
                if isinstance(fresh_field, list) and idx < len(fresh_field):
                    field_data = fresh_field
                    item = field_data[idx]
                    source_url = item.get("url") or source_url

            log.warning(
                "attachment 410 retry: url_changed=%s url=%.80s",
                source_url != old_url, source_url,
            )
            r_file = await client.get(source_url, headers=fetch_headers, follow_redirects=True)

        try:
            r_file.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 410:
                raise HTTPException(502, detail="Attachment URL expired and could not be refreshed after sync")
            raise HTTPException(502, detail=f"Source returned {status} fetching attachment")

        file_bytes = r_file.content
        resolved_type = r_file.headers.get("content-type", mimetype).split(";")[0].strip()
        content_hash = hashlib.sha256(file_bytes).hexdigest()

        if not await _storage_exists(content_hash, client):
            await _storage_upload(content_hash, file_bytes, resolved_type, client)

    # Patch content_hash and resolved mimetype back so subsequent views hit the fast path.
    updated_field = list(field_data)
    updated_field[idx] = {**item, "content_hash": content_hash, "mimetype": resolved_type}
    await db_client.patch(
        _url("/rest/v1/replicated_assets"),
        params={
            "canonical_asset_id": f"eq.{canonical_asset_id}",
            "owner_type": "eq.studio",
            "owner_id": f"eq.{caller.studio_id}",
        },
        headers=_headers({"Prefer": "return=minimal"}),
        json={"meta": {**meta, field_key: updated_field}},
    )

    return Response(
        content=file_bytes,
        media_type=resolved_type,
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": f'inline; filename="{filename}"',
        },
    )


# ── payload attachment proxy (from Supabase Storage) ─────────────────────────

@router.get("/payload/{dispatch_id}/{canonical_asset_id}/{field_key}/{idx}")
async def get_payload_attachment(
    dispatch_id: str,
    canonical_asset_id: str,
    field_key: str,
    idx: int,
    caller: CurrentUser = Depends(get_current_user),
):
    """
    Serve a frozen attachment copy from Supabase Storage.
    Accessible by the vendor on the dispatch, or by a studio member of the dispatching studio.
    Returns 202 if the attachment copy job has not yet completed.
    """
    dispatch = await _authorize_payload_attachment(dispatch_id, canonical_asset_id, caller)

    data: dict = dispatch["payload_data"].get("data") or {}
    field_data = data.get(field_key)
    if not isinstance(field_data, list) or idx >= len(field_data):
        raise HTTPException(404)

    item = field_data[idx]
    content_hash = item.get("content_hash")

    if not content_hash:
        return Response(status_code=202, content="Attachment copy in progress")

    mimetype = item.get("mimetype", "application/octet-stream")
    filename = item.get("filename", "attachment")
    storage_url = _storage_api_url(f"/object/{_BUCKET}/{_storage_object_path(content_hash)}")

    async def stream():
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("GET", storage_url, headers=_storage_headers()) as resp:
                resp.raise_for_status()
                async for chunk in resp.aiter_bytes(65536):
                    yield chunk

    return StreamingResponse(
        stream(),
        media_type=mimetype,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


# ── admin ─────────────────────────────────────────────────────────────────────

@router.post("/admin/purge")
async def admin_purge_attachments(caller: CurrentUser = Depends(get_current_user)):
    """
    Manually trigger an attachment storage purge. Admin only.
    Deletes all blobs with no active (non-revoked) dispatch reference.
    """
    require_admin(caller)
    from lib.attachments import purge_orphaned_attachments
    return await purge_orphaned_attachments()
