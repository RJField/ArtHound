import hashlib
import secrets
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_studio, require_vendor
from lib.db import db_client, _url, _headers

router = APIRouter()

_MAX_EXPIRY_DAYS = 30
_DEFAULT_EXPIRY_DAYS = 7


# ── internal helpers ──────────────────────────────────────────────────────────

def _make_token() -> tuple[str, str]:
    """Return (plaintext_token, sha256_hex). Plaintext returned to caller once only."""
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode()).hexdigest()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _log(
    dispatch_id: str,
    event: str,
    actor_studio_id: Optional[str] = None,
    detail: Optional[dict] = None,
) -> None:
    try:
        await db_client.post(
            _url("/rest/v1/payload_access_log"),
            headers=_headers({"Prefer": "return=minimal"}),
            json={
                "dispatch_id": dispatch_id,
                "event": event,
                "actor_studio_id": actor_studio_id,
                "detail": detail,
            },
        )
    except Exception:
        pass  # audit failure must never block the primary operation


async def _get_dispatch(dispatch_id: str, select: str = "*") -> dict | None:
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={"id": f"eq.{dispatch_id}", "select": select},
        headers=_headers(),
    )
    rows = r.json()
    return rows[0] if rows else None


def _assert_valid(dispatch: dict) -> None:
    """Raise 410 if revoked or expired."""
    if dispatch.get("revoked_at"):
        raise HTTPException(status_code=410, detail="Payload has been revoked")
    expires = datetime.fromisoformat(dispatch["expires_at"])
    if datetime.now(timezone.utc) > expires:
        raise HTTPException(status_code=410, detail="Payload has expired")


# ── vendors list (for dispatch modal dropdown) ────────────────────────────────

@router.get("/vendors")
async def list_vendors(_: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/vendors"),
        params={"select": "id,name", "order": "name.asc"},
        headers=_headers(),
    )
    return r.json()


# ── templates ─────────────────────────────────────────────────────────────────

class TemplateBody(BaseModel):
    name: str
    field_schema: list[dict]


@router.get("/templates")
async def list_templates(user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/payload_templates"),
        params={
            "studio_id": f"eq.{user.studio_id}",
            "select": "*",
            "order": "created_at.asc",
        },
        headers=_headers(),
    )
    return r.json()


@router.post("/templates", status_code=201)
async def create_template(body: TemplateBody, user: CurrentUser = Depends(require_studio)):
    r = await db_client.post(
        _url("/rest/v1/payload_templates"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "studio_id": user.studio_id,
            "name": body.name.strip(),
            "field_schema": body.field_schema,
        },
    )
    return r.json()[0]


