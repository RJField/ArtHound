"""
Org member management routes.

Admin-gated routes in this codebase (update this list when adding new admin routes):
  POST   /api/init/...                    — fields/source setup (routes/init.py)
  POST   /api/setup/...                   — field mapping config (routes/fields.py, routes/matrix.py)
  POST   /api/payloads/dispatch           — asset dispatch to vendor (routes/payload.py)
  DELETE /api/payloads/{id}/revoke        — revoke a dispatch (routes/payload.py)
  POST   /api/schedule/generate           — generate schedule (routes/schedule.py)
  POST   /api/org/join-requests/{id}/accept  — accept a member join request (this file)
  POST   /api/org/join-requests/{id}/decline — decline a member join request (this file)
  POST   /api/org/invite-code/regenerate     — regenerate invite code (this file)
  PATCH  /api/org/members/{user_id}/role     — change member role (this file)
  DELETE /api/org/members/{user_id}          — remove a member (this file)
"""

import asyncio
import logging
import secrets
import string
import time
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, invalidate_member_cache, require_admin
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()

# ── Simple in-memory rate limiter for the public resolve endpoint ─────────────
# Single-process only. For multi-worker production, replace with Redis-backed limiter.
_RATE_WINDOW = 60   # seconds
_RATE_MAX    = 10   # requests per window per IP
_rate_store: dict[str, list[float]] = defaultdict(list)


def _check_rate_limit(ip: str) -> None:
    now = time.monotonic()
    cutoff = now - _RATE_WINDOW
    hits = [t for t in _rate_store[ip] if t > cutoff]
    _rate_store[ip] = hits
    if len(hits) >= _RATE_MAX:
        raise HTTPException(status_code=429, detail="Too many requests")
    hits.append(now)


def _generate_invite_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _org_ids(user: CurrentUser) -> tuple[str, str]:
    """Return (org_type, org_id) for the current user."""
    org_id = user.studio_id if user.role == "studio" else user.vendor_id
    if not org_id:
        raise HTTPException(status_code=403, detail="No organisation linked to account")
    return user.role, org_id


async def _get_user_emails(user_ids: list[str]) -> dict[str, str]:
    """Batch-fetch email for each user_id via the Supabase Auth admin API."""
    if not user_ids:
        return {}
    coros = [
        db_client.get(_url(f"/auth/v1/admin/users/{uid}"), headers=_headers())
        for uid in user_ids
    ]
    responses = await asyncio.gather(*coros, return_exceptions=True)
    result: dict[str, str] = {}
    for uid, r in zip(user_ids, responses):
        if isinstance(r, Exception):
            continue
        if r.is_success:
            result[uid] = r.json().get("email", "")
    return result


# ── Public endpoint — invite code resolution ─────────────────────────────────

@router.get("/invite-code/{code}/resolve")
async def resolve_invite_code(code: str, request: Request):
    """
    Resolve an invite code to an org name and type. Unauthenticated.
    Rate-limited to 10 requests/min/IP to prevent org-name enumeration.
    Returns 404 on miss (not a distinct error) to avoid leaking code existence.
    """
    ip = request.client.host if request.client else "unknown"
    _check_rate_limit(ip)

    code = code.strip().upper()

    studio_r = await db_client.get(
        _url("/rest/v1/studios"),
        params={"invite_code": f"eq.{code}", "select": "id,name"},
        headers=_headers(),
    )
    if studio_r.is_success and studio_r.json():
        row = studio_r.json()[0]
        return {"org_name": row["name"], "org_type": "studio"}

    vendor_r = await db_client.get(
        _url("/rest/v1/vendors"),
        params={"invite_code": f"eq.{code}", "select": "id,name"},
        headers=_headers(),
    )
    if vendor_r.is_success and vendor_r.json():
        row = vendor_r.json()[0]
        return {"org_name": row["name"], "org_type": "vendor"}

    raise HTTPException(status_code=404, detail="Invite code not found")


# ── Org hub ───────────────────────────────────────────────────────────────────

