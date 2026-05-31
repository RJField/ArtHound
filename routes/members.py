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
from lib.db import db_client, _url, _headers, _admin_headers, _anon_headers, _use_user_identity

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
        db_client.get(_url(f"/auth/v1/admin/users/{uid}"), headers=_admin_headers())
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


async def _write_audit(
    org_type: str,
    org_id: str,
    actor_id: str,
    action: str,
    *,
    target_user_id: Optional[str] = None,
    old_role: Optional[str] = None,
    new_role: Optional[str] = None,
) -> None:
    try:
        if _use_user_identity():
            # Flag-on: org_role_audit_log is SELECT-only for users; rpc_write_org_audit (is_org_admin
            # authz, actor = the caller via auth.uid()) performs the insert. Still best-effort.
            await db_client.post(
                _url("/rest/v1/rpc/rpc_write_org_audit"),
                headers=_headers(),
                json={
                    "p_org_type": org_type,
                    "p_org_id": org_id,
                    "p_action": action,
                    "p_target_user_id": target_user_id,
                    "p_old_role": old_role,
                    "p_new_role": new_role,
                },
            )
        else:
            await db_client.post(
                _url("/rest/v1/org_role_audit_log"),
                headers=_headers({"Prefer": "return=minimal"}),
                json={
                    "org_type": org_type,
                    "org_id": org_id,
                    "actor_id": actor_id,
                    "action": action,
                    "target_user_id": target_user_id,
                    "old_role": old_role,
                    "new_role": new_role,
                },
            )
    except Exception:
        log.exception("Failed to write org_role_audit_log entry")


def _audit(
    org_type: str,
    org_id: str,
    actor_id: str,
    action: str,
    *,
    target_user_id: Optional[str] = None,
    old_role: Optional[str] = None,
    new_role: Optional[str] = None,
) -> None:
    """Fire-and-forget audit log entry. Never blocks or raises."""
    asyncio.create_task(
        _write_audit(org_type, org_id, actor_id, action,
                     target_user_id=target_user_id, old_role=old_role, new_role=new_role)
    )


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

    # Public, pre-login: resolve via the anon SECURITY DEFINER RPC (migration 6). The studios/vendors
    # tables deny anon/non-member reads under RLS; the RPC returns ONLY name+type, never ids.
    r = await db_client.post(
        _url("/rest/v1/rpc/rpc_resolve_invite"),
        headers=_anon_headers(),
        json={"p_code": code},
    )
    rows = r.json() if r.is_success else []
    if rows:
        return {"org_name": rows[0]["org_name"], "org_type": rows[0]["org_type"]}

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

    if _use_user_identity():
        # Flag-on: membership insert + request-status update are user-unwritable under RLS;
        # rpc_decide_join_request (is_org_admin authz) does both atomically in one txn.
        rr = await db_client.post(
            _url("/rest/v1/rpc/rpc_decide_join_request"),
            headers=_headers(),
            json={"p_org_type": org_type, "p_request_id": request_id, "p_decision": "approve"},
        )
        if not rr.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to accept request: {rr.text}")
    else:
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
    _audit(org_type, org_id, user.id, "member_accepted", target_user_id=new_user_id, new_role="user")
    return {"ok": True}


