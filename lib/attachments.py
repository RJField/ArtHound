import hashlib
import logging
import os
from datetime import datetime, timezone

import httpx

from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)

_BUCKET = "attachments"
_MAX_ATTEMPTS = 3


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _storage_object_path(content_hash: str) -> str:
    return f"sha256/{content_hash}"


def _storage_api_url(path: str) -> str:
    return f"{os.environ['SUPABASE_URL']}/storage/v1{path}"


def _storage_headers(extra: dict = {}) -> dict:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {"Authorization": f"Bearer {key}", "apikey": key, **extra}


async def _storage_exists(content_hash: str, client: httpx.AsyncClient) -> bool:
    r = await client.head(
        _storage_api_url(f"/object/{_BUCKET}/{_storage_object_path(content_hash)}"),
        headers=_storage_headers(),
    )
    return r.status_code == 200


async def _storage_upload(
    content_hash: str, data: bytes, content_type: str, client: httpx.AsyncClient
) -> None:
    r = await client.post(
        _storage_api_url(f"/object/{_BUCKET}/{_storage_object_path(content_hash)}"),
        headers=_storage_headers({"Content-Type": content_type, "x-upsert": "false"}),
        content=data,
    )
    r.raise_for_status()


async def _get_studio_source_creds(
    studio_id: str, client: httpx.AsyncClient
) -> tuple[str, dict]:
    """Returns (source_type, creds_dict), with token refresh for Jira."""
    r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type": "eq.studio",
            "owner_id": f"eq.{studio_id}",
            "select": "source_type,credentials",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise ValueError(f"No source credentials for studio {studio_id}")

    source_type = rows[0]["source_type"]

    if source_type == "jira":
        from lib.token_refresh import get_jira_token
        creds = await get_jira_token("studio", studio_id, client)
    else:
        from lib.crypto import decrypt_credentials
        creds = decrypt_credentials(rows[0]["credentials"])

    return source_type, creds


def _source_fetch_headers(source_type: str, creds: dict) -> dict:
    """Auth headers needed to fetch a raw attachment URL from the given source."""
    if source_type == "jira":
        return {"Authorization": f"Bearer {creds['access_token']}"}
    # Airtable: S3 pre-signed URLs carry auth in query params; no header needed
    return {}


def _find_attachment_items(data: dict) -> list[tuple[str, int, dict]]:
    """
    Walk payload_data['data'] and find all attachment list items.
    Returns [(field_key, index, item_dict), ...].
    """
    results = []
    for key, value in data.items():
        if not isinstance(value, list) or not value:
            continue
        if isinstance(value[0], dict) and "url" in value[0]:
            for i, item in enumerate(value):
                if isinstance(item, dict) and item.get("url"):
                    results.append((key, i, item))
    return results


