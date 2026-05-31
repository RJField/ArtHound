"""
Vendor → studio estimate-share endpoints (vendor-estimate-share plan §4.4).

A vendor projects their effective matrix at a chosen granularity into a frozen snapshot and shares it
with a linked studio. Delivery is the route-scoped inbox: the studio reads active dispatches addressed
to it (the route-layer owner filter is the isolation boundary; RLS is defense-in-depth, plan §2.4).

Re-sharing replaces the prior share in the same (vendor, link) channel — the find-or-create-series +
supersede + insert is done atomically in the create_estimate_share RPC, with uq_esd_one_live as the
structural at-most-one-live backstop (plan §2.6, §6.8).
"""
import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, require_vendor, require_studio
from lib.db import db_client, _url, _headers, _use_user_identity
from lib.estimate.effective import resolve_effective_matrix
from lib.estimate.projector import project, GRANULARITIES
from lib.estimate.delivery import get_delivery_strategy
from lib.handshake import require_vendor_link

router = APIRouter()

_MAX_EXPIRY_DAYS = 365


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _expired(expires_at: str | None) -> bool:
    if not expires_at:
        return False
    try:
        dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return dt <= datetime.now(timezone.utc)


def _assert_valid(dispatch: dict) -> None:
    """Raise 410 if the dispatch is revoked or expired."""
    if dispatch.get("revoked_at"):
        raise HTTPException(status_code=410, detail="Estimate share has been revoked")
    if _expired(dispatch.get("expires_at")):
        raise HTTPException(status_code=410, detail="Estimate share has expired")


async def _log(dispatch_id: str, event: str, *, actor_vendor_id: str | None = None,
               actor_studio_id: str | None = None, detail: dict | None = None) -> None:
    await db_client.post(
        _url("/rest/v1/estimate_share_access_log"),
        json={
            "dispatch_id":     dispatch_id,
            "event":           event,
            "actor_vendor_id": actor_vendor_id,
            "actor_studio_id": actor_studio_id,
            "detail":          detail,
        },
        headers=_headers({"Prefer": "return=minimal"}),
    )


async def _build_snapshot(vendor_id: str, link_id: str, granularity: str) -> tuple[dict, int]:
    """Project the vendor's effective matrix for `link_id` at `granularity`.

    Returns (snapshot, unset_cells) where unset_cells counts effective cells with no value
    (null or 0) — surfaced in the share preview so a vendor doesn't ship zeros unknowingly
    (plan §6.7). Shared by the preview and create paths so both project identically.
    """
    eff_rows, r_steps, r_cfg, r_vendor = await asyncio.gather(
        resolve_effective_matrix("vendor_id", vendor_id, link_id),
        db_client.get(_url("/rest/v1/workflow_steps"),
                      params={"vendor_id": f"eq.{vendor_id}", "select": "id,name,craft"}, headers=_headers()),
        db_client.get(_url("/rest/v1/estimate_config"),
                      params={"vendor_id": f"eq.{vendor_id}", "select": "variable_fields"}, headers=_headers()),
        db_client.get(_url("/rest/v1/vendors"),
                      params={"id": f"eq.{vendor_id}", "select": "id,name,handle"}, headers=_headers()),
    )

    cfg_rows = r_cfg.json()
    if not cfg_rows:
        raise HTTPException(status_code=400, detail="No estimate matrix configured for this vendor")
    variable_fields = cfg_rows[0]["variable_fields"]
    step_by_id = {s["id"]: s for s in r_steps.json()}
    vendor_rows = r_vendor.json()
    vendor = vendor_rows[0] if vendor_rows else {"id": vendor_id}

    unset = sum(1 for c in eff_rows if not c.get("estimate_days"))
    snapshot = project(eff_rows, step_by_id, variable_fields, granularity, vendor, link_id)
    return snapshot, unset


# ── vendor: share targets ──────────────────────────────────────────────────────
@router.get("/targets")
async def list_targets(user: CurrentUser = Depends(require_vendor)):
    """Active studio links this vendor can share estimates to."""
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_links"),
        params={"vendor_id": f"eq.{user.vendor_id}", "status": "eq.active",
                "select": "id,studio_id", "order": "created_at.desc"},
        headers=_headers(),
    )
    links = r.json()
    if not links:
        return []
    studio_ids = list({lnk["studio_id"] for lnk in links})
    rs = await db_client.get(
        _url("/rest/v1/studios"),
        params={"id": f"in.({','.join(studio_ids)})", "select": "id,name"},
        headers=_headers(),
    )
    smap = {s["id"]: s.get("name") for s in rs.json()}
    return [{"link_id": lnk["id"], "studio_id": lnk["studio_id"],
             "studio_name": smap.get(lnk["studio_id"])} for lnk in links]