@router.put("/templates/{template_id}")
async def update_template(
    template_id: str, body: TemplateBody, user: CurrentUser = Depends(require_studio)
):
    r = await db_client.get(
        _url("/rest/v1/payload_templates"),
        params={"id": f"eq.{template_id}", "studio_id": f"eq.{user.studio_id}", "select": "id"},
        headers=_headers(),
    )
    if not r.json():
        raise HTTPException(status_code=404, detail="Template not found")

    await db_client.patch(
        _url("/rest/v1/payload_templates"),
        params={"id": f"eq.{template_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"name": body.name.strip(), "field_schema": body.field_schema, "updated_at": _now_iso()},
    )
    return {"ok": True}


@router.delete("/templates/{template_id}")
async def delete_template(template_id: str, user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/payload_templates"),
        params={"id": f"eq.{template_id}", "studio_id": f"eq.{user.studio_id}", "select": "id"},
        headers=_headers(),
    )
    if not r.json():
        raise HTTPException(status_code=404, detail="Template not found")

    await db_client.delete(
        _url("/rest/v1/payload_templates"),
        params={"id": f"eq.{template_id}"},
        headers=_headers(),
    )
    return {"ok": True}


# ── bulk dispatch (studio → vendor, multiple assets) ──────────────────────────

class BulkAsset(BaseModel):
    asset_id: str   # canonical_assets UUID
    asset_data: dict


class BulkDispatchBody(BaseModel):
    vendor_id: str
    assets: list[BulkAsset]
    expires_in_days: int = _DEFAULT_EXPIRY_DAYS


@router.post("/dispatch-bulk", status_code=201)
async def dispatch_bulk(body: BulkDispatchBody, user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id

    # Verify vendor exists
    r_vendor = await db_client.get(
        _url("/rest/v1/vendors"),
        params={"id": f"eq.{body.vendor_id}", "select": "id,name"},
        headers=_headers(),
    )
    vendors = r_vendor.json()
    if not vendors:
        raise HTTPException(status_code=404, detail="Vendor not found")

    # Embed sender studio name so payload is self-describing without a DB join
    r_studio = await db_client.get(
        _url("/rest/v1/studios"),
        params={"id": f"eq.{studio_id}", "select": "name"},
        headers=_headers(),
    )
    studio_name = r_studio.json()[0]["name"] if r_studio.json() else "Unknown Studio"

    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(days=max(1, min(body.expires_in_days, _MAX_EXPIRY_DAYS)))).isoformat()

    dispatch_ids = []
    for asset in body.assets:
        if not asset.asset_id:
            continue

        # Verify asset belongs to this studio
        r_asset = await db_client.get(
            _url("/rest/v1/canonical_assets"),
            params={"id": f"eq.{asset.asset_id}", "studio_id": f"eq.{studio_id}", "select": "id"},
            headers=_headers(),
        )
        if not r_asset.json():
            continue

        field_schema = [{"key": k, "label": k, "type": "text"} for k in asset.asset_data.keys()]
        payload_data = {
            "asset_global_id": asset.asset_id,
            "sender_studio_name": studio_name,
            "schema": field_schema,
            "data": asset.asset_data,
            "dispatched_at": now.isoformat(),
        }

        token, token_hash = _make_token()

        r_dispatch = await db_client.post(
            _url("/rest/v1/payload_dispatches"),
            headers=_headers({"Prefer": "return=representation"}),
            json={
                "asset_id": asset.asset_id,
                "sender_studio_id": studio_id,
                "recipient_vendor_id": body.vendor_id,
                "payload_data": payload_data,
                "token_hash": token_hash,
                "expires_at": expires_at,
            },
        )
        dispatch_id = r_dispatch.json()[0]["id"]
        await _log(dispatch_id, "dispatched", actor_studio_id=studio_id)
        dispatch_ids.append(dispatch_id)

    return {"dispatched": len(dispatch_ids), "dispatch_ids": dispatch_ids}


# ── single dispatch (for API / future template-based use) ─────────────────────

class DispatchBody(BaseModel):
    asset_id: str
    template_id: str
    asset_data: dict
    recipient_vendor_id: Optional[str] = None
    expires_in_days: int = _DEFAULT_EXPIRY_DAYS


@router.post("/dispatch", status_code=201)
async def dispatch_payload(body: DispatchBody, user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id

    r_asset = await db_client.get(
        _url("/rest/v1/canonical_assets"),
        params={"id": f"eq.{body.asset_id}", "studio_id": f"eq.{studio_id}", "select": "id"},
        headers=_headers(),
    )
    if not r_asset.json():
        raise HTTPException(status_code=404, detail="Asset not found")

    r_tmpl = await db_client.get(
        _url("/rest/v1/payload_templates"),
        params={"id": f"eq.{body.template_id}", "studio_id": f"eq.{studio_id}", "select": "*"},
        headers=_headers(),
    )
    templates = r_tmpl.json()
    if not templates:
        raise HTTPException(status_code=404, detail="Template not found")

    field_schema: list[dict] = templates[0]["field_schema"]
    allowed_keys = {f["key"] for f in field_schema}

    now = datetime.now(timezone.utc)
    payload_data = {
        "asset_global_id": body.asset_id,
        "schema": field_schema,
        "data": {k: v for k, v in body.asset_data.items() if k in allowed_keys},
        "dispatched_at": now.isoformat(),
    }

    token, token_hash = _make_token()
    expires_at = (now + timedelta(days=max(1, min(body.expires_in_days, _MAX_EXPIRY_DAYS)))).isoformat()

    r_dispatch = await db_client.post(
        _url("/rest/v1/payload_dispatches"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "asset_id": body.asset_id,
            "sender_studio_id": studio_id,
            "recipient_vendor_id": body.recipient_vendor_id,
            "template_id": body.template_id,
            "payload_data": payload_data,
            "token_hash": token_hash,
            "expires_at": expires_at,
        },
    )
    dispatch_id = r_dispatch.json()[0]["id"]
    await _log(dispatch_id, "dispatched", actor_studio_id=studio_id)

    return {"dispatch_id": dispatch_id, "token": token, "expires_at": expires_at}


# ── outbox ────────────────────────────────────────────────────────────────────

@router.get("/outbox")
async def get_outbox(user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "sender_studio_id": f"eq.{user.studio_id}",
            "select": "id,asset_id,recipient_vendor_id,template_id,expires_at,received_at,revoked_at,created_at",
            "order": "created_at.desc",
        },
        headers=_headers(),
    )
    dispatches = r.json()
    if not dispatches:
        return []

    ids_csv = ",".join(d["id"] for d in dispatches)
    r_log = await db_client.get(
        _url("/rest/v1/payload_access_log"),
        params={
            "dispatch_id": f"in.({ids_csv})",
            "event": "eq.viewed",
            "select": "dispatch_id",
        },
        headers=_headers(),
    )
    view_counts: dict[str, int] = {}
    for row in r_log.json():
        did = row["dispatch_id"]
        view_counts[did] = view_counts.get(did, 0) + 1

    for d in dispatches:
        d["view_count"] = view_counts.get(d["id"], 0)

    return dispatches


# ── vendor inbox ──────────────────────────────────────────────────────────────

@router.get("/vendor-inbox")
async def get_vendor_inbox(user: CurrentUser = Depends(require_vendor)):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "recipient_vendor_id": f"eq.{user.vendor_id}",
            "select": "id,asset_id,sender_studio_id,expires_at,received_at,revoked_at,created_at,payload_data",
            "order": "created_at.desc",
        },
        headers=_headers(),
    )
    now = datetime.now(timezone.utc)
    return [
        d for d in r.json()
        if not d["revoked_at"]
        and datetime.fromisoformat(d["expires_at"]) > now
    ]


