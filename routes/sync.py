import hmac
import logging
import os
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_studio, require_vendor
from lib.db import db_client, _url, _headers
from lib.sync.runner import run_sync, create_sync_log

log = logging.getLogger(__name__)

router         = APIRouter()
webhook_router = APIRouter()  # mounted without JWT auth — protected by shared secret instead


# ── Credentials ───────────────────────────────────────────────────────────────

class CredentialsBody(BaseModel):
    source_type: str = "airtable"
    credentials: dict  # {api_token, base_id} for airtable; varies by source


@router.put("/credentials")
async def save_credentials(
    body: CredentialsBody,
    user: CurrentUser = Depends(get_current_user),
):
    """Store source credentials for the current studio or vendor."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    r = await db_client.post(
        _url("/rest/v1/source_credentials?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": body.source_type,
            "credentials": body.credentials,
        },
    )
    r.raise_for_status()
    return {"ok": True}


@router.get("/credentials")
async def get_credential_status(
    user: CurrentUser = Depends(get_current_user),
):
    """Return which source types have credentials stored (never returns the values)."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type": f"eq.{owner_type}",
            "owner_id":   f"eq.{owner_id}",
            "select":     "source_type,updated_at",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return {"configured": r.json()}


# ── Manual sync trigger ───────────────────────────────────────────────────────

class SyncBody(BaseModel):
    source_type: str | None = None  # None = auto-detect from stored credentials
    full: bool = False  # True = ignore cursor, re-fetch everything


@router.post("/run")
async def trigger_sync(
    body: SyncBody,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
):
    """Manually trigger a sync. Runs in the background — returns immediately.
    If source_type is omitted, it is resolved from the owner's stored credentials."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    source_type = body.source_type
    if not source_type:
        r = await db_client.get(
            _url("/rest/v1/source_credentials"),
            params={
                "owner_type": f"eq.{owner_type}",
                "owner_id":   f"eq.{owner_id}",
                "select":     "source_type",
                "limit":      "1",
            },
            headers=_headers(),
        )
        rows = r.json()
        if not rows:
            raise HTTPException(status_code=400, detail="No source credentials configured")
        source_type = rows[0]["source_type"]

    log_id = await create_sync_log(owner_type, owner_id, source_type, "manual")
    background_tasks.add_task(
        run_sync,
        owner_type=owner_type,
        owner_id=owner_id,
        source_type=source_type,
        trigger="manual",
        full=body.full,
        log_id=log_id,
    )
    return {"ok": True, "log_id": log_id}


# ── Sync status ───────────────────────────────────────────────────────────────

@router.get("/status")
async def sync_status(
    user: CurrentUser = Depends(get_current_user),
):
    """Return the most recent sync log entry and the current cursor."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    log_r = await db_client.get(
        _url("/rest/v1/sync_log"),
        params={
            "owner_type": f"eq.{owner_type}",
            "owner_id":   f"eq.{owner_id}",
            "order":      "started_at.desc",
            "limit":      "5",
            "select":     "trigger,started_at,completed_at,records_synced,status,error_detail",
        },
        headers=_headers(),
    )

    cursor_r = await db_client.get(
        _url("/rest/v1/sync_cursors"),
        params={
            "owner_type": f"eq.{owner_type}",
            "owner_id":   f"eq.{owner_id}",
            "select":     "source_type,last_synced_at,last_full_sync_at",
        },
        headers=_headers(),
    )

    return {
        "recent_runs": log_r.json(),
        "cursors":     cursor_r.json(),
    }


@router.get("/status/{log_id}")
async def sync_log_status(
    log_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Poll the status of a specific sync run by log ID.
    Returns the log entry; status is 'running', 'success', or 'error'."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    r = await db_client.get(
        _url("/rest/v1/sync_log"),
        params={
            "id":         f"eq.{log_id}",
            "owner_type": f"eq.{owner_type}",
            "owner_id":   f"eq.{owner_id}",
            "select":     "id,status,trigger,started_at,completed_at,records_synced,error_detail",
            "limit":      "1",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Sync log entry not found")
    return rows[0]


# ── Field mapping ─────────────────────────────────────────────────────────────

_SLOT_LABELS = [
    {"slot": "name",         "label": "Name"},
    {"slot": "dev_name",     "label": "Dev Name"},
    {"slot": "item_type",    "label": "Item Type"},
    {"slot": "priority",     "label": "Priority"},
    {"slot": "product",      "label": "Product"},
    {"slot": "project_date", "label": "Project Date"},
    {"slot": "status",       "label": "Status"},
    {"slot": "asset_number", "label": "Asset Number"},
]


@router.get("/field-mapping")
async def get_field_mapping(
    user: CurrentUser = Depends(get_current_user),
):
    """Return current field mappings + available ArtHound slot labels.
    Source type is auto-detected from whatever mapping exists for this owner."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type": f"eq.{owner_type}",
            "owner_id":   f"eq.{owner_id}",
            "select":     "source_type,mappings,updated_at",
            "limit":      "1",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    row  = rows[0] if rows else None
    return {
        "source_type": row["source_type"] if row else "airtable",
        "mappings":    row["mappings"]    if row else [],
        "slots":       _SLOT_LABELS,
        "updated_at":  row.get("updated_at") if row else None,
    }


class FieldMappingBody(BaseModel):
    source_type: str = "airtable"
    mappings: list[dict]


@router.put("/field-mapping")
async def save_field_mapping(
    body: FieldMappingBody,
    user: CurrentUser = Depends(get_current_user),
):
    """Persist updated field mappings for the current owner."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    r = await db_client.post(
        _url("/rest/v1/source_field_mappings?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": body.source_type,
            "mappings":    body.mappings,
        },
    )
    r.raise_for_status()
    return {"ok": True}


# ── Webhook (public — protected by shared secret, not JWT) ────────────────────

def _verify_secret(provided: str | None) -> bool:
    expected = os.environ.get("WEBHOOK_SECRET", "")
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided, expected)