@router.get("/org/hub")
async def get_org_hub(user: CurrentUser = Depends(get_current_user)):
    """
    Return org info, member list, and pending join requests.
    Pending requests are included only for admins/owners.
    """
    org_type, org_id = _org_ids(user)
    org_table    = "studios"        if org_type == "studio" else "vendors"
    member_table = "studio_members" if org_type == "studio" else "vendor_members"
    req_table    = "studio_join_requests" if org_type == "studio" else "vendor_join_requests"
    org_fk       = "studio_id"      if org_type == "studio" else "vendor_id"

    org_select = "id,name,invite_code" + (",initialized_at" if org_type == "studio" else ",handle,initialized_at")

    org_r, members_r = await asyncio.gather(
        db_client.get(
            _url(f"/rest/v1/{org_table}"),
            params={"id": f"eq.{org_id}", "select": org_select},
            headers=_headers(),
        ),
        db_client.get(
            _url(f"/rest/v1/{member_table}"),
            params={org_fk: f"eq.{org_id}", "select": "user_id,member_role,created_at"},
            headers=_headers(),
        ),
    )
    org_r.raise_for_status()
    members_r.raise_for_status()

    org_row = org_r.json()[0]
    member_rows = members_r.json()

    member_ids = [m["user_id"] for m in member_rows]
    emails = await _get_user_emails(member_ids)

    members = [
        {
            "user_id":     m["user_id"],
            "email":       emails.get(m["user_id"], ""),
            "member_role": m["member_role"],
            "joined_at":   m["created_at"],
            "is_self":     m["user_id"] == user.id,
        }
        for m in member_rows
    ]

    pending_requests: list[dict] = []
    if user.is_admin:
        req_r = await db_client.get(
            _url(f"/rest/v1/{req_table}"),
            params={org_fk: f"eq.{org_id}", "status": "eq.pending", "select": "id,user_id,created_at"},
            headers=_headers(),
        )
        if req_r.is_success:
            req_rows = req_r.json()
            req_ids = [rr["user_id"] for rr in req_rows]
            req_emails = await _get_user_emails(req_ids)
            pending_requests = [
                {
                    "id":         rr["id"],
                    "user_id":    rr["user_id"],
                    "email":      req_emails.get(rr["user_id"], ""),
                    "created_at": rr["created_at"],
                }
                for rr in req_rows
            ]

    return {
        "org":              org_row,
        "members":          members,
        "pending_requests": pending_requests,
    }


# ── Join request management ───────────────────────────────────────────────────