# ── receive by token (public — token IS the credential) ───────────────────────

@router.get("/receive/{token}")
async def receive_payload(token: str):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={"token_hash": f"eq.{_hash_token(token)}", "select": "*"},
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Not found")

    dispatch = rows[0]

    if dispatch.get("revoked_at"):
        await _log(dispatch["id"], "denied", detail={"reason": "revoked"})
        raise HTTPException(status_code=410, detail="Payload has been revoked")

    if datetime.now(timezone.utc) > datetime.fromisoformat(dispatch["expires_at"]):
        await _log(dispatch["id"], "denied", detail={"reason": "expired"})
        raise HTTPException(status_code=410, detail="Payload has expired")

    if not dispatch["received_at"]:
        await db_client.patch(
            _url("/rest/v1/payload_dispatches"),
            params={"id": f"eq.{dispatch['id']}"},
            headers=_headers({"Prefer": "return=minimal"}),
            json={"received_at": _now_iso()},
        )
        await _log(dispatch["id"], "received")

    return {
        "dispatch_id": dispatch["id"],
        "sender_studio_id": dispatch["sender_studio_id"],
        "expires_at": dispatch["expires_at"],
        "payload": dispatch["payload_data"],
    }


# ── vendor viewed (vendor records that they opened the asset detail) ──────────

@router.post("/{dispatch_id}/viewed", status_code=204)
async def record_view(dispatch_id: str, user: CurrentUser = Depends(require_vendor)):
    dispatch = await _get_dispatch(dispatch_id, select="id,recipient_vendor_id,revoked_at,expires_at")
    if not dispatch or dispatch.get("recipient_vendor_id") != user.vendor_id:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    _assert_valid(dispatch)
    await _log(dispatch_id, "viewed")
    return Response(status_code=204)


