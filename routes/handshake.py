import asyncio
import logging
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_studio, require_vendor
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)

router = APIRouter()

_INVITE_TTL_DAYS = 7
_MAX_RESENDS = 2


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _expiry_iso() -> str:
    return (datetime.now(timezone.utc) + timedelta(days=_INVITE_TTL_DAYS)).isoformat()


# ── vendor discovery ──────────────────────────────────────────────────────────

@router.get("/vendors/search")
async def search_vendors(q: str, _: CurrentUser = Depends(require_studio)):
    """Find vendors by handle (prefix match, case-insensitive). Returns name + handle only."""
    q = q.strip().lstrip('@')
    if not q or len(q) < 2:
        raise HTTPException(status_code=400, detail="Query must be at least 2 characters")
    r = await db_client.get(
        _url("/rest/v1/vendors"),
        params={
            "handle": f"ilike.{q}%",
            "select": "id,name,handle",
            "order":  "name.asc",
            "limit":  "10",
        },
        headers=_headers(),
    )
    return r.json()


# ── invite lifecycle ──────────────────────────────────────────────────────────

class InviteBody(BaseModel):
    vendor_id: str
    review_collaboration_mode: str = "none"


@router.post("/invite", status_code=201)
async def send_invite(body: InviteBody, user: CurrentUser = Depends(require_studio)):
    if body.review_collaboration_mode not in ("none", "isolated", "collaborative"):
        raise HTTPException(status_code=400, detail="Invalid review_collaboration_mode")

    # Confirm vendor exists
    r_vendor = await db_client.get(
        _url("/rest/v1/vendors"),
        params={"id": f"eq.{body.vendor_id}", "select": "id,name,handle"},
        headers=_headers(),
    )
    if not r_vendor.json():
        raise HTTPException(status_code=404, detail="Vendor not found")

    # Block if already an active link
    r_link = await db_client.get(
        _url("/rest/v1/studio_vendor_links"),
        params={
            "studio_id": f"eq.{user.studio_id}",
            "vendor_id": f"eq.{body.vendor_id}",
            "status":    "eq.active",
            "select":    "id",
        },
        headers=_headers(),
    )
    if r_link.json():
        raise HTTPException(status_code=409, detail="An active connection with this vendor already exists")

    # Block if a pending invite already exists (the unique index enforces this too,
    # but a clear 409 is better UX than a DB constraint error)
    r_pending = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "studio_id": f"eq.{user.studio_id}",
            "vendor_id": f"eq.{body.vendor_id}",
            "status":    "eq.pending",
            "select":    "id",
        },
        headers=_headers(),
    )
    if r_pending.json():
        raise HTTPException(
            status_code=409,
            detail="A pending invite already exists for this vendor. Use resend to extend it.",
        )

    r = await db_client.post(
        _url("/rest/v1/studio_vendor_invites"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "studio_id":                  user.studio_id,
            "vendor_id":                  body.vendor_id,
            "review_collaboration_mode":  body.review_collaboration_mode,
            "expires_at":                 _expiry_iso(),
            "created_by":                 user.id,
        },
    )
    return r.json()[0]


