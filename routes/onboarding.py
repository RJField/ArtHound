"""
Post-login onboarding routes (RLS migration §0c, signup "Option C").

These serve an authenticated user who has a valid role but no org yet — the normal state for a
brand-new account right after email confirmation + first login (signup deferred org creation), and
also a self-serve path for any genuinely stranded account. The user either creates a new org
(becoming its owner) or requests to join one via an invite code.

Flag-gated like the other §4 conversions:
  * flag-on  → the auth.uid()-secure bootstrap RPCs (migration 4) run AS the user.
  * flag-off → legacy service-role inserts (byte-compatible with the synchronous signup path), so the
    endpoints work on prod before any RLS migration is applied. Under flag-off, signup already creates
    the org synchronously, so this path is reached only by stranded accounts.

Auth: get_onboarding_identity verifies the JWT + binds the token but does NOT require membership
(the whole point is that there isn't any yet). The org-creation RPCs / inserts enforce
"not already a member".
"""

import logging
import re
import secrets
import string

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional

from lib.auth import AuthIdentity, get_onboarding_identity, invalidate_member_cache
from lib.db import db_client, _url, _headers, _anon_headers, _use_user_identity

log = logging.getLogger(__name__)
router = APIRouter()

_HANDLE_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{2,31}$')
_INVITE_ALPHABET = string.ascii_uppercase + string.digits


def _generate_invite_code() -> str:
    # Local copy (keeps this module independent of routes.auth) — used only by the legacy flag-off
    # path so org creation works on prod before the invite_code column default (migration 12) lands.
    return ''.join(secrets.choice(_INVITE_ALPHABET) for _ in range(8))


class OnboardCreateBody(BaseModel):
    org_name: str
    handle:   Optional[str] = None   # vendor only


class OnboardJoinBody(BaseModel):
    invite_code: str


async def _assert_no_membership_legacy(user_id: str) -> None:
    """Flag-off guard mirroring the RPCs' 'already a member of an org' check."""
    for table, fk in (("studio_members", "studio_id"), ("vendor_members", "vendor_id")):
        r = await db_client.get(
            _url(f"/rest/v1/{table}"),
            params={"select": fk, "user_id": f"eq.{user_id}", "limit": "1"},
            headers=_headers(),
        )
        if r.is_success and r.json():
            raise HTTPException(status_code=409, detail="ALREADY_MEMBER")


def _raise_org_create_error(text: str) -> None:
    low = text.lower()
    if "already a member" in low:
        raise HTTPException(status_code=409, detail="ALREADY_MEMBER")
    if "handle" in low and ("unique" in low or "duplicate" in low or "23505" in low):
        raise HTTPException(status_code=422, detail="HANDLE_TAKEN")
    if "vendor handle required" in low:
        raise HTTPException(status_code=422, detail="HANDLE_INVALID")
    log.error("Onboarding org-create failed: %s", text[:300])
    raise HTTPException(status_code=400, detail="Failed to create organisation")


