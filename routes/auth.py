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

from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()


# ── System settings helpers ──────────────────────────────────────────────────

async def _get_system_settings() -> dict:
    """Fetch the system_settings singleton. Returns defaults on any failure."""
    r = await db_client.get(
        _url("/rest/v1/system_settings"),
        params={
            "id":     "eq.true",
            "select": "registration_invite_required,registration_invite_code",
        },
        headers=_headers(),
    )
    if r.is_success and r.json():
        return r.json()[0]
    return {"registration_invite_required": False, "registration_invite_code": None}


async def _check_system_invite(code: Optional[str]) -> None:
    """Raise 422 SYSTEM_INVITE_INVALID if the platform gate is active and code is wrong."""
    settings = await _get_system_settings()
    if not settings.get("registration_invite_required"):
        return
    stored = (settings.get("registration_invite_code") or "").strip()
    if not stored:
        return  # gate is on but no code is configured — allow through
    if not code or code.strip().upper() != stored.upper():
        raise HTTPException(status_code=422, detail="SYSTEM_INVITE_INVALID")


@router.get("/config")
async def get_auth_config():
    """Public — returns whether a system-level invite code is required to register."""
    settings = await _get_system_settings()
    return {"registration_invite_required": settings.get("registration_invite_required", False)}


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


async def _signup_create(body: SignupBody) -> dict:
    """Create a new studio or vendor org. Caller becomes the owner."""
    if not body.org_name or not body.org_name.strip():
        raise HTTPException(status_code=422, detail="Organisation name is required")
    if body.role == "vendor" and body.handle is not None:
        if not _HANDLE_RE.match(body.handle):
            raise HTTPException(status_code=422, detail="HANDLE_INVALID")

    # ── 1. Create auth user ───────────────────────────────────────────────────
    r = await db_client.post(
        _url("/auth/v1/admin/users"),
        headers=_headers(),
        json={
            "email":         body.email,
            "password":      body.password,
            "app_metadata":  {"role": body.role},
            "email_confirm": _AUTO_CONFIRM,
        },
    )
    if r.status_code in (400, 422):
        data = r.json()
        detail = data.get("msg") or data.get("message") or data.get("error_description") or "Signup failed"
        raise HTTPException(status_code=422, detail=detail)
    if not r.is_success:
        log.error("Admin user create failed %s: %s", r.status_code, r.text[:300])
        raise HTTPException(status_code=500, detail=f"Auth service error ({r.status_code})")

    user_id = r.json()["id"]

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
    r = await db_client.post(
        _url("/auth/v1/admin/users"),
        headers=_headers(),
        json={
            "email":         body.email,
            "password":      body.password,
            "app_metadata":  {"role": org_type},
            "email_confirm": _AUTO_CONFIRM,
        },
    )
    if r.status_code in (400, 422):
        data = r.json()
        detail = data.get("msg") or data.get("message") or data.get("error_description") or "Signup failed"
        raise HTTPException(status_code=422, detail=detail)
    if not r.is_success:
        log.error("Admin user create (join) failed %s: %s", r.status_code, r.text[:300])
        raise HTTPException(status_code=500, detail=f"Auth service error ({r.status_code})")

    user_id = r.json()["id"]

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
    await db_client.post(
        _url("/auth/v1/resend"),
        headers=_headers(),
        json={
            "type":  "signup",
            "email": email,
            "options": {"emailRedirectTo": f"{frontend_url}/auth/callback"},
        },
    )