@router.get("/org/join-requests")
async def list_join_requests(user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    org_type, org_id = _org_ids(user)
    req_table = "studio_join_requests" if org_type == "studio" else "vendor_join_requests"
    org_fk    = "studio_id"            if org_type == "studio" else "vendor_id"

    r = await db_client.get(
        _url(f"/rest/v1/{req_table}"),
        params={org_fk: f"eq.{org_id}", "status": "eq.pending", "select": "id,user_id,created_at"},
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    emails = await _get_user_emails([rr["user_id"] for rr in rows])
    return [
        {"id": rr["id"], "user_id": rr["user_id"], "email": emails.get(rr["user_id"], ""), "created_at": rr["created_at"]}
        for rr in rows
    ]


@router.post("/org/join-requests/{request_id}/accept")
async def accept_join_request(request_id: str, user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    org_type, org_id = _org_ids(user)
    req_table    = "studio_join_requests" if org_type == "studio" else "vendor_join_requests"
    member_table = "studio_members"       if org_type == "studio" else "vendor_members"
    org_fk       = "studio_id"           if org_type == "studio" else "vendor_id"

    # Fetch the request and verify it belongs to this org.
    r = await db_client.get(
        _url(f"/rest/v1/{req_table}"),
        params={"id": f"eq.{request_id}", "select": "id,user_id,status", org_fk: f"eq.{org_id}"},
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Join request not found")
    req = rows[0]
    if req["status"] != "pending":
        raise HTTPException(status_code=409, detail="Request is no longer pending")

    new_user_id = req["user_id"]
    now = datetime.now(timezone.utc).isoformat()

    # Insert membership row at 'user' role — explicit promotion is a separate action.
    member_payload = {"user_id": new_user_id, org_fk: org_id, "member_role": "user"}
    r2 = await db_client.post(
        _url(f"/rest/v1/{member_table}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json=member_payload,
    )
    if not r2.is_success:
        log.error("Member insert failed accepting request %s: %s", request_id, r2.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create membership")

    # Mark request accepted.
    await db_client.patch(
        _url(f"/rest/v1/{req_table}"),
        params={"id": f"eq.{request_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"status": "accepted", "resolved_at": now, "resolved_by": user.id},
    )

    # Invalidate cache so the new member sees access on their next /api/user/me call.
    invalidate_member_cache(new_user_id)
    return {"ok": True}


@router.post("/org/join-requests/{request_id}/decline")
async def decline_join_request(request_id: str, user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    org_type, org_id = _org_ids(user)
    req_table = "studio_join_requests" if org_type == "studio" else "vendor_join_requests"
    org_fk    = "studio_id"            if org_type == "studio" else "vendor_id"

    r = await db_client.get(
        _url(f"/rest/v1/{req_table}"),
        params={"id": f"eq.{request_id}", "select": "id,status", org_fk: f"eq.{org_id}"},
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Join request not found")
    if rows[0]["status"] != "pending":
        raise HTTPException(status_code=409, detail="Request is no longer pending")

    now = datetime.now(timezone.utc).isoformat()
    await db_client.patch(
        _url(f"/rest/v1/{req_table}"),
        params={"id": f"eq.{request_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"status": "declined", "resolved_at": now, "resolved_by": user.id},
    )
    return {"ok": True}


# ── Invite code regeneration ──────────────────────────────────────────────────

@router.post("/org/invite-code/regenerate")
async def regenerate_invite_code(user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    org_type, org_id = _org_ids(user)
    org_table = "studios" if org_type == "studio" else "vendors"

    new_code = _generate_invite_code()
    r = await db_client.patch(
        _url(f"/rest/v1/{org_table}"),
        params={"id": f"eq.{org_id}"},
        headers=_headers({"Prefer": "return=representation"}),
        json={"invite_code": new_code},
    )
    if not r.is_success:
        log.error("Invite code regeneration failed for org %s: %s", org_id, r.text[:300])
        raise HTTPException(status_code=500, detail="Failed to regenerate invite code")

    return {"invite_code": r.json()[0]["invite_code"]}


# ── Member role management ────────────────────────────────────────────────────

class RoleBody(BaseModel):
    role: str


@router.patch("/org/members/{target_user_id}/role")
async def update_member_role(
    target_user_id: str,
    body: RoleBody,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Change a member's role. Rules:
    - Any admin or owner can change user ↔ admin.
    - Only the current owner can promote someone to owner (ownership transfer).
      This atomically demotes the current owner to admin via a DB function.
    - No one can demote the owner through this endpoint except via transfer.
    """
    if body.role not in ("owner", "admin", "user"):
        raise HTTPException(status_code=422, detail="role must be owner, admin, or user")

    require_admin(user)
    org_type, org_id = _org_ids(user)
    member_table = "studio_members" if org_type == "studio" else "vendor_members"
    org_fk       = "studio_id"     if org_type == "studio" else "vendor_id"

    # Fetch target's current role.
    r = await db_client.get(
        _url(f"/rest/v1/{member_table}"),
        params={"user_id": f"eq.{target_user_id}", org_fk: f"eq.{org_id}", "select": "member_role"},
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Member not found")
    current_role = rows[0]["member_role"]

    if current_role == "owner" and body.role != "owner":
        raise HTTPException(status_code=403, detail="Cannot demote owner — use ownership transfer instead")

    if body.role == "owner":
        # Ownership transfer: only the current owner may do this.
        if user.member_role != "owner":
            raise HTTPException(status_code=403, detail="Only the owner can transfer ownership")
        if target_user_id == user.id:
            raise HTTPException(status_code=422, detail="You are already the owner")

        # Atomic transfer via DB function.
        r2 = await db_client.post(
            _url("/rest/v1/rpc/transfer_org_ownership"),
            headers=_headers(),
            json={
                "p_org_type":          org_type,
                "p_org_id":            org_id,
                "p_current_owner_id":  user.id,
                "p_new_owner_id":      target_user_id,
            },
        )
        if not r2.is_success:
            log.error("Ownership transfer failed: %s", r2.text[:300])
            raise HTTPException(status_code=500, detail="Ownership transfer failed")
        invalidate_member_cache(user.id)
        invalidate_member_cache(target_user_id)
        return {"ok": True}

    # admin ↔ user promotion/demotion — admins cannot touch other admins' roles.
    if current_role == "admin" and user.member_role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can change admin roles")

    r3 = await db_client.patch(
        _url(f"/rest/v1/{member_table}"),
        params={"user_id": f"eq.{target_user_id}", org_fk: f"eq.{org_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"member_role": body.role},
    )
    if not r3.is_success:
        raise HTTPException(status_code=500, detail="Failed to update member role")

    invalidate_member_cache(target_user_id)
    return {"ok": True}


# ── Member removal ────────────────────────────────────────────────────────────

@router.delete("/org/members/{target_user_id}")
async def remove_member(
    target_user_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    require_admin(user)
    org_type, org_id = _org_ids(user)
    member_table = "studio_members" if org_type == "studio" else "vendor_members"
    org_fk       = "studio_id"     if org_type == "studio" else "vendor_id"

    # Prevent removal of the owner.
    r = await db_client.get(
        _url(f"/rest/v1/{member_table}"),
        params={"user_id": f"eq.{target_user_id}", org_fk: f"eq.{org_id}", "select": "member_role"},
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Member not found")
    if rows[0]["member_role"] == "owner":
        raise HTTPException(status_code=403, detail="Cannot remove the org owner")

    # Admins cannot remove other admins.
    if rows[0]["member_role"] == "admin" and user.member_role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can remove admins")

    r2 = await db_client.delete(
        _url(f"/rest/v1/{member_table}"),
        params={"user_id": f"eq.{target_user_id}", org_fk: f"eq.{org_id}"},
        headers=_headers(),
    )
    if not r2.is_success:
        raise HTTPException(status_code=500, detail="Failed to remove member")

    invalidate_member_cache(target_user_id)
    return {"ok": True}