async def copy_payload_attachments(dispatch_id: str) -> None:
    """
    Download every attachment referenced in a dispatch's payload_data, store
    each blob at attachments/sha256/{hash} in Supabase Storage, insert refs,
    and patch content_hash back into the payload_data snapshot.
    """
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={"id": f"eq.{dispatch_id}", "select": "sender_studio_id,payload_data"},
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise ValueError(f"Dispatch {dispatch_id} not found")

    studio_id = rows[0]["sender_studio_id"]
    payload_data = rows[0]["payload_data"]
    data: dict = payload_data.get("data") or {}

    attachment_items = _find_attachment_items(data)
    if not attachment_items:
        return

    hash_updates: dict[tuple[str, int], str] = {}  # (field_key, idx) -> content_hash

    async with httpx.AsyncClient(timeout=120.0) as client:
        source_type, creds = await _get_studio_source_creds(studio_id, client)
        fetch_headers = _source_fetch_headers(source_type, creds)

        for field_key, idx, item in attachment_items:
            url = item["url"]
            try:
                r_file = await client.get(url, headers=fetch_headers, follow_redirects=True)
                r_file.raise_for_status()

                file_bytes = r_file.content
                content_type = (
                    r_file.headers.get("content-type", "application/octet-stream")
                    .split(";")[0]
                    .strip()
                )
                content_hash = hashlib.sha256(file_bytes).hexdigest()

                if not await _storage_exists(content_hash, client):
                    await _storage_upload(content_hash, file_bytes, content_type, client)

                await db_client.post(
                    _url("/rest/v1/attachment_refs"),
                    headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
                    json={"content_hash": content_hash, "dispatch_id": dispatch_id},
                )

                hash_updates[(field_key, idx)] = content_hash
                log.info(
                    "attachment copied dispatch=%s field=%s idx=%d hash=%.8s",
                    dispatch_id, field_key, idx, content_hash,
                )

            except Exception as exc:
                # Log and continue — partial copy is better than aborting entirely
                log.warning(
                    "attachment copy failed dispatch=%s field=%s idx=%d: %s",
                    dispatch_id, field_key, idx, exc,
                )

    if not hash_updates:
        return

    # Patch content_hash into each copied item inside payload_data
    updated_data = {k: list(v) if isinstance(v, list) else v for k, v in data.items()}
    for (field_key, idx), content_hash in hash_updates.items():
        if isinstance(updated_data.get(field_key), list) and idx < len(updated_data[field_key]):
            updated_data[field_key][idx] = {**updated_data[field_key][idx], "content_hash": content_hash}

    await db_client.patch(
        _url("/rest/v1/payload_dispatches"),
        params={"id": f"eq.{dispatch_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"payload_data": {**payload_data, "data": updated_data}},
    )


async def enqueue_attachment_copy(dispatch_id: str) -> None:
    """Insert a pending copy job. Called immediately after a dispatch is created.

    attachment_copy_jobs is a system-managed queue (Pattern F — denied to users under RLS), so the
    enqueue runs in SYSTEM identity even though a user's dispatch action triggers it. Flag-off this is
    a no-op (service-role writes regardless of the bound token); flag-on it binds the arthound_system
    token so the write satisfies the system policy."""
    from lib.system_auth import system_identity
    async with system_identity():
        r = await db_client.post(
            _url("/rest/v1/attachment_copy_jobs"),
            headers=_headers({"Prefer": "return=minimal"}),
            json={"dispatch_id": dispatch_id},
        )
    r.raise_for_status()


async def purge_orphaned_attachments() -> dict:
    """
    Delete storage blobs with no active dispatch reference.
    'Active' = dispatch exists and has not been revoked.
    Studio-side cached copies (no dispatch ref) are also removed.
    Returns {"deleted": int, "kept": int, "errors": int}.
    """
    # Collect IDs of non-revoked dispatches
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={"revoked_at": "is.null", "select": "id"},
        headers=_headers(),
    )
    active_ids = {row["id"] for row in r.json()}

    # Content hashes that must be kept (referenced by at least one active dispatch)
    r2 = await db_client.get(
        _url("/rest/v1/attachment_refs"),
        params={"select": "content_hash,dispatch_id"},
        headers=_headers(),
    )
    keep_hashes = {
        row["content_hash"]
        for row in r2.json()
        if row["dispatch_id"] in active_ids
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        # List all objects in the bucket (paginate in case of large sets)
        all_objects: list[dict] = []
        limit = 1000
        offset = 0
        while True:
            list_r = await client.post(
                _storage_api_url(f"/object/list/{_BUCKET}"),
                headers=_storage_headers({"Content-Type": "application/json"}),
                json={"prefix": "sha256/", "limit": limit, "offset": offset},
            )
            list_r.raise_for_status()
            page = list_r.json()
            all_objects.extend(page)
            if len(page) < limit:
                break
            offset += limit

        to_delete = [
            obj["name"]
            for obj in all_objects
            if obj["name"].split("/", 1)[-1] not in keep_hashes
        ]

        deleted = errors = 0
        batch_size = 100
        for i in range(0, len(to_delete), batch_size):
            batch = to_delete[i : i + batch_size]
            try:
                del_r = await client.request(
                    "DELETE",
                    _storage_api_url(f"/object/{_BUCKET}"),
                    headers=_storage_headers({"Content-Type": "application/json"}),
                    json={"prefixes": batch},
                )
                del_r.raise_for_status()
                deleted += len(batch)
            except Exception as exc:
                log.error("purge batch delete failed: %s", exc)
                errors += len(batch)

    kept = len(all_objects) - len(to_delete)
    log.info("attachment purge: deleted=%d kept=%d errors=%d", deleted, kept, errors)
    return {"deleted": deleted, "kept": kept, "errors": errors}


async def drain_attachment_jobs() -> None:
    """
    Claim and process one pending job. Safe for single-worker polling model.
    Called on each tick of the main.py polling loop.
    """
    r = await db_client.get(
        _url("/rest/v1/attachment_copy_jobs"),
        params={
            "status": "eq.pending",
            "order": "created_at.asc",
            "limit": "1",
            "select": "id,dispatch_id,attempts",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        return

    job = rows[0]
    job_id = job["id"]
    attempt = job["attempts"] + 1

    # Optimistic claim — if another worker already claimed it the PATCH touches 0 rows (safe)
    await db_client.patch(
        _url("/rest/v1/attachment_copy_jobs"),
        params={"id": f"eq.{job_id}", "status": "eq.pending"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"status": "processing", "attempts": attempt, "updated_at": _now_iso()},
    )

    try:
        await copy_payload_attachments(job["dispatch_id"])
        await db_client.patch(
            _url("/rest/v1/attachment_copy_jobs"),
            params={"id": f"eq.{job_id}"},
            headers=_headers({"Prefer": "return=minimal"}),
            json={"status": "done", "updated_at": _now_iso()},
        )
    except Exception as exc:
        log.error("attachment copy job %s failed (attempt %d): %s", job_id, attempt, exc)
        next_status = "pending" if attempt < _MAX_ATTEMPTS else "failed"
        await db_client.patch(
            _url("/rest/v1/attachment_copy_jobs"),
            params={"id": f"eq.{job_id}"},
            headers=_headers({"Prefer": "return=minimal"}),
            json={"status": next_status, "last_error": str(exc)[:1000], "updated_at": _now_iso()},
        )