# ── vendor: preview a projection (no persistence) ──────────────────────────────
@router.get("/preview")
async def preview_share(link_id: str, granularity: str,
                        user: CurrentUser = Depends(require_vendor)):
    """Project the effective matrix at `granularity` without persisting — drives the share modal
    preview (and the unset-cell warning, plan §6.7). Same projection path as create."""
    if granularity not in GRANULARITIES:
        raise HTTPException(status_code=422, detail=f"granularity must be one of {list(GRANULARITIES)}")
    await require_vendor_link(link_id, user.vendor_id)
    snapshot, unset = await _build_snapshot(user.vendor_id, link_id, granularity)
    return {"snapshot": snapshot, "unset_cells": unset,
            "profile_count": len(snapshot.get("profiles", []))}


# ── vendor: create a share ─────────────────────────────────────────────────────
class CreateShareBody(BaseModel):
    link_id: str
    granularity: str
    expires_in_days: int | None = None
    label: str | None = None


@router.post("")
async def create_share(body: CreateShareBody, user: CurrentUser = Depends(require_vendor)):
    vendor_id = user.vendor_id
    if body.granularity not in GRANULARITIES:
        raise HTTPException(status_code=422, detail=f"granularity must be one of {list(GRANULARITIES)}")

    link = await require_vendor_link(body.link_id, vendor_id)
    studio_id = link["studio_id"]

    snapshot, _ = await _build_snapshot(vendor_id, body.link_id, body.granularity)

    expires_at = None
    if body.expires_in_days:
        days = max(1, min(body.expires_in_days, _MAX_EXPIRY_DAYS))
        expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()

    # Atomic: find-or-create the (vendor, link) series, supersede any live dispatch, insert the new one
    # (logs 'superseded' + 'shared' inside the transaction). uq_esd_one_live is the race backstop.
    if _use_user_identity():
        # Flag-on: rpc_freeze_estimate_share (SECURITY DEFINER, vendor-authz via auth.uid()) derives
        # recipient_studio_id + vendor_id FROM the link (never trusts caller args, plan §6 #5) and
        # returns the new dispatch id. Direct estimate_share_* writes are denied to users under RLS.
        r = await db_client.post(
            _url("/rest/v1/rpc/rpc_freeze_estimate_share"),
            json={"p_link_id": body.link_id, "p_snapshot": snapshot,
                  "p_label": body.label, "p_expires_at": expires_at},
            headers=_headers(),
        )
        if not r.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to create share: {r.text}")
        dispatch_id = r.json()
        dr = await db_client.get(
            _url("/rest/v1/estimate_share_dispatches"),
            params={"id": f"eq.{dispatch_id}", "select": "*"},
            headers=_headers(),
        )
        drows = dr.json() if dr.is_success else []
        dispatch = drows[0] if drows else {"id": dispatch_id}
    else:
        # Flag-off: legacy SECURITY INVOKER create_estimate_share (service-role).
        r = await db_client.post(
            _url("/rest/v1/rpc/create_estimate_share"),
            json={
                "p_vendor_id":           vendor_id,
                "p_link_id":             body.link_id,
                "p_recipient_studio_id": studio_id,
                "p_snapshot":            snapshot,
                "p_label":               body.label,
                "p_expires_at":          expires_at,
            },
            headers=_headers(),
        )
        if not r.is_success:
            raise HTTPException(status_code=500, detail=f"Failed to create share: {r.text}")
        dispatch = r.json()
        if isinstance(dispatch, list):
            dispatch = dispatch[0] if dispatch else None
        if not dispatch:
            raise HTTPException(status_code=500, detail="Share creation returned no dispatch")

    await get_delivery_strategy(dispatch.get("delivery_mode", "route_inbox")).deliver(dispatch)
    return {"dispatch_id": dispatch["id"], "granularity": body.granularity, "expires_at": expires_at}


# ── vendor: outbox ─────────────────────────────────────────────────────────────
@router.get("/outbox")
async def outbox(user: CurrentUser = Depends(require_vendor)):
    """Vendor's current (non-superseded) shares, one per channel."""
    r = await db_client.get(
        _url("/rest/v1/estimate_share_dispatches"),
        params={
            "vendor_id":     f"eq.{user.vendor_id}",
            "superseded_at": "is.null",
            "select":        "id,link_id,recipient_studio_id,snapshot,expires_at,revoked_at,created_at,estimate_share_series(label)",
            "order":         "created_at.desc",
        },
        headers=_headers(),
    )
    rows = r.json()
    studio_ids = list({row["recipient_studio_id"] for row in rows})
    smap: dict = {}
    if studio_ids:
        rs = await db_client.get(
            _url("/rest/v1/studios"),
            params={"id": f"in.({','.join(studio_ids)})", "select": "id,name"},
            headers=_headers(),
        )
        smap = {s["id"]: s.get("name") for s in rs.json()}
    return [{
        "dispatch_id": row["id"],
        "link_id":     row["link_id"],
        "studio_name": smap.get(row["recipient_studio_id"]),
        "granularity": (row.get("snapshot") or {}).get("granularity"),
        "label":       (row.get("estimate_share_series") or {}).get("label"),
        "expires_at":  row["expires_at"],
        "revoked_at":  row["revoked_at"],
        "created_at":  row["created_at"],
        "snapshot":    row["snapshot"],
    } for row in rows]


