"""
Platform-admin routes.

Access is restricted to email addresses listed in the PLATFORM_ADMIN_EMAILS
environment variable (comma-separated). These users can read and update
system-wide settings that apply across all orgs.
"""

import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()

_PLATFORM_ADMIN_EMAILS: set[str] = {
    e.strip().lower()
    for e in os.environ.get("PLATFORM_ADMIN_EMAILS", "").split(",")
    if e.strip()
}


def is_platform_admin(email: str) -> bool:
    return email.lower() in _PLATFORM_ADMIN_EMAILS


def _require_platform_admin(user: CurrentUser = Depends(get_current_user)):
    if not is_platform_admin(user.email):
        raise HTTPException(status_code=403, detail="Platform admin access required")
    return user


async def _get_settings() -> dict:
    # system_settings is an F-table (no authenticated read/write policy). The route is already gated to
    # platform admins; the read/write is performed as the system identity (flag-off: service-role;
    # flag-on: arthound_system, which migration 15 grants select/insert/update + a sys policy).
    from lib.system_auth import system_identity
    async with system_identity():
        r = await db_client.get(
            _url("/rest/v1/system_settings"),
            params={
                "id":     "eq.true",
                "select": "registration_invite_required,registration_invite_code,updated_at,updated_by",
            },
            headers=_headers(),
        )
    if not r.is_success or not r.json():
        raise HTTPException(status_code=500, detail="Failed to read system settings")
    return r.json()[0]


class SystemSettingsPatch(BaseModel):
    registration_invite_required: Optional[bool] = None
    registration_invite_code:     Optional[str]  = None


@router.get("/settings")
async def get_system_settings(user=Depends(_require_platform_admin)):
    return await _get_settings()


@router.patch("/settings")
async def patch_system_settings(body: SystemSettingsPatch, user: CurrentUser = Depends(_require_platform_admin)):
    payload: dict = {}

    if body.registration_invite_required is not None:
        payload["registration_invite_required"] = body.registration_invite_required

    if body.registration_invite_code is not None:
        stripped = body.registration_invite_code.strip()
        payload["registration_invite_code"] = stripped if stripped else None

    if not payload:
        raise HTTPException(status_code=422, detail="No fields to update")

    payload["updated_by"] = user.id
    # updated_at is handled by the DB trigger

    from lib.system_auth import system_identity
    async with system_identity():
        r = await db_client.patch(
            _url("/rest/v1/system_settings"),
            params={"id": "eq.true"},
            headers=_headers({"Prefer": "return=representation"}),
            json=payload,
        )
    if not r.is_success:
        log.error("System settings update failed: %s", r.text[:300])
        raise HTTPException(status_code=500, detail="Failed to update system settings")

    rows = r.json()
    return rows[0] if rows else await _get_settings()
