from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user
from lib.db import db_client, _url, _headers

router = APIRouter()


@router.get("/me")
async def get_me(user: CurrentUser = Depends(get_current_user)):
    """Return current user identity and their assigned studio/vendor."""
    org = None
    if user.role == "studio" and user.studio_id:
        r = await db_client.get(
            _url("/rest/v1/studios"),
            params={"id": f"eq.{user.studio_id}", "select": "id,name"},
            headers=_headers(),
        )
        r.raise_for_status()
        rows = r.json()
        if rows:
            org = rows[0]
    elif user.role == "vendor" and user.vendor_id:
        r = await db_client.get(
            _url("/rest/v1/vendors"),
            params={"id": f"eq.{user.vendor_id}", "select": "id,name"},
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