# ── vendor: revoke ─────────────────────────────────────────────────────────────
@router.post("/{dispatch_id}/revoke")
async def revoke_share(dispatch_id: str, user: CurrentUser = Depends(require_vendor)):
    r = await db_client.get(
        _url("/rest/v1/estimate_share_dispatches"),
        params={"id": f"eq.{dispatch_id}", "vendor_id": f"eq.{user.vendor_id}", "select": "id,revoked_at"},
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Share not found")
    if rows[0]["revoked_at"]:
        raise HTTPException(status_code=409, detail="Already revoked")
    if _use_user_identity():
        # Flag-on: rpc_revoke_estimate_share (vendor-authz inside) does the revoke + access-log write in
        # one txn; direct PATCH / log INSERT on estimate_share_* is denied to users under RLS.
        rr = await db_client.post(
            _url("/rest/v1/rpc/rpc_revoke_estimate_share"),
            json={"p_dispatch_id": dispatch_id},
            headers=_headers(),
        )
        if not rr.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to revoke: {rr.text}")
    else:
        await db_client.patch(
            _url("/rest/v1/estimate_share_dispatches"),
            params={"id": f"eq.{dispatch_id}"},
            json={"revoked_at": _now_iso()},
            headers=_headers({"Prefer": "return=minimal"}),
        )
        await _log(dispatch_id, "revoked", actor_vendor_id=user.vendor_id)
    return {"ok": True}


# ── studio: inbox ──────────────────────────────────────────────────────────────
@router.get("/inbox")
async def inbox(user: CurrentUser = Depends(require_studio)):
    """Active estimate shares addressed to this studio (one live per vendor channel)."""
    r = await db_client.get(
        _url("/rest/v1/estimate_share_dispatches"),
        params={
            "recipient_studio_id": f"eq.{user.studio_id}",
            "superseded_at":       "is.null",
            "revoked_at":          "is.null",
            "or":                  f"(expires_at.is.null,expires_at.gt.{_now_iso()})",
            "select":              "id,vendor_id,link_id,snapshot,expires_at,created_at,estimate_share_series(label)",
            "order":               "created_at.desc",
        },
        headers=_headers(),
    )
    rows = r.json()
    vendor_ids = list({row["vendor_id"] for row in rows})
    vmap: dict = {}
    if vendor_ids:
        rv = await db_client.get(
            _url("/rest/v1/vendors"),
            params={"id": f"in.({','.join(vendor_ids)})", "select": "id,name,handle"},
            headers=_headers(),
        )
        vmap = {v["id"]: v for v in rv.json()}
    return [{
        "dispatch_id": row["id"],
        "vendor":      vmap.get(row["vendor_id"], {"id": row["vendor_id"]}),
        "label":       (row.get("estimate_share_series") or {}).get("label"),
        "granularity": (row.get("snapshot") or {}).get("granularity"),
        "expires_at":  row["expires_at"],
        "created_at":  row["created_at"],
        "snapshot":    row["snapshot"],
    } for row in rows]


# ── studio: record a view ──────────────────────────────────────────────────────
@router.post("/{dispatch_id}/view")
async def record_view(dispatch_id: str, user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/estimate_share_dispatches"),
        params={"id": f"eq.{dispatch_id}", "recipient_studio_id": f"eq.{user.studio_id}",
                "select": "id,revoked_at,expires_at"},
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Share not found")
    _assert_valid(rows[0])
    if _use_user_identity():
        # Flag-on: a studio cannot INSERT estimate_share_access_log directly (SELECT-only policy); the
        # rpc_log_estimate_share_view RPC (recipient-studio authz inside) writes the 'viewed' event.
        rr = await db_client.post(
            _url("/rest/v1/rpc/rpc_log_estimate_share_view"),
            json={"p_dispatch_id": dispatch_id},
            headers=_headers(),
        )
        if not rr.is_success:
            raise HTTPException(status_code=400, detail=f"Failed to record view: {rr.text}")
    else:
        await _log(dispatch_id, "viewed", actor_studio_id=user.studio_id)
    return {"ok": True}
