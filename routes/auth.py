"""
Public auth routes — no JWT required.
"""

import logging
import os
import re
import secrets
import string
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lib.db import db_client, _url, _headers, _anon_headers, _admin_headers, _use_user_identity

log = logging.getLogger(__name__)
router = APIRouter()


# ── System settings helpers ──────────────────────────────────────────────────
# These are PUBLIC (pre-login) reads of the system_settings singleton — an F-table that denies all
# user reads under RLS. They go through anon-callable SECURITY DEFINER read-RPCs (migration 6) that
# return ONLY a boolean (never the configured code), reached with the anon key. Flag-independent.


async def _check_system_invite(code: Optional[str]) -> None:
    """Raise 422 SYSTEM_INVITE_INVALID if the platform gate rejects this code.

    The gate/code comparison lives in rpc_check_system_invite (the configured code never enters the
    app). Fails OPEN on a transport error (matches the prior defaults-on-failure behaviour): only an
    explicit `false` from the gate rejects — gate-off / no-code-configured / a match all return true.
    """
    r = await db_client.post(
        _url("/rest/v1/rpc/rpc_check_system_invite"),
        headers=_anon_headers(),
        json={"p_code": code or ""},
    )
    if r.is_success and r.json() is False:
        raise HTTPException(status_code=422, detail="SYSTEM_INVITE_INVALID")


@router.get("/config")
async def get_auth_config():
    """Public — returns whether a system-level invite code is required to register."""
    r = await db_client.post(
        _url("/rest/v1/rpc/rpc_registration_required"),
        headers=_anon_headers(),
        json={},
    )
    required = bool(r.json()) if r.is_success else False
    return {"registration_invite_required": required}


@router.get("/system-invite/{code}/validate")
async def validate_system_invite(code: str):
    """
    Public — validates a system-level invite code without completing signup.
    Returns 200 {valid: true} or raises 422 SYSTEM_INVITE_INVALID.
    """
    await _check_system_invite(code)
    return {"valid": True}

# Set SIGNUP_AUTO_CONFIRM=true in dev to skip email confirmation.
# Defaults to false (require confirmation) for safe production behaviour.
_AUTO_CONFIRM = os.environ.get("SIGNUP_AUTO_CONFIRM", "false").lower() == "true"


_HANDLE_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{2,31}$')
_INVITE_ALPHABET = string.ascii_uppercase + string.digits

def _generate_invite_code() -> str:
    return ''.join(secrets.choice(_INVITE_ALPHABET) for _ in range(8))


class SignupBody(BaseModel):
    email:              str
    password:           str
    role:               str              # "studio" | "vendor"
    org_name:           Optional[str] = None   # required when creating a new org
    handle:             Optional[str] = None   # vendor only, new org path
    invite_code:        Optional[str] = None   # present when joining an existing org
    system_invite_code: Optional[str] = None   # ArtHound-level gate (when enabled)


@router.post("/signup")
async def signup(body: SignupBody):
    """
    Two-path signup:

    1. Create new org (invite_code absent):
       Create auth user → create org row → create member row as 'owner'.

    2. Join existing org (invite_code present):
       Resolve org by invite code → create auth user → insert pending join request.
       The user must be accepted by an org admin before they can access the app.

    If the platform registration gate is enabled, system_invite_code must match
    the configured code or the request is rejected before any auth user is created.
    """
    if body.role not in ("studio", "vendor"):
        raise HTTPException(status_code=422, detail="role must be 'studio' or 'vendor'")
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")

    await _check_system_invite(body.system_invite_code)

    if body.invite_code:
        return await _signup_join(body)
    else:
        return await _signup_create(body)