async def _handle_webhook_deletions(
    payload: dict,
    owner_type: str,
    owner_id: str,
    source_type: str,
) -> None:
    """
    Parse an Airtable webhook payload for destroyedRecordIds and delete the
    corresponding rows from ArtHound's replicated tables.

    DISABLED by default. Enable by setting ENABLE_WEBHOOK_DELETIONS=true in .env
    once the webhook payload shape has been verified against your Airtable base.

    Airtable payload shape this reads:
      changedTablesById: {
        "<tableId>": {
          destroyedRecordIds: ["recXXX", ...]   ← what we act on
          createdRecordsById: { ... }
          changedRecordsById: { ... }
        }
      }

    Tables touched: replicated_assets, replicated_products, replicated_item_types.
    generated_work is intentionally excluded — those are historical snapshots and
    should not be deleted when a source work item is removed. Use generation versioning
    to manage current vs. historical views instead.
    """
    if os.environ.get("ENABLE_WEBHOOK_DELETIONS", "").lower() != "true":
        return

    destroyed_ids: list[str] = []

    if source_type == "jira":
        event = payload.get("webhookEvent", "")
        if event == "jira:issue_deleted":
            issue = payload.get("issue", {})
            issue_id = str(issue.get("id", "")).strip()
            if issue_id:
                destroyed_ids.append(issue_id)
    else:
        # Airtable shape
        for table_changes in payload.get("changedTablesById", {}).values():
            destroyed_ids.extend(table_changes.get("destroyedRecordIds", []))

    if not destroyed_ids:
        return

    ids_csv = ",".join(destroyed_ids)
    base_params = {
        "owner_type":       f"eq.{owner_type}",
        "owner_id":         f"eq.{owner_id}",
        "source_type":      f"eq.{source_type}",
        "source_record_id": f"in.({ids_csv})",
    }

    for table in ("replicated_assets", "replicated_products", "replicated_item_types"):
        r = await db_client.delete(
            _url(f"/rest/v1/{table}"),
            params=base_params,
            headers=_headers(),
        )
        if not r.is_success:
            log.warning("Deletion sync failed for %s: %s %s", table, r.status_code, r.text)

    # Soft-delete matching generated_work rows — studios only, vendors have no snapshots.
    # Sets deleted_at rather than hard-deleting so history is preserved for bots and audit.
    if owner_type == "studio":
        r = await db_client.patch(
            _url("/rest/v1/generated_work"),
            params={
                "studio_id":        f"eq.{owner_id}",
                "source_record_id": f"in.({ids_csv})",
                "deleted_at":       "is.null",
            },
            json={"deleted_at": datetime.now(timezone.utc).isoformat()},
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if not r.is_success:
            log.warning("Soft-delete of generated_work failed: %s %s", r.status_code, r.text)

    log.info(
        "Webhook deletion sync: %d record IDs processed for %s/%s",
        len(destroyed_ids), owner_type, owner_id,
    )


async def _webhook_sync_task(
    payload: dict,
    owner_type: str,
    owner_id: str,
    source_type: str,
) -> None:
    """Background task: process deletions from the webhook payload, then delta sync."""
    await _handle_webhook_deletions(payload, owner_type, owner_id, source_type)
    await run_sync(
        owner_type=owner_type,
        owner_id=owner_id,
        source_type=source_type,
        trigger="webhook",
        full=False,
    )


@webhook_router.post("/webhook/{source_type}/{owner_type}/{owner_id}")
async def handle_webhook(
    source_type: str,
    owner_type: str,
    owner_id: str,
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Receive a webhook notification from a source tool and trigger a delta sync.
    If ENABLE_WEBHOOK_DELETIONS=true, destroyed records are also purged from
    replicated tables before the sync runs.

    Configure in Airtable as:
      POST https://your-domain/api/sync/webhook/airtable/studio/{studio_id}?secret=<WEBHOOK_SECRET>
    """
    secret = request.query_params.get("secret") or request.headers.get("X-Webhook-Secret")
    if not _verify_secret(secret):
        raise HTTPException(status_code=401, detail="Invalid or missing webhook secret")

    if owner_type not in ("studio", "vendor"):
        raise HTTPException(status_code=400, detail="owner_type must be 'studio' or 'vendor'")

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    background_tasks.add_task(
        _webhook_sync_task,
        payload=payload,
        owner_type=owner_type,
        owner_id=owner_id,
        source_type=source_type,
    )
    return {"ok": True, "message": "Webhook received"}