# ── revoke (sender only) ───────────────────────────────────────────────────────

@router.delete("/dispatch/{dispatch_id}")
async def revoke_dispatch(dispatch_id: str, user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "id": f"eq.{dispatch_id}",
            "sender_studio_id": f"eq.{user.studio_id}",
            "select": "id,revoked_at",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    if rows[0]["revoked_at"]:
        raise HTTPException(status_code=409, detail="Already revoked")

    await db_client.patch(
        _url("/rest/v1/payload_dispatches"),
        params={"id": f"eq.{dispatch_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"revoked_at": _now_iso()},
    )
    await _log(dispatch_id, "revoked", actor_studio_id=user.studio_id)
    return {"ok": True}


# ── field mapping (recipient vendor) ─────────────────────────────────────────

class MappingBody(BaseModel):
    mappings: dict


@router.post("/{dispatch_id}/mapping")
async def save_mapping(
    dispatch_id: str, body: MappingBody, user: CurrentUser = Depends(require_vendor)
):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "id": f"eq.{dispatch_id}",
            "recipient_vendor_id": f"eq.{user.vendor_id}",
            "select": "id,revoked_at,expires_at",
        },
        headers=_headers(),
    )
    if not r.json():
        raise HTTPException(status_code=404, detail="Dispatch not found")
    _assert_valid(r.json()[0])

    await db_client.post(
        _url("/rest/v1/payload_field_mappings"),
        params={"on_conflict": "dispatch_id,recipient_vendor_id"},
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "dispatch_id": dispatch_id,
            "recipient_vendor_id": user.vendor_id,
            "mappings": body.mappings,
            "updated_at": _now_iso(),
        },
    )
    await _log(dispatch_id, "mapped")
    return {"ok": True}


@router.post("/{dispatch_id}/apply")
async def apply_mapping(dispatch_id: str, user: CurrentUser = Depends(require_vendor)):
    r = await db_client.get(
        _url("/rest/v1/payload_field_mappings"),
        params={
            "dispatch_id": f"eq.{dispatch_id}",
            "recipient_vendor_id": f"eq.{user.vendor_id}",
            "select": "*",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="No mapping found — save a mapping first")
    if rows[0]["applied_at"]:
        raise HTTPException(status_code=409, detail="Already applied")

    dispatch = await _get_dispatch(dispatch_id, select="id,revoked_at,expires_at,recipient_vendor_id")
    if not dispatch or dispatch.get("recipient_vendor_id") != user.vendor_id:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    _assert_valid(dispatch)

    await db_client.patch(
        _url("/rest/v1/payload_field_mappings"),
        params={"dispatch_id": f"eq.{dispatch_id}", "recipient_vendor_id": f"eq.{user.vendor_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={"applied_at": _now_iso()},
    )
    await _log(dispatch_id, "applied")
    return {"ok": True, "mappings": rows[0]["mappings"]}


# ── audit log (sender or recipient) ───────────────────────────────────────────

@router.get("/{dispatch_id}/log")
async def get_audit_log(dispatch_id: str, user: CurrentUser = Depends(get_current_user)):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={"id": f"eq.{dispatch_id}", "select": "sender_studio_id,recipient_vendor_id"},
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Dispatch not found")

    d = rows[0]
    is_sender   = user.role == "studio" and d["sender_studio_id"] == user.studio_id
    is_recipient = user.role == "vendor" and d["recipient_vendor_id"] == user.vendor_id
    if not is_sender and not is_recipient:
        raise HTTPException(status_code=403, detail="Access denied")

    r_log = await db_client.get(
        _url("/rest/v1/payload_access_log"),
        params={
            "dispatch_id": f"eq.{dispatch_id}",
            "select": "event,actor_studio_id,detail,created_at",
            "order": "created_at.asc",
        },
        headers=_headers(),
    )
    return r_log.json()