async def _admin_create_user(
    email: str, password: str, role: str, user_metadata: Optional[dict] = None
) -> str:
    """Create the GoTrue auth user via the Admin API (sanctioned service-role carve-out, §0c — RLS and
    the system role do not apply to /auth/v1/admin/*). Sets app_metadata.role and, optionally, stashes
    onboarding intent in user_metadata. Returns the new user id. Raises 422 on a client error (e.g. the
    email is already registered) and 500 on an auth-service error."""
    payload: dict = {
        "email":         email,
        "password":      password,
        "app_metadata":  {"role": role},
        "email_confirm": _AUTO_CONFIRM,
    }
    if user_metadata is not None:
        payload["user_metadata"] = user_metadata
    r = await db_client.post(
        _url("/auth/v1/admin/users"),
        headers=_admin_headers(),
        json=payload,
    )
    if r.status_code in (400, 422):
        data = r.json()
        detail = data.get("msg") or data.get("message") or data.get("error_description") or "Signup failed"
        raise HTTPException(status_code=422, detail=detail)
    if not r.is_success:
        log.error("Admin user create failed %s: %s", r.status_code, r.text[:300])
        raise HTTPException(status_code=500, detail=f"Auth service error ({r.status_code})")
    return r.json()["id"]


async def _signup_create(body: SignupBody) -> dict:
    """Create a new studio or vendor org. Caller becomes the owner."""
    if not body.org_name or not body.org_name.strip():
        raise HTTPException(status_code=422, detail="Organisation name is required")
    if body.role == "vendor" and body.handle is not None:
        if not _HANDLE_RE.match(body.handle):
            raise HTTPException(status_code=422, detail="HANDLE_INVALID")

    if _use_user_identity():
        # Option C (RLS migration §0c): defer org creation to a post-login onboarding step. Pre-login
        # there is no user JWT, so org+member inserts cannot run under RLS — instead create only the
        # auth user and stash the chosen org details in user_metadata. After email-confirm + first login
        # the frontend reads the stash and calls rpc_create_studio_with_owner / rpc_create_vendor_with_owner
        # AS the user (auth.uid()-secure). No org/member rows exist until the user completes onboarding.
        stash: dict = {"intent": "create", "role": body.role, "org_name": body.org_name.strip()}
        if body.role == "vendor" and body.handle:
            stash["handle"] = body.handle
        await _admin_create_user(body.email, body.password, body.role, {"ah_onboarding": stash})
        await _send_confirmation_email(body.email)
        return {"ok": True, "email_confirmation_required": not _AUTO_CONFIRM}

    # ── Flag-off (legacy service-role): create the org + owner membership synchronously at signup. ──
    # ── 1. Create auth user ───────────────────────────────────────────────────
    user_id = await _admin_create_user(body.email, body.password, body.role)

    # ── 2. Create org row ─────────────────────────────────────────────────────
    org_table = "studios" if body.role == "studio" else "vendors"
    org_payload: dict = {"name": body.org_name.strip(), "invite_code": _generate_invite_code()}
    if body.role == "vendor" and body.handle:
        org_payload["handle"] = body.handle

    r2 = await db_client.post(
        _url(f"/rest/v1/{org_table}"),
        headers=_headers({"Prefer": "return=representation"}),
        json=org_payload,
    )
    if r2.status_code == 409 or (not r2.is_success and "23505" in r2.text):
        raise HTTPException(status_code=422, detail="HANDLE_TAKEN")
    if not r2.is_success:
        log.error("Org create failed for user %s: %s", user_id, r2.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create organisation record")
    org_id = r2.json()[0]["id"]

    # ── 3. Create member row as owner ─────────────────────────────────────────
    member_table = "studio_members" if body.role == "studio" else "vendor_members"
    member_payload = (
        {"studio_id": org_id, "user_id": user_id, "member_role": "owner"}
        if body.role == "studio"
        else {"vendor_id": org_id, "user_id": user_id, "member_role": "owner"}
    )
    r3 = await db_client.post(
        _url(f"/rest/v1/{member_table}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json=member_payload,
    )
    if not r3.is_success:
        log.error("Member create failed for user %s / org %s: %s", user_id, org_id, r3.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create member record")

    await _send_confirmation_email(body.email)
    return {"ok": True, "email_confirmation_required": not _AUTO_CONFIRM}


async def _signup_join(body: SignupBody) -> dict:
    """
    Join an existing org via invite code.
    Creates the auth user and a pending join request — no membership row yet.
    An org admin must accept the request before the user gains access.
    """
    code = body.invite_code.strip().upper()

    if _use_user_identity():
        # Option C: validate the code via the anon read-RPC (migration 6 — no service-role read),
        # confirm the role matches, then create only the auth user with the join intent stashed.
        # rpc_request_join runs post-login AS the user, inserting the pending request then.
        rr = await db_client.post(
            _url("/rest/v1/rpc/rpc_resolve_invite"),
            headers=_anon_headers(),
            json={"p_code": code},
        )
        rows = rr.json() if rr.is_success else []
        if not rows:
            raise HTTPException(status_code=422, detail="INVITE_CODE_INVALID")
        resolved_type = rows[0]["org_type"]
        resolved_name = rows[0]["org_name"]
        if body.role != resolved_type:
            raise HTTPException(status_code=422, detail="ROLE_ORG_MISMATCH")

        stash = {"intent": "join", "role": resolved_type, "invite_code": code}
        await _admin_create_user(body.email, body.password, resolved_type, {"ah_onboarding": stash})
        await _send_confirmation_email(body.email)
        return {
            "ok": True,
            "status": "pending",
            "org_name": resolved_name,
            "email_confirmation_required": not _AUTO_CONFIRM,
        }

    # ── Flag-off (legacy service-role): resolve + create user + pending request synchronously. ──
    # Resolve org from invite code — try studio then vendor.
    org = None
    org_type = None

    studio_r = await db_client.get(
        _url("/rest/v1/studios"),
        params={"invite_code": f"eq.{code}", "select": "id,name"},
        headers=_headers(),
    )
    if studio_r.is_success and studio_r.json():
        org = studio_r.json()[0]
        org_type = "studio"

    if not org:
        vendor_r = await db_client.get(
            _url("/rest/v1/vendors"),
            params={"invite_code": f"eq.{code}", "select": "id,name"},
            headers=_headers(),
        )
        if vendor_r.is_success and vendor_r.json():
            org = vendor_r.json()[0]
            org_type = "vendor"

    if not org:
        raise HTTPException(status_code=422, detail="INVITE_CODE_INVALID")

    # Role must match the org type the invite code resolves to.
    if body.role != org_type:
        raise HTTPException(status_code=422, detail="ROLE_ORG_MISMATCH")

    # ── Create auth user ──────────────────────────────────────────────────────
    user_id = await _admin_create_user(body.email, body.password, org_type)

    # ── Insert pending join request ───────────────────────────────────────────
    req_table = "studio_join_requests" if org_type == "studio" else "vendor_join_requests"
    org_fk    = "studio_id"            if org_type == "studio" else "vendor_id"

    r2 = await db_client.post(
        _url(f"/rest/v1/{req_table}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json={"user_id": user_id, org_fk: org["id"]},
    )
    if not r2.is_success:
        log.error("Join request create failed for user %s / org %s: %s", user_id, org["id"], r2.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create join request")

    await _send_confirmation_email(body.email)
    return {
        "ok": True,
        "status": "pending",
        "org_name": org["name"],
        "email_confirmation_required": not _AUTO_CONFIRM,
    }


async def _send_confirmation_email(email: str) -> None:
    if _AUTO_CONFIRM:
        return
    frontend_url = os.environ.get("FRONTEND_URL", "http://localhost:5173")
    # /auth/v1/resend is a public GoTrue endpoint — the anon apikey is the correct credential
    # (flag-independent: never relies on a bound user token, which doesn't exist pre-confirmation).
    await db_client.post(
        _url("/auth/v1/resend"),
        headers=_anon_headers(),
        json={
            "type":  "signup",
            "email": email,
            "options": {"emailRedirectTo": f"{frontend_url}/auth/callback"},
        },
    )
