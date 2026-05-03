"""
Public auth routes — no JWT required.
"""

import logging
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()

# Set SIGNUP_AUTO_CONFIRM=false in production to require email confirmation.
# Defaults to true (skip confirmation) for dev-friendly behaviour.
_AUTO_CONFIRM = os.environ.get("SIGNUP_AUTO_CONFIRM", "true").lower() != "false"


class SignupBody(BaseModel):
    email:    str
    password: str
    role:     str   # "studio" | "vendor"
    org_name: str


@router.post("/signup")
async def signup(body: SignupBody):
    """
    End-to-end studio/vendor signup in one call:
      1. Create Supabase Auth user via Admin API with app_metadata.role set
         (role is in app_metadata — admin-only — so the JWT carries the correct claim)
      2. Create the studios/vendors row
      3. Create the studio_members/vendor_members row

    Returns immediately after DB provisioning. The user still needs to confirm their
    email before they can log in (Supabase default). Set email_confirm=True in the
    admin payload to skip confirmation (useful for dev/invite flows).
    """
    if body.role not in ("studio", "vendor"):
        raise HTTPException(status_code=422, detail="role must be 'studio' or 'vendor'")
    if not body.org_name.strip():
        raise HTTPException(status_code=422, detail="Organisation name is required")
    if len(body.password) < 8:
        raise HTTPException(status_code=422, detail="Password must be at least 8 characters")

    # ── 1. Create auth user ───────────────────────────────────────────────────
    r = await db_client.post(
        _url("/auth/v1/admin/users"),
        headers=_headers(),
        json={
            "email":        body.email,
            "password":     body.password,
            "app_metadata": {"role": body.role},
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
    r2 = await db_client.post(
        _url(f"/rest/v1/{org_table}"),
        headers=_headers({"Prefer": "return=representation"}),
        json={"name": body.org_name.strip()},
    )
    if not r2.is_success:
        log.error("Org create failed for user %s: %s", user_id, r2.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create organisation record")
    org_id = r2.json()[0]["id"]

    # ── 3. Create member row ──────────────────────────────────────────────────
    member_table = "studio_members" if body.role == "studio" else "vendor_members"
    member_payload = (
        {"studio_id": org_id, "user_id": user_id}
        if body.role == "studio"
        else {"vendor_id": org_id, "user_id": user_id}
    )
    r3 = await db_client.post(
        _url(f"/rest/v1/{member_table}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json=member_payload,
    )
    if not r3.is_success:
        log.error("Member create failed for user %s / org %s: %s", user_id, org_id, r3.text[:300])
        raise HTTPException(status_code=500, detail="Failed to create member record")

    # When not auto-confirming, trigger the confirmation email explicitly.
    # The Admin API creates the user but never fires the email on its own.
    if not _AUTO_CONFIRM:
        await db_client.post(
            _url("/auth/v1/resend"),
            headers=_headers(),
            json={"type": "signup", "email": body.email},
        )

    return {"ok": True, "email_confirmation_required": not _AUTO_CONFIRM}
