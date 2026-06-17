import asyncio
import logging
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_studio, require_vendor
from lib.db import db_client, _url, _headers, _use_user_identity
from lib.org_directory import resolve_counterparty_names

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
    if _use_user_identity():
        # Flag-on: vendors are RLS-scoped to their own org (v_sel), so a studio can't read the global
        # vendor table directly. rpc_search_vendors (DEFINER) exposes id/name/handle by handle prefix —
        # vendor handles are discoverable by design (the invite model). No invite_code.
        r = await db_client.post(
            _url("/rest/v1/rpc/rpc_search_vendors"),
            json={"p_query": q},
            headers=_headers(),
        )
        return r.json() if r.is_success else []
    # Flag-off (legacy service-role): direct handle search.
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

    # Vendor existence is enforced by the studio_vendor_invites.vendor_id FK on insert below (flag-on a
    # studio can't read the global vendors table to pre-check). A bad id surfaces as a 23503 → 404.

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
    if not r.is_success and "23503" in r.text:
        # FK violation (SQLSTATE 23503) = the vendor_id doesn't exist.
        raise HTTPException(status_code=404, detail="Vendor not found")
    if not r.is_success or not r.json():
        log.error("Invite create failed for studio %s vendor %s: %s", user.studio_id, body.vendor_id, r.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create invite")
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
    vendor_map = await resolve_counterparty_names("vendor", vendor_ids)
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

    # Resolve studio names (link/invite-authorized directory; RLS-safe, name only)
    studio_ids = list({inv["studio_id"] for inv in invites})
    studio_map = await resolve_counterparty_names("studio", studio_ids)
    for inv in invites:
        inv["studio_name"] = studio_map.get(inv["studio_id"], {}).get("name", "Unknown Studio")
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

    # Studio name via the link/invite directory (RLS-safe; name only, never invite_code).
    studio_map = await resolve_counterparty_names("studio", [studio_id])
    studio_name = studio_map.get(studio_id, {}).get("name", "Unknown Studio")

    # The inviting studio's payload templates. Flag-on a vendor can't read payload_templates (pt_all is
    # studio-only) → rpc_invite_studio_templates, authorized by this pending invite to the caller's
    # vendor. Flag-off: legacy direct read.
    if _use_user_identity():
        r_templates = await db_client.post(
            _url("/rest/v1/rpc/rpc_invite_studio_templates"),
            json={"p_invite_id": invite_id},
            headers=_headers(),
        )
        templates = r_templates.json() if r_templates.is_success else []
    else:
        r_templates = await db_client.get(
            _url("/rest/v1/payload_templates"),
            params={"studio_id": f"eq.{studio_id}", "select": "id,name,field_schema", "order": "name.asc"},
            headers=_headers(),
        )
        templates = r_templates.json()

    return {
        "invite_id":                  invite_id,
        "studio_id":                  studio_id,
        "studio_name":                studio_name,
        "review_collaboration_mode":  invite["review_collaboration_mode"],
        "expires_at":                 invite["expires_at"],
        "payload_templates":          templates,
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

    if _use_user_identity():
        # Flag-on: a vendor can't read the studio's payload_templates (pt_all is studio-only) nor INSERT
        # studio_vendor_links under RLS. rpc_accept_link_invite (SECURITY DEFINER, vendor-authz via
        # auth.uid()) snapshots the templates + creates the active link + marks the invite accepted in one
        # txn, and returns the new link id.
        rr = await db_client.post(
            _url("/rest/v1/rpc/rpc_accept_link_invite"),
            json={"p_invite_id": invite_id},
            headers=_headers(),
        )
        if not rr.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to accept invite: {rr.text}")
        return {"ok": True, "link_id": rr.json()}

    # Flag-off (service-role): snapshot the studio's current payload templates at acceptance time
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
            "select":    "id,vendor_id,review_collaboration_mode,review_protocol_def_id,created_at",
            "order":     "created_at.desc",
        }
        r = await db_client.get(_url("/rest/v1/studio_vendor_links"), params=params, headers=_headers())
        links = r.json()
        if not links:
            return []
        vendor_ids = list({lnk["vendor_id"] for lnk in links})
        vendor_map = await resolve_counterparty_names("vendor", vendor_ids)
        for lnk in links:
            lnk["vendor"] = vendor_map.get(lnk["vendor_id"], {})
        return links

    else:  # vendor
        params = {
            "vendor_id": f"eq.{user.vendor_id}",
            "status":    "eq.active",
            "select":    "id,studio_id,review_collaboration_mode,review_protocol_def_id,created_at",
            "order":     "created_at.desc",
        }
        r = await db_client.get(_url("/rest/v1/studio_vendor_links"), params=params, headers=_headers())
        links = r.json()
        if not links:
            return []
        studio_ids = list({lnk["studio_id"] for lnk in links})
        studio_map = await resolve_counterparty_names("studio", studio_ids)
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

    if _use_user_identity():
        # Flag-on: rpc_cancel_link (is_link_party authz) revokes the pair's live dispatches, writes the
        # cancellation audit + per-dispatch rows, and marks the link cancelled in one txn — none of which
        # a user may write directly under RLS. Returns the count of dispatches revoked.
        rr = await db_client.post(
            _url("/rest/v1/rpc/rpc_cancel_link"),
            json={"p_link_id": link_id, "p_reason": None},
            headers=_headers(),
        )
        if not rr.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to cancel link: {rr.text}")
        return {"ok": True, "dispatches_revoked": rr.json()}

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
