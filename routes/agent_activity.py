"""Agent activity — read + triage API for the records MCP agents write (docs/plans/mcp-server.md Phase 2).

Surfaces asset_flags / review_requests / estimate_adjustment_proposals to the producing org's UI:
a per-asset list (Asset viewer) and an org roll-up (home widget), plus status triage. Reads run under
the caller's RLS identity (get_current_user binds the JWT); the explicit owner filter is correctness +
clarity. The MCP tools are the only writers of new rows — this surface only reads and updates status.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user
from lib.db import db_client, _url, _headers

router = APIRouter()

_FLAG_STATUSES = {"open", "acknowledged", "resolved"}
_RR_STATUSES   = {"open", "addressed"}
_PROP_STATUSES = {"pending", "accepted", "rejected"}


def _owner(user: CurrentUser) -> tuple[str, str]:
    owner_id = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")
    return user.role, owner_id


async def _get(table: str, params: dict) -> list[dict]:
    r = await db_client.get(_url(f"/rest/v1/{table}"), params=params, headers=_headers())
    r.raise_for_status()
    return r.json()


# ── normalizers → one uniform item shape the UI renders generically ────────────────────────────────
def _flag_item(r: dict) -> dict:
    return {"id": r["id"], "kind": "flag", "title": r.get("summary"), "detail": None,
            "status": r.get("status"), "severity": r.get("severity"), "risk_type": r.get("risk_type"),
            "canonical_asset_id": r.get("canonical_asset_id"), "actor_type": r.get("actor_type"),
            "created_at": r.get("created_at")}


def _rr_item(r: dict) -> dict:
    return {"id": r["id"], "kind": "review_request", "title": r.get("subject"),
            "detail": r.get("context"), "status": r.get("status"), "severity": None, "risk_type": None,
            "canonical_asset_id": r.get("canonical_asset_id"), "actor_type": r.get("actor_type"),
            "created_at": r.get("created_at")}


def _prop_item(r: dict) -> dict:
    cur, prop = r.get("current_estimate_days"), r.get("proposed_estimate_days")
    title = f"Estimate → {prop}d" + (f" (was {cur}d)" if cur is not None else "")
    return {"id": r["id"], "kind": "proposal", "title": title, "detail": r.get("reasoning"),
            "status": r.get("status"), "severity": None, "risk_type": None,
            "canonical_asset_id": r.get("canonical_asset_id"), "actor_type": r.get("actor_type"),
            "created_at": r.get("created_at")}


_FLAG_SEL = "id,summary,evidence,status,severity,risk_type,canonical_asset_id,actor_type,created_at"
_RR_SEL   = "id,subject,context,status,canonical_asset_id,actor_type,created_at"
_PROP_SEL = "id,proposed_estimate_days,current_estimate_days,reasoning,status,canonical_asset_id,actor_type,created_at"


async def _collect(base: dict) -> list[dict]:
    flags = await _get("asset_flags", {**base, "select": _FLAG_SEL})
    rrs   = await _get("review_requests", {**base, "select": _RR_SEL})
    props = await _get("estimate_adjustment_proposals", {**base, "select": _PROP_SEL})
    items = [*map(_flag_item, flags), *map(_rr_item, rrs), *map(_prop_item, props)]
    items.sort(key=lambda x: x["created_at"] or "", reverse=True)
    return items


@router.get("/recent")
async def recent(limit: int = Query(20, le=100), user: CurrentUser = Depends(get_current_user)):
    """Org-wide roll-up of recent agent-written records, newest first, with the asset name resolved."""
    owner_type, owner_id = _owner(user)
    base = {"owner_type": f"eq.{owner_type}", "owner_id": f"eq.{owner_id}",
            "order": "created_at.desc", "limit": str(limit)}
    items = (await _collect(base))[:limit]

    cids = list({i["canonical_asset_id"] for i in items if i.get("canonical_asset_id")})
    names: dict[str, str] = {}
    if cids:
        ar = await db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={"owner_type": f"eq.{owner_type}", "owner_id": f"eq.{owner_id}",
                    "canonical_asset_id": f"in.({','.join(cids)})", "select": "canonical_asset_id,name"},
            headers=_headers(),
        )
        if ar.is_success:
            for a in ar.json():
                names[a["canonical_asset_id"]] = a.get("name")
    for i in items:
        i["asset_name"] = names.get(i.get("canonical_asset_id"))
    return items


@router.get("/asset/{canonical_asset_id}")
async def for_asset(canonical_asset_id: str, user: CurrentUser = Depends(get_current_user)):
    """All agent-written records anchored to one asset, newest first."""
    owner_type, owner_id = _owner(user)
    base = {"owner_type": f"eq.{owner_type}", "owner_id": f"eq.{owner_id}",
            "canonical_asset_id": f"eq.{canonical_asset_id}", "order": "created_at.desc"}
    return await _collect(base)


class StatusUpdate(BaseModel):
    status: str


async def _set_status(table: str, item_id: str, status: str, allowed: set[str],
                      user: CurrentUser) -> dict:
    owner_type, owner_id = _owner(user)
    if status not in allowed:
        raise HTTPException(status_code=400, detail=f"status must be one of {sorted(allowed)}")
    r = await db_client.patch(
        _url(f"/rest/v1/{table}"),
        params={"id": f"eq.{item_id}", "owner_type": f"eq.{owner_type}", "owner_id": f"eq.{owner_id}"},
        json={"status": status},
        headers=_headers({"Prefer": "return=representation"}),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="not found")
    return rows[0]


@router.patch("/flags/{item_id}")
async def update_flag(item_id: str, body: StatusUpdate, user: CurrentUser = Depends(get_current_user)):
    return await _set_status("asset_flags", item_id, body.status, _FLAG_STATUSES, user)


@router.patch("/review-requests/{item_id}")
async def update_review_request(item_id: str, body: StatusUpdate,
                                user: CurrentUser = Depends(get_current_user)):
    return await _set_status("review_requests", item_id, body.status, _RR_STATUSES, user)


@router.patch("/proposals/{item_id}")
async def update_proposal(item_id: str, body: StatusUpdate,
                          user: CurrentUser = Depends(get_current_user)):
    return await _set_status("estimate_adjustment_proposals", item_id, body.status, _PROP_STATUSES, user)
