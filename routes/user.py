import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_admin
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()


def _owner(user: CurrentUser) -> tuple[str, str]:
    owner_type = user.role
    owner_id = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")
    return owner_type, owner_id


@router.get("/me")
async def get_me(user: CurrentUser = Depends(get_current_user)):
    """Return current user identity and their assigned studio/vendor."""
    org = None
    if user.role == "studio" and user.studio_id:
        r = await db_client.get(
            _url("/rest/v1/studios"),
            params={"id": f"eq.{user.studio_id}", "select": "id,name,initialized_at"},
            headers=_headers(),
        )
        r.raise_for_status()
        rows = r.json()
        if rows:
            org = rows[0]
    elif user.role == "vendor" and user.vendor_id:
        r = await db_client.get(
            _url("/rest/v1/vendors"),
            params={"id": f"eq.{user.vendor_id}", "select": "id,name,initialized_at"},
            headers=_headers(),
        )
        r.raise_for_status()
        rows = r.json()
        if rows:
            org = rows[0]

    return {
        "id":    user.id,
        "email": user.email,
        "role":  user.role,
        "org":   org,
    }


@router.get("/orgs")
async def list_orgs(user: CurrentUser = Depends(get_current_user)):
    """List all studios (for studio users) or all vendors (for vendor users)."""
    table = "studios" if user.role == "studio" else "vendors"
    r = await db_client.get(
        _url(f"/rest/v1/{table}"),
        params={"select": "id,name", "order": "name.asc"},
        headers=_headers(),
    )
    r.raise_for_status()
    return r.json()


class AssignBody(BaseModel):
    org_id: str


@router.post("/assign")
async def assign_org(body: AssignBody, user: CurrentUser = Depends(get_current_user)):
    """
    Assign the current user to a studio or vendor by replacing any existing membership.

    TEMPORARY: This is a manual dev/admin shortcut for the pre-onboarding phase.
    Proper membership assignment should be driven by studio/vendor onboarding and
    invite flows, not self-selection. Gate behind an admin role or remove entirely
    once that flow is built.
    """
    require_admin(user)
    if user.role == "studio":
        table  = "studio_members"
        payload = {"studio_id": body.org_id, "user_id": user.id}
    else:
        table  = "vendor_members"
        payload = {"vendor_id": body.org_id, "user_id": user.id}

    # Remove any existing membership before inserting — ensures one org per user.
    await db_client.delete(
        _url(f"/rest/v1/{table}"),
        params={"user_id": f"eq.{user.id}"},
        headers=_headers(),
    )

    r = await db_client.post(
        _url(f"/rest/v1/{table}"),
        json=payload,
        headers=_headers({"Prefer": "return=minimal"}),
    )
    if r.status_code not in (200, 201):
        raise HTTPException(status_code=500, detail="Failed to save assignment")
    return {"ok": True}


# ── Studio summary ───────────────────────────────────────────────────────────

@router.get("/studio-summary")
async def studio_summary(user: CurrentUser = Depends(get_current_user)):
    """Key counts for the studio home dashboard. All queries run in parallel."""
    owner_type, owner_id = _owner(user)
    if owner_type != "studio":
        raise HTTPException(status_code=403, detail="Studio access required")

    now = datetime.now(timezone.utc).isoformat()
    count_hdrs = _headers({"Prefer": "count=exact"})

    asset_r, product_r, share_r, work_r, cursor_r = await asyncio.gather(
        db_client.get(_url("/rest/v1/replicated_assets"),
                      params={"owner_type": "eq.studio", "owner_id": f"eq.{owner_id}",
                              "select": "id"},
                      headers=count_hdrs),
        db_client.get(_url("/rest/v1/replicated_assets"),
                      params={"owner_type": "eq.studio", "owner_id": f"eq.{owner_id}",
                              "product": "not.is.null",
                              "select": "product"},
                      headers=_headers()),
        db_client.get(_url("/rest/v1/payload_dispatches"),
                      params={"sender_studio_id": f"eq.{owner_id}",
                              "revoked_at": "is.null", "expires_at": f"gt.{now}",
                              "select": "id"},
                      headers=count_hdrs),
        db_client.get(_url("/rest/v1/generated_work"),
                      params={"studio_id": f"eq.{owner_id}", "deleted_at": "is.null",
                              "select": "id"},
                      headers=count_hdrs),
        db_client.get(_url("/rest/v1/sync_cursors"),
                      params={"owner_type": "eq.studio", "owner_id": f"eq.{owner_id}",
                              "select": "last_synced_at,last_full_sync_at"},
                      headers=_headers()),
    )

    def _count(r) -> int:
        # PostgREST returns count in Content-Range: 0-N/TOTAL or */0
        cr = r.headers.get("content-range", "*/0")
        total = cr.split("/")[-1]
        return int(total) if total.isdigit() else 0

    cursor_rows = cursor_r.json() if cursor_r.is_success else []

    return {
        "asset_count":    _count(asset_r),
        "product_count":  len({r["product"] for r in (product_r.json() if product_r.is_success else []) if r.get("product")}),
        "active_shares":  _count(share_r),
        "work_count":     _count(work_r),
        "last_synced_at":      cursor_rows[0]["last_synced_at"]      if isinstance(cursor_rows, list) and cursor_rows else None,
        "last_full_sync_at":   cursor_rows[0]["last_full_sync_at"]   if isinstance(cursor_rows, list) and cursor_rows else None,
    }


