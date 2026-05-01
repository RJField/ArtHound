import hmac
import os

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_studio, require_vendor
from lib.db import db_client, _url, _headers
from lib.sync.runner import run_sync

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
    source_type: str = "airtable"
    full: bool = False  # True = ignore cursor, re-fetch everything


@router.post("/run")
async def trigger_sync(
    body: SyncBody,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(get_current_user),
):
    """Manually trigger a sync. Runs in the background — returns immediately."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    background_tasks.add_task(
        run_sync,
        owner_type=owner_type,
        owner_id=owner_id,
        source_type=body.source_type,
        trigger="manual",
        full=body.full,
    )
    return {"ok": True, "message": "Sync started in background"}


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
            "select":     "source_type,last_synced_at",
        },
        headers=_headers(),
    )

    return {
        "recent_runs": log_r.json(),
        "cursors":     cursor_r.json(),
    }


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
    source_type: str = "airtable",
    user: CurrentUser = Depends(get_current_user),
):
    """Return current field mappings + available ArtHound slot labels."""
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "mappings,updated_at",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    return {
        "mappings":   rows[0]["mappings"] if rows else [],
        "slots":      _SLOT_LABELS,
        "updated_at": rows[0].get("updated_at") if rows else None,
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

    Configure in Airtable as:
      POST https://your-domain/api/sync/webhook/airtable/studio/{studio_id}?secret=<WEBHOOK_SECRET>
    """
    secret = request.query_params.get("secret") or request.headers.get("X-Webhook-Secret")
    if not _verify_secret(secret):
        raise HTTPException(status_code=401, detail="Invalid or missing webhook secret")

    if owner_type not in ("studio", "vendor"):
        raise HTTPException(status_code=400, detail="owner_type must be 'studio' or 'vendor'")

    background_tasks.add_task(
        run_sync,
        owner_type=owner_type,
        owner_id=owner_id,
        source_type=source_type,
        trigger="webhook",
        full=False,
    )
    return {"ok": True, "message": "Delta sync queued"}