@router.post("/invites/{invite_id}/resend")
async def resend_invite(invite_id: str, user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "id":        f"eq.{invite_id}",
            "studio_id": f"eq.{user.studio_id}",
            "select":    "id,status,resend_count",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Invite not found")
    invite = rows[0]
    if invite["status"] != "pending":
        raise HTTPException(status_code=409, detail="Can only resend a pending invite")
    if invite["resend_count"] >= _MAX_RESENDS:
        raise HTTPException(
            status_code=409,
            detail=f"Maximum resends ({_MAX_RESENDS}) reached. Cancel and create a new invite.",
        )

    await db_client.patch(
        _url("/rest/v1/studio_vendor_invites"),
        params={"id": f"eq.{invite_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={
            "expires_at":   _expiry_iso(),
            "resend_count": invite["resend_count"] + 1,
        },
    )
    return {"ok": True, "resend_count": invite["resend_count"] + 1}


@router.delete("/invites/{invite_id}")
async def cancel_invite(invite_id: str, user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "id":        f"eq.{invite_id}",
            "studio_id": f"eq.{user.studio_id}",
            "select":    "id,status",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Invite not found")
    if rows[0]["status"] != "pending":
        raise HTTPException(status_code=409, detail="Invite is no longer pending")

    await db_client.patch(
        _url("/rest/v1/studio_vendor_invites"),
        params={"id": f"eq.{invite_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"status": "cancelled"},
    )
    return {"ok": True}


# ── vendor: incoming invites + accept/reject ──────────────────────────────────

@router.get("/invites/sent")
async def list_sent_invites(user: CurrentUser = Depends(require_studio)):
    """Studio: pending invites they have sent, with vendor name + handle resolved."""
    now = _now_iso()
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "studio_id":  f"eq.{user.studio_id}",
            "status":     "eq.pending",
            "expires_at": f"gt.{now}",
            "select":     "id,vendor_id,review_collaboration_mode,expires_at,resend_count,created_at",
            "order":      "created_at.desc",
        },
        headers=_headers(),
    )
    invites = r.json()
    if not invites:
        return []

    vendor_ids = list({inv["vendor_id"] for inv in invites})
    r_vendors = await db_client.get(
        _url("/rest/v1/vendors"),
        params={"id": f"in.({','.join(vendor_ids)})", "select": "id,name,handle"},
        headers=_headers(),
    )
    vendor_map = {v["id"]: v for v in r_vendors.json()}
    for inv in invites:
        v = vendor_map.get(inv["vendor_id"], {})
        inv["vendor_name"]   = v.get("name", "Unknown Vendor")
        inv["vendor_handle"] = v.get("handle")
    return invites


@router.get("/invites/incoming")
async def list_incoming_invites(user: CurrentUser = Depends(require_vendor)):
    now = _now_iso()
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "vendor_id":  f"eq.{user.vendor_id}",
            "status":     "eq.pending",
            "expires_at": f"gt.{now}",
            "select":     "id,studio_id,review_collaboration_mode,expires_at,resend_count,created_at",
            "order":      "created_at.desc",
        },
        headers=_headers(),
    )
    invites = r.json()
    if not invites:
        return []

    # Resolve studio names
    studio_ids = list({inv["studio_id"] for inv in invites})
    r_studios = await db_client.get(
        _url("/rest/v1/studios"),
        params={"id": f"in.({','.join(studio_ids)})", "select": "id,name"},
        headers=_headers(),
    )
    studio_map = {s["id"]: s["name"] for s in r_studios.json()}
    for inv in invites:
        inv["studio_name"] = studio_map.get(inv["studio_id"], "Unknown Studio")
    return invites


@router.get("/invites/{invite_id}/preview")
async def preview_invite(invite_id: str, user: CurrentUser = Depends(require_vendor)):
    """Returns studio name + their current live payload templates for the vendor to review."""
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "id":        f"eq.{invite_id}",
            "vendor_id": f"eq.{user.vendor_id}",
            "select":    "id,studio_id,review_collaboration_mode,expires_at,status",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Invite not found")
    invite = rows[0]
    if invite["status"] != "pending":
        raise HTTPException(status_code=409, detail="Invite is no longer pending")
    if datetime.fromisoformat(invite["expires_at"]) < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Invite has expired")

    studio_id = invite["studio_id"]

    # Fetch studio name and their current payload templates in parallel
    r_studio, r_templates = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/studios"),
            params={"id": f"eq.{studio_id}", "select": "id,name"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/payload_templates"),
            params={"studio_id": f"eq.{studio_id}", "select": "id,name,field_schema", "order": "name.asc"},
            headers=_headers(),
        ),
    )

    studio_rows = r_studio.json()
    studio_name = studio_rows[0]["name"] if studio_rows else "Unknown Studio"

    return {
        "invite_id":                  invite_id,
        "studio_id":                  studio_id,
        "studio_name":                studio_name,
        "review_collaboration_mode":  invite["review_collaboration_mode"],
        "expires_at":                 invite["expires_at"],
        "payload_templates":          r_templates.json(),
    }