# ── Delete account ────────────────────────────────────────────────────────────

@router.delete("/account")
async def delete_account(user: CurrentUser = Depends(get_current_user)):
    """
    Full account nuke. Deletes all integration and operational data for the
    caller's studio/vendor, then deletes the auth user.

    Canonical asset IDs are intentionally preserved: canonical_assets.studio_id
    has a NOT NULL FK to studios, so the studios row is soft-deleted (name cleared,
    initialized_at nulled) rather than hard-deleted, keeping the FK satisfied.
    """
    owner_type, owner_id = _owner(user)

    if owner_type == "studio":
        studio_id = owner_id

        # ── Studio-specific tables, in FK-safe order ──────────────────────────

        # payload_dispatches cascades → payload_field_mappings, payload_export_records,
        # payload_access_log (all have ON DELETE CASCADE on dispatch_id)
        await db_client.delete(
            _url("/rest/v1/payload_dispatches"),
            params={"sender_studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )
        await db_client.delete(
            _url("/rest/v1/payload_templates"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )
        # workflow_steps cascades → workflow_step_dependencies, estimate_matrix
        await db_client.delete(
            _url("/rest/v1/workflow_steps"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )
        await db_client.delete(
            _url("/rest/v1/estimate_config"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )
        await db_client.delete(
            _url("/rest/v1/generated_work"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )

    elif owner_type == "vendor":
        vendor_id = owner_id

        # payload_field_mappings and payload_export_records reference vendor_id
        # without cascade — delete explicitly before removing vendor
        await db_client.delete(
            _url("/rest/v1/payload_field_mappings"),
            params={"recipient_vendor_id": f"eq.{vendor_id}"},
            headers=_headers(),
        )
        await db_client.delete(
            _url("/rest/v1/payload_export_records"),
            params={"vendor_id": f"eq.{vendor_id}"},
            headers=_headers(),
        )

    # ── Integration/sync data (owner_type + owner_id pattern) ────────────────
    for table in (
        "replicated_assets",
        "replicated_products",
        "replicated_item_types",
        "source_credentials",
        "source_field_mappings",
        "source_entity_definitions",
        "source_schema_cache",
        "sync_cursors",
        "sync_log",
        "init_jobs",
    ):
        await db_client.delete(
            _url(f"/rest/v1/{table}"),
            params={"owner_type": f"eq.{owner_type}", "owner_id": f"eq.{owner_id}"},
            headers=_headers(),
        )

    # ── Membership + org ──────────────────────────────────────────────────────
    if owner_type == "studio":
        await db_client.delete(
            _url("/rest/v1/studio_members"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )
        # Soft-delete: keep the row so canonical_assets.studio_id FK stays valid
        await db_client.patch(
            _url(f"/rest/v1/studios?id=eq.{studio_id}"),
            headers=_headers({"Prefer": "return=minimal"}),
            json={"name": "[deleted]", "initialized_at": None},
        )
    else:
        await db_client.delete(
            _url("/rest/v1/vendor_members"),
            params={"vendor_id": f"eq.{owner_id}"},
            headers=_headers(),
        )
        await db_client.delete(
            _url(f"/rest/v1/vendors?id=eq.{owner_id}"),
            headers=_headers(),
        )

    # ── Auth user (must be last — invalidates all tokens) ────────────────────
    r = await db_client.delete(
        _url(f"/auth/v1/admin/users/{user.id}"),
        headers=_headers(),
    )
    if not r.is_success:
        log.error("Failed to delete auth user %s: %s %s", user.id, r.status_code, r.text[:200])
        raise HTTPException(status_code=500, detail="Data deleted but auth user removal failed — contact support")

    log.info("Account deleted: %s %s/%s", user.id, owner_type, owner_id)
    return {"ok": True}