@router.post("/create")
async def onboard_create(
    body: OnboardCreateBody,
    identity: AuthIdentity = Depends(get_onboarding_identity),
):
    """Create a new org of the user's role and make the caller its owner."""
    role = identity.role
    name = (body.org_name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Organisation name is required")
    handle: Optional[str] = None
    if role == "vendor":
        handle = (body.handle or "").strip().lower()
        if not _HANDLE_RE.match(handle):
            raise HTTPException(status_code=422, detail="HANDLE_INVALID")

    if _use_user_identity():
        # Flag-on: create org + founding owner membership via the auth.uid()-secure DEFINER RPC,
        # running AS this user (token bound by get_onboarding_identity). The RPC enforces "not already
        # a member" and (vendor) handle presence; invite_code is filled by the column default (mig 12).
        if role == "studio":
            rr = await db_client.post(
                _url("/rest/v1/rpc/rpc_create_studio_with_owner"),
                json={"p_name": name},
                headers=_headers(),
            )
        else:
            rr = await db_client.post(
                _url("/rest/v1/rpc/rpc_create_vendor_with_owner"),
                json={"p_name": name, "p_handle": handle},
                headers=_headers(),
            )
        if not rr.is_success:
            _raise_org_create_error(rr.text)
        org_id = rr.json()
        invalidate_member_cache(identity.id)  # so the next /api/user/me sees the fresh membership
        return {"ok": True, "org_id": org_id}

    # ── Flag-off (legacy service-role): guard, then insert org + owner membership. ──
    await _assert_no_membership_legacy(identity.id)

    org_table = "studios" if role == "studio" else "vendors"
    org_payload: dict = {"name": name, "invite_code": _generate_invite_code()}
    if role == "vendor":
        org_payload["handle"] = handle
    r2 = await db_client.post(
        _url(f"/rest/v1/{org_table}"),
        headers=_headers({"Prefer": "return=representation"}),
        json=org_payload,
    )
    if r2.status_code == 409 or (not r2.is_success and "23505" in r2.text):
        raise HTTPException(status_code=422, detail="HANDLE_TAKEN")
    if not r2.is_success:
        log.error("Onboarding org create failed for user %s: %s", identity.id, r2.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create organisation record")
    org_id = r2.json()[0]["id"]

    member_table = "studio_members" if role == "studio" else "vendor_members"
    fk           = "studio_id"      if role == "studio" else "vendor_id"
    r3 = await db_client.post(
        _url(f"/rest/v1/{member_table}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json={fk: org_id, "user_id": identity.id, "member_role": "owner"},
    )
    if not r3.is_success:
        log.error("Onboarding member create failed for user %s / org %s: %s", identity.id, org_id, r3.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create member record")

    invalidate_member_cache(identity.id)
    return {"ok": True, "org_id": org_id}


@router.post("/join")
async def onboard_join(
    body: OnboardJoinBody,
    identity: AuthIdentity = Depends(get_onboarding_identity),
):
    """Request to join an existing org via its invite code (creates a pending join request)."""
    code = (body.invite_code or "").strip().upper()
    if not code:
        raise HTTPException(status_code=422, detail="INVITE_CODE_INVALID")

    # Resolve + validate the code via the anon read-RPC (flag-independent; name + type only).
    rr = await db_client.post(
        _url("/rest/v1/rpc/rpc_resolve_invite"),
        headers=_anon_headers(),
        json={"p_code": code},
    )
    rows = rr.json() if rr.is_success else []
    if not rows:
        raise HTTPException(status_code=422, detail="INVITE_CODE_INVALID")
    org_type = rows[0]["org_type"]
    org_name = rows[0]["org_name"]
    # The membership type must match the account's role, or the app's studio/vendor framing breaks.
    if identity.role != org_type:
        raise HTTPException(status_code=422, detail="ROLE_ORG_MISMATCH")

    if _use_user_identity():
        # Flag-on: insert the pending request via the auth.uid()-secure DEFINER RPC, AS this user.
        jr = await db_client.post(
            _url("/rest/v1/rpc/rpc_request_join"),
            json={"p_invite_code": code},
            headers=_headers(),
        )
        if not jr.is_success:
            if "invalid invite code" in jr.text.lower():
                raise HTTPException(status_code=422, detail="INVITE_CODE_INVALID")
            log.error("Onboarding join RPC failed for user %s: %s", identity.id, jr.text[:300])
            raise HTTPException(status_code=400, detail="Failed to request access")
        return {"ok": True, "status": "pending", "org_name": org_name, "org_type": org_type}

    # ── Flag-off (legacy service-role): resolve org id by code, insert the pending request. ──
    org_table = "studios"               if org_type == "studio" else "vendors"
    fk        = "studio_id"             if org_type == "studio" else "vendor_id"
    req_table = "studio_join_requests"  if org_type == "studio" else "vendor_join_requests"

    or_ = await db_client.get(
        _url(f"/rest/v1/{org_table}"),
        params={"invite_code": f"eq.{code}", "select": "id", "limit": "1"},
        headers=_headers(),
    )
    org_rows = or_.json() if or_.is_success else []
    if not org_rows:
        raise HTTPException(status_code=422, detail="INVITE_CODE_INVALID")
    org_id = org_rows[0]["id"]

    ins = await db_client.post(
        _url(f"/rest/v1/{req_table}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json={"user_id": identity.id, fk: org_id},  # status defaults to 'pending' (matches signup)
    )
    # 409 = a request already exists for this (org, user) — treat as already-pending, not an error.
    if not ins.is_success and ins.status_code != 409:
        log.error("Onboarding join request failed for user %s / org %s: %s", identity.id, org_id, ins.text[:300])
        raise HTTPException(status_code=500, detail="Failed to request access")
    return {"ok": True, "status": "pending", "org_name": org_name, "org_type": org_type}