@router.post("/org/join-requests/{request_id}/decline")
async def decline_join_request(request_id: str, user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    org_type, org_id = _org_ids(user)
    req_table = "studio_join_requests" if org_type == "studio" else "vendor_join_requests"
    org_fk    = "studio_id"            if org_type == "studio" else "vendor_id"

    r = await db_client.get(
        _url(f"/rest/v1/{req_table}"),
        params={"id": f"eq.{request_id}", "select": "id,user_id,status", org_fk: f"eq.{org_id}"},
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Join request not found")
    if rows[0]["status"] != "pending":
        raise HTTPException(status_code=409, detail="Request is no longer pending")

    declined_user_id = rows[0]["user_id"]
    if _use_user_identity():
        # Flag-on: request-status update is user-unwritable under RLS; rpc_decide_join_request (reject)
        # sets status='declined' (the CHECK constraint's allowed value) under is_org_admin authz.
        rr = await db_client.post(
            _url("/rest/v1/rpc/rpc_decide_join_request"),
            headers=_headers(),
            json={"p_org_type": org_type, "p_request_id": request_id, "p_decision": "reject"},
        )
        if not rr.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to decline request: {rr.text}")
    else:
        now = datetime.now(timezone.utc).isoformat()
        await db_client.patch(
            _url(f"/rest/v1/{req_table}"),
            params={"id": f"eq.{request_id}"},
            headers=_headers({"Prefer": "return=minimal"}),
            json={"status": "declined", "resolved_at": now, "resolved_by": user.id},
        )
    _audit(org_type, org_id, user.id, "member_declined", target_user_id=declined_user_id)
    return {"ok": True}


# ── Invite code regeneration ──────────────────────────────────────────────────

@router.post("/org/invite-code/regenerate")
async def regenerate_invite_code(user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    org_type, org_id = _org_ids(user)
    org_table = "studios" if org_type == "studio" else "vendors"

    new_code = _generate_invite_code()
    if _use_user_identity():
        # Flag-on: studios/vendors are write-RPC-only (pattern A); rpc_regenerate_invite_code (is_org_admin
        # authz) updates ONLY invite_code with the caller-generated code.
        r = await db_client.post(
            _url("/rest/v1/rpc/rpc_regenerate_invite_code"),
            headers=_headers(),
            json={"p_org_type": org_type, "p_org_id": org_id, "p_code": new_code},
        )
        if not r.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to regenerate invite code: {r.text}")
    else:
        r = await db_client.patch(
            _url(f"/rest/v1/{org_table}"),
            params={"id": f"eq.{org_id}"},
            headers=_headers({"Prefer": "return=representation"}),
            json={"invite_code": new_code},
        )
        if not r.is_success:
            log.error("Invite code regeneration failed for org %s: %s", org_id, r.text[:300])
            raise HTTPException(status_code=500, detail="Failed to regenerate invite code")

    _audit(org_type, org_id, user.id, "invite_code_regenerated")
    return {"invite_code": new_code}


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
        if _use_user_identity():
            # Flag-on: rpc_transfer_ownership derives the current owner from auth.uid() (no spoofable
            # arg) and swaps roles atomically; membership writes are otherwise RLS-denied to users.
            r2 = await db_client.post(
                _url("/rest/v1/rpc/rpc_transfer_ownership"),
                headers=_headers(),
                json={"p_org_type": org_type, "p_org_id": org_id, "p_new_owner": target_user_id},
            )
        else:
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
        _audit(org_type, org_id, user.id, "ownership_transferred",
               target_user_id=target_user_id, old_role=current_role, new_role="owner")
        return {"ok": True}

    # admin ↔ user promotion/demotion — admins cannot touch other admins' roles.
    if current_role == "admin" and user.member_role != "owner":
        raise HTTPException(status_code=403, detail="Only the owner can change admin roles")

    if _use_user_identity():
        # Flag-on: membership updates are user-unwritable under RLS; rpc_update_member_role (is_org_admin
        # authz; refuses 'owner') performs the change.
        r3 = await db_client.post(
            _url("/rest/v1/rpc/rpc_update_member_role"),
            headers=_headers(),
            json={"p_org_type": org_type, "p_org_id": org_id,
                  "p_target_user": target_user_id, "p_role": body.role},
        )
        if not r3.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to update member role: {r3.text}")
    else:
        r3 = await db_client.patch(
            _url(f"/rest/v1/{member_table}"),
            params={"user_id": f"eq.{target_user_id}", org_fk: f"eq.{org_id}"},
            headers=_headers({"Prefer": "return=minimal"}),
            json={"member_role": body.role},
        )
        if not r3.is_success:
            raise HTTPException(status_code=500, detail="Failed to update member role")

    invalidate_member_cache(target_user_id)
    _audit(org_type, org_id, user.id, "role_changed",
           target_user_id=target_user_id, old_role=current_role, new_role=body.role)
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

    removed_role = rows[0]["member_role"]
    if _use_user_identity():
        # Flag-on: membership deletes are user-unwritable under RLS; rpc_remove_member (is_org_admin
        # authz; refuses to remove an owner) performs the delete.
        r2 = await db_client.post(
            _url("/rest/v1/rpc/rpc_remove_member"),
            headers=_headers(),
            json={"p_org_type": org_type, "p_org_id": org_id, "p_target_user": target_user_id},
        )
        if not r2.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to remove member: {r2.text}")
    else:
        r2 = await db_client.delete(
            _url(f"/rest/v1/{member_table}"),
            params={"user_id": f"eq.{target_user_id}", org_fk: f"eq.{org_id}"},
            headers=_headers(),
        )
        if not r2.is_success:
            raise HTTPException(status_code=500, detail="Failed to remove member")

    invalidate_member_cache(target_user_id)
    _audit(org_type, org_id, user.id, "member_removed",
           target_user_id=target_user_id, old_role=removed_role)
    return {"ok": True}


# ── Audit log ─────────────────────────────────────────────────────────────────

@router.get("/org/audit-log")
async def get_audit_log(user: CurrentUser = Depends(get_current_user)):
    """Return the last 100 privilege-change events for this org. Admin-only."""
    require_admin(user)
    org_type, org_id = _org_ids(user)

    r = await db_client.get(
        _url("/rest/v1/org_role_audit_log"),
        params={
            "org_type": f"eq.{org_type}",
            "org_id":   f"eq.{org_id}",
            "order":    "created_at.desc",
            "limit":    "100",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()

    user_ids: set[str] = set()
    for row in rows:
        user_ids.add(row["actor_id"])
        if row.get("target_user_id"):
            user_ids.add(row["target_user_id"])

    emails = await _get_user_emails(list(user_ids))

    return [
        {
            **row,
            "actor_email":  emails.get(row["actor_id"], ""),
            "target_email": emails.get(row["target_user_id"], "") if row.get("target_user_id") else None,
        }
        for row in rows
    ]