@router.post("/invites/{invite_id}/accept", status_code=201)
async def accept_invite(invite_id: str, user: CurrentUser = Depends(require_vendor)):
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "id":        f"eq.{invite_id}",
            "vendor_id": f"eq.{user.vendor_id}",
            "select":    "id,studio_id,review_collaboration_mode,expires_at,status",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Invite not found")
    invite = rows[0]
    if invite["status"] != "pending":
        raise HTTPException(status_code=409, detail="Invite is no longer pending")
    if datetime.fromisoformat(invite["expires_at"]) < datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Invite has expired")

    studio_id = invite["studio_id"]

    # Snapshot the studio's current payload templates at acceptance time
    r_templates = await db_client.get(
        _url("/rest/v1/payload_templates"),
        params={"studio_id": f"eq.{studio_id}", "select": "id,name,field_schema", "order": "name.asc"},
        headers=_headers(),
    )
    payload_format_snapshot = {"templates": r_templates.json()}

    now = _now_iso()

    # Create link + mark invite accepted atomically-ish (PostgREST has no transactions,
    # but the unique index on pending invites prevents a second accept racing through)
    r_link = await db_client.post(
        _url("/rest/v1/studio_vendor_links"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "studio_id":                 studio_id,
            "vendor_id":                 user.vendor_id,
            "invite_id":                 invite_id,
            "payload_format_snapshot":   payload_format_snapshot,
            "review_collaboration_mode": invite["review_collaboration_mode"],
        },
    )
    link = r_link.json()[0]

    await db_client.patch(
        _url("/rest/v1/studio_vendor_invites"),
        params={"id": f"eq.{invite_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"status": "accepted", "accepted_at": now},
    )

    return {"ok": True, "link_id": link["id"]}


@router.post("/invites/{invite_id}/reject")
async def reject_invite(invite_id: str, user: CurrentUser = Depends(require_vendor)):
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_invites"),
        params={
            "id":        f"eq.{invite_id}",
            "vendor_id": f"eq.{user.vendor_id}",
            "select":    "id,status",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Invite not found")
    if rows[0]["status"] != "pending":
        raise HTTPException(status_code=409, detail="Invite is no longer pending")

    await db_client.patch(
        _url("/rest/v1/studio_vendor_invites"),
        params={"id": f"eq.{invite_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"status": "cancelled"},
    )
    return {"ok": True}


# ── link management ───────────────────────────────────────────────────────────

@router.get("/links")
async def list_links(user: CurrentUser = Depends(get_current_user)):
    if user.role == "studio":
        params = {
            "studio_id": f"eq.{user.studio_id}",
            "status":    "eq.active",
            "select":    "id,vendor_id,review_collaboration_mode,created_at",
            "order":     "created_at.desc",
        }
        r = await db_client.get(_url("/rest/v1/studio_vendor_links"), params=params, headers=_headers())
        links = r.json()
        if not links:
            return []
        vendor_ids = list({lnk["vendor_id"] for lnk in links})
        r_vendors = await db_client.get(
            _url("/rest/v1/vendors"),
            params={"id": f"in.({','.join(vendor_ids)})", "select": "id,name,handle"},
            headers=_headers(),
        )
        vendor_map = {v["id"]: v for v in r_vendors.json()}
        for lnk in links:
            lnk["vendor"] = vendor_map.get(lnk["vendor_id"], {})
        return links

    else:  # vendor
        params = {
            "vendor_id": f"eq.{user.vendor_id}",
            "status":    "eq.active",
            "select":    "id,studio_id,review_collaboration_mode,created_at",
            "order":     "created_at.desc",
        }
        r = await db_client.get(_url("/rest/v1/studio_vendor_links"), params=params, headers=_headers())
        links = r.json()
        if not links:
            return []
        studio_ids = list({lnk["studio_id"] for lnk in links})
        r_studios = await db_client.get(
            _url("/rest/v1/studios"),
            params={"id": f"in.({','.join(studio_ids)})", "select": "id,name"},
            headers=_headers(),
        )
        studio_map = {s["id"]: s for s in r_studios.json()}
        for lnk in links:
            lnk["studio"] = studio_map.get(lnk["studio_id"], {})
        return links


@router.delete("/links/{link_id}")
async def cancel_link(link_id: str, user: CurrentUser = Depends(get_current_user)):
    # Verify the link belongs to the caller
    if user.role == "studio":
        owner_filter = {"studio_id": f"eq.{user.studio_id}"}
        cancelled_status = "cancelled_by_studio"
    else:
        owner_filter = {"vendor_id": f"eq.{user.vendor_id}"}
        cancelled_status = "cancelled_by_vendor"

    r = await db_client.get(
        _url("/rest/v1/studio_vendor_links"),
        params={"id": f"eq.{link_id}", **owner_filter, "status": "eq.active", "select": "id,studio_id,vendor_id"},
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Active link not found")
    link = rows[0]

    now = _now_iso()

    # 1. Find all outstanding dispatches for this studio+vendor pair
    r_dispatches = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "sender_studio_id":    f"eq.{link['studio_id']}",
            "recipient_vendor_id": f"eq.{link['vendor_id']}",
            "revoked_at":          "is.null",
            "select":              "id",
        },
        headers=_headers(),
    )
    dispatch_rows = r_dispatches.json()
    dispatch_ids = [d["id"] for d in dispatch_rows]

    # 2. Revoke all outstanding dispatches
    if dispatch_ids:
        await db_client.patch(
            _url("/rest/v1/payload_dispatches"),
            params={
                "sender_studio_id":    f"eq.{link['studio_id']}",
                "recipient_vendor_id": f"eq.{link['vendor_id']}",
                "revoked_at":          "is.null",
            },
            headers=_headers({"Prefer": "return=minimal"}),
            json={"revoked_at": now},
        )

    # 3. Write audit header
    r_audit = await db_client.post(
        _url("/rest/v1/link_cancellation_audit"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "link_id":        link_id,
            "cancelled_by":   user.id,
            "dispatch_count": len(dispatch_ids),
            "revoked_at":     now,
        },
    )
    audit_id = r_audit.json()[0]["id"]

    # 4. Write per-dispatch audit rows
    if dispatch_ids:
        await db_client.post(
            _url("/rest/v1/link_cancellation_dispatches"),
            headers=_headers({"Prefer": "return=minimal"}),
            json=[{"link_cancellation_id": audit_id, "dispatch_id": did} for did in dispatch_ids],
        )

    # 5. Mark link cancelled
    await db_client.patch(
        _url("/rest/v1/studio_vendor_links"),
        params={"id": f"eq.{link_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"status": cancelled_status, "cancelled_at": now, "cancelled_by": user.id, "updated_at": now},
    )

    return {"ok": True, "dispatches_revoked": len(dispatch_ids)}


# ── vendor: ingest template per studio ───────────────────────────────────────

@router.get("/template/{studio_id}")
async def get_template(studio_id: str, user: CurrentUser = Depends(require_vendor)):
    r = await db_client.get(
        _url("/rest/v1/vendor_studio_ingest_templates"),
        params={
            "vendor_id": f"eq.{user.vendor_id}",
            "studio_id": f"eq.{studio_id}",
            "select":    "*",
        },
        headers=_headers(),
    )
    rows = r.json()
    return rows[0] if rows else None


class TemplateBody(BaseModel):
    link_id: str
    field_mappings: dict
    meta_summary_config: Optional[dict] = None


@router.put("/template/{studio_id}")
async def upsert_template(studio_id: str, body: TemplateBody, user: CurrentUser = Depends(require_vendor)):
    # Verify link belongs to this vendor+studio pair and is active
    r_link = await db_client.get(
        _url("/rest/v1/studio_vendor_links"),
        params={
            "id":        f"eq.{body.link_id}",
            "vendor_id": f"eq.{user.vendor_id}",
            "studio_id": f"eq.{studio_id}",
            "status":    "eq.active",
            "select":    "id",
        },
        headers=_headers(),
    )
    if not r_link.json():
        raise HTTPException(status_code=404, detail="Active link not found for this studio")

    now = _now_iso()
    payload = {
        "vendor_id":            user.vendor_id,
        "studio_id":            studio_id,
        "link_id":              body.link_id,
        "field_mappings":       body.field_mappings,
        "meta_summary_config":  body.meta_summary_config,
        "updated_at":           now,
    }

    await db_client.post(
        _url("/rest/v1/vendor_studio_ingest_templates?on_conflict=vendor_id,studio_id"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json=payload,
    )
    return {"ok": True}
