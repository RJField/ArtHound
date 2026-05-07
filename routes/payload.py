import asyncio
import logging
import re
from datetime import datetime, timezone, timedelta
from typing import Optional

import httpx

log = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_studio, require_vendor
from lib.db import db_client, _url, _headers

router = APIRouter()

_MAX_EXPIRY_DAYS = 30
_DEFAULT_EXPIRY_DAYS = 7


# ── internal helpers ──────────────────────────────────────────────────────────

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
    except Exception as exc:
        log.warning("payload audit log failed (dispatch=%s event=%s): %s", dispatch_id, event, exc)


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
        params={"id": f"eq.{template_id}", "studio_id": f"eq.{user.studio_id}"},
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
        params={"id": f"eq.{template_id}", "studio_id": f"eq.{user.studio_id}"},
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

        # Verify asset belongs to this studio (service role bypasses RLS)
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

        r_dispatch = await db_client.post(
            _url("/rest/v1/payload_dispatches"),
            headers=_headers({"Prefer": "return=representation"}),
            json={
                "asset_id": asset.asset_id,
                "sender_studio_id": studio_id,
                "recipient_vendor_id": body.vendor_id,
                "payload_data": payload_data,
                "expires_at": expires_at,
            },
        )
        dispatch_id = r_dispatch.json()[0]["id"]
        await _log(dispatch_id, "dispatched", actor_studio_id=studio_id)
        dispatch_ids.append(dispatch_id)

    from lib.attachments import enqueue_attachment_copy
    for did in dispatch_ids:
        await enqueue_attachment_copy(did)

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
            "expires_at": expires_at,
        },
    )
    dispatch_id = r_dispatch.json()[0]["id"]
    await _log(dispatch_id, "dispatched", actor_studio_id=studio_id)

    return {"dispatch_id": dispatch_id, "expires_at": expires_at}


# ── outbox ────────────────────────────────────────────────────────────────────

@router.get("/outbox")
async def get_outbox(user: CurrentUser = Depends(require_studio)):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "sender_studio_id": f"eq.{user.studio_id}",
            "select": "id,asset_id,recipient_vendor_id,template_id,expires_at,revoked_at,created_at,payload_data,payload_field_mappings(ingested_at,ingested_source_record_id,ingested_by_user_id)",
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

    # Resolve ingested_by_user_id → display name for all dispatches that were ingested.
    ingested_user_ids: set[str] = {
        m[0]["ingested_by_user_id"]
        for d in dispatches
        if (m := d.get("payload_field_mappings")) and m and m[0].get("ingested_by_user_id")
    }

    if ingested_user_ids:
        async def _resolve_user(uid: str) -> tuple[str, str]:
            try:
                ru = await db_client.get(
                    _url(f"/auth/v1/admin/users/{uid}"),
                    headers=_headers(),
                )
                if ru.is_success:
                    data = ru.json()
                    name = (
                        data.get("user_metadata", {}).get("full_name")
                        or data.get("user_metadata", {}).get("name")
                        or data.get("email")
                        or "Unknown"
                    )
                    return uid, name
            except Exception:
                pass
            return uid, "Unknown"

        user_name_map: dict[str, str] = dict(
            await asyncio.gather(*[_resolve_user(uid) for uid in ingested_user_ids])
        )

        for d in dispatches:
            mapping = (d.get("payload_field_mappings") or [None])[0]
            if mapping and mapping.get("ingested_by_user_id"):
                mapping["ingested_by_name"] = user_name_map.get(
                    mapping["ingested_by_user_id"], "Unknown"
                )

    return dispatches


# ── vendor inbox ──────────────────────────────────────────────────────────────

@router.get("/vendor-inbox")
async def get_vendor_inbox(user: CurrentUser = Depends(require_vendor)):
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "recipient_vendor_id": f"eq.{user.vendor_id}",
            "select": "id,asset_id,sender_studio_id,expires_at,revoked_at,created_at,payload_data,payload_field_mappings(ingested_at,ingested_source_record_id)",
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


# ── ingest schema (vendor: payload fields + their source schema for mapping UI) ──

@router.get("/{dispatch_id}/ingest-schema")
async def get_ingest_schema(dispatch_id: str, user: CurrentUser = Depends(require_vendor)):
    dispatch = await _get_dispatch(
        dispatch_id, select="id,recipient_vendor_id,revoked_at,expires_at,payload_data"
    )
    if not dispatch or dispatch.get("recipient_vendor_id") != user.vendor_id:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    _assert_valid(dispatch)

    # Fetch any existing saved mapping to pre-populate the UI
    r_mapping = await db_client.get(
        _url("/rest/v1/payload_field_mappings"),
        params={
            "dispatch_id": f"eq.{dispatch_id}",
            "recipient_vendor_id": f"eq.{user.vendor_id}",
            "select": "target_table_id,target_issue_type,mappings,ingested_at,ingested_source_record_id",
        },
        headers=_headers(),
    )
    existing_mapping = r_mapping.json()[0] if r_mapping.json() else None

    # Resolve the vendor's asset entity definition before opening the HTTP client
    # so we can make connector calls (fetch_project_issue_types) while it's still open.
    r_entity = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  "eq.vendor",
            "owner_id":    f"eq.{user.vendor_id}",
            "entity_type": "eq.asset",
            "select":      "table_id,table_name,filters,jql_filter,source_type",
        },
        headers=_headers(),
    )
    entity_rows = r_entity.json()

    async with httpx.AsyncClient(timeout=30.0) as client:
        source_type, connector = await _get_vendor_connector(user.vendor_id, client)
        source_schema = await connector.fetch_base_schema()

        auto_target = None
        if entity_rows:
            entity = entity_rows[0]
            issue_type = None
            if source_type == "jira":
                # Jira stores the issue type in jql_filter (e.g. issuetype = "Feature").
                # The init wizard never populates filters[] for Jira — parse JQL directly.
                jql = entity.get("jql_filter") or ""
                m = re.search(r'issuetype\s*=\s*["\']?([^"\')\s,]+)["\']?', jql, re.IGNORECASE)
                if m:
                    issue_type = m.group(1)
                else:
                    # Fall back to structured filters (future-proofing)
                    for f in (entity.get("filters") or []):
                        field_ref = (f.get("field_name") or f.get("field_id") or "").lower()
                        if f.get("operator") == "eq" and "issuetype" in field_ref:
                            issue_type = f.get("value")
                            break
            auto_target = {
                "table_id":   entity["table_id"],
                "table_name": entity["table_name"],
                "issue_type": issue_type,
            }

    payload_data = dispatch.get("payload_data") or {}
    data = payload_data.get("data") or {}
    schema_list = payload_data.get("schema") or []
    schema_by_key = {f["key"]: f for f in schema_list}

    payload_fields = [
        {
            "key": key,
            "label": schema_by_key.get(key, {}).get("label", key),
            "type": schema_by_key.get(key, {}).get("type", "text"),
            "value": value,
        }
        for key, value in data.items()
    ]

    return {
        "source_type":    source_type,
        "payload_fields": payload_fields,
        "source_schema":  source_schema,
        "auto_target":    auto_target,
        "existing_mapping": existing_mapping,
    }


# ── ingest (vendor: write payload to their source tool using the saved mapping) ──

@router.post("/{dispatch_id}/ingest")
async def do_ingest(dispatch_id: str, user: CurrentUser = Depends(require_vendor)):
    r_mapping = await db_client.get(
        _url("/rest/v1/payload_field_mappings"),
        params={
            "dispatch_id": f"eq.{dispatch_id}",
            "recipient_vendor_id": f"eq.{user.vendor_id}",
            "select": "*",
        },
        headers=_headers(),
    )
    rows = r_mapping.json()
    if not rows:
        raise HTTPException(status_code=404, detail="No mapping saved — save your field mapping first")
    mapping_row = rows[0]
    if mapping_row.get("ingested_at"):
        raise HTTPException(status_code=409, detail="Already ingested")

    mappings = mapping_row.get("mappings") or {}

    dispatch = await _get_dispatch(
        dispatch_id, select="id,recipient_vendor_id,revoked_at,expires_at,payload_data"
    )
    if not dispatch or dispatch.get("recipient_vendor_id") != user.vendor_id:
        raise HTTPException(status_code=404, detail="Dispatch not found")
    _assert_valid(dispatch)

    data = (dispatch.get("payload_data") or {}).get("data") or {}

    # Extract meta-summary config before iterating direct mappings.
    _RESERVED = {"_meta_summary_target", "_meta_summary_fields"}
    meta_target      = mappings.get("_meta_summary_target")
    meta_field_keys  = mappings.get("_meta_summary_fields") or []

    # Build the target record fields from the saved mapping.
    # Skip blank source_field_id (user left "— skip —") and reserved meta keys.
    target_fields: dict = {}
    for payload_key, source_field_id in mappings.items():
        if payload_key in _RESERVED or not source_field_id:
            continue
        raw = data.get(payload_key)
        if raw is None:
            continue
        target_fields[source_field_id] = raw if isinstance(raw, (dict, list)) else str(raw)

    async with httpx.AsyncClient(timeout=30.0) as client:
        source_type, connector = await _get_vendor_connector(user.vendor_id, client)

        # Resolve the target from the entity definition — always the authoritative source.
        # Must be inside the async with block so we can filter by source_type.
        r_entity = await db_client.get(
            _url("/rest/v1/source_entity_definitions"),
            params={
                "owner_type":  "eq.vendor",
                "owner_id":    f"eq.{user.vendor_id}",
                "source_type": f"eq.{source_type}",
                "entity_type": "eq.asset",
                "select":      "table_id,table_name,jql_filter,filters",
            },
            headers=_headers(),
        )
        entity_rows = r_entity.json()
        if not entity_rows:
            raise HTTPException(status_code=400, detail="No asset entity defined — complete your source setup first")
        entity = entity_rows[0]
        target_table_id = entity["table_id"]

        # Build and attach the meta summary block if the vendor configured one.
        if meta_target and meta_field_keys:
            payload_schema = (dispatch.get("payload_data") or {}).get("schema") or []
            label_by_key   = {f["key"]: f.get("label", f["key"]) for f in payload_schema}
            lines = []
            for key in meta_field_keys:
                val = data.get(key)
                if val is None:
                    continue
                label = label_by_key.get(key, key)
                lines.append(f"{label}: {_format_meta_value(val)}")
            if lines:
                text = "\n".join(lines)
                if source_type == "jira" and getattr(connector, "_deployment", "cloud") == "cloud" and meta_target == "description":
                    target_fields[meta_target] = _to_adf(text)
                else:
                    target_fields[meta_target] = text

        if source_type == "jira":
            # Jira text fields must be strings. Coerce lists and plain dicts.
            # ADF objects (type=doc) are only valid for the description field.
            for k, v in list(target_fields.items()):
                if isinstance(v, list):
                    target_fields[k] = ", ".join(str(i) for i in v)
                elif isinstance(v, dict):
                    is_adf = v.get("type") == "doc" and "version" in v
                    if is_adf and k != "description":
                        lines = []
                        for block in v.get("content", []):
                            for inline in block.get("content", []):
                                if inline.get("type") == "text":
                                    lines.append(inline.get("text", ""))
                        target_fields[k] = "\n".join(lines)
                    elif not is_adf:
                        target_fields[k] = _format_meta_value(v)

            # Parse issue type from the entity's jql_filter — the single source of truth.
            jql = entity.get("jql_filter") or ""
            m = re.search(r'issuetype\s*=\s*["\']?([^"\')\s,]+)["\']?', jql, re.IGNORECASE)
            resolved_issue_type = m.group(1) if m else None
            if not resolved_issue_type:
                for f in (entity.get("filters") or []):
                    field_ref = (f.get("field_name") or f.get("field_id") or "").lower()
                    if f.get("operator") == "eq" and "issuetype" in field_ref:
                        resolved_issue_type = f.get("value")
                        break
            if not resolved_issue_type:
                raise HTTPException(status_code=400, detail="Asset issue type not defined — check your source setup")

            # Named-object fields: Jira Cloud v3 requires {"name": value} not a plain string.
            _JIRA_NAMED_OBJ = {"priority", "assignee", "reporter", "resolution", "status", "parent"}
            for k, v in list(target_fields.items()):
                if k in _JIRA_NAMED_OBJ and isinstance(v, str) and v:
                    target_fields[k] = {"name": v}

            # Description must be ADF on Cloud v3 — wrap any plain string.
            if getattr(connector, "_deployment", "cloud") == "cloud":
                desc = target_fields.get("description")
                if isinstance(desc, str):
                    target_fields["description"] = _to_adf(desc)

            project_ref = {"id": target_table_id} if target_table_id.isdigit() else {"key": target_table_id}
            # summary is a single-line Jira field — collapse any newlines.
            if isinstance(target_fields.get("summary"), str):
                target_fields["summary"] = target_fields["summary"].replace("\n", " | ")

            target_fields.pop("project", None)
            target_fields.pop("issuetype", None)
            target_fields["project"]   = project_ref
            target_fields["issuetype"] = {"name": resolved_issue_type}
            source_record_id = await connector.create_issue(target_fields)
        else:
            source_record_id = await connector.create_record(target_table_id, target_fields)

    await db_client.patch(
        _url("/rest/v1/payload_field_mappings"),
        params={"dispatch_id": f"eq.{dispatch_id}", "recipient_vendor_id": f"eq.{user.vendor_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
        json={
            "ingested_at": _now_iso(),
            "ingested_source_record_id": source_record_id,
            "ingested_by_user_id": user.id,
        },
    )
    await _log(dispatch_id, "ingested", detail={"source_record_id": source_record_id})
    return {"ok": True, "source_record_id": source_record_id}


# ── internal: build a connector for a vendor's connected source tool ──────────

async def _get_vendor_connector(vendor_id: str, client: httpx.AsyncClient):
    r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type": "eq.vendor",
            "owner_id": f"eq.{vendor_id}",
            "select": "source_type,credentials",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(
            status_code=400,
            detail="No source connection found — connect your source tool first",
        )

    source_type = rows[0]["source_type"]

    if source_type == "jira":
        from lib.token_refresh import get_jira_token
        creds = await get_jira_token("vendor", vendor_id, client)
    else:
        from lib.crypto import decrypt_credentials
        creds = decrypt_credentials(rows[0]["credentials"])

    from lib.sync.runner import _build_connector
    connector = _build_connector(source_type, creds, client)
    return source_type, connector


def _format_meta_value(v) -> str:
    if isinstance(v, list):
        return ", ".join(str(i) for i in v)
    if isinstance(v, dict):
        return ", ".join(f"{k}: {val}" for k, val in v.items())
    return str(v)


def _to_adf(text: str) -> dict:
    """Wrap plain text in Atlassian Document Format for Jira Cloud v3."""
    content = []
    for line in (text.split("\n") or [""]):
        content.append({
            "type": "paragraph",
            "content": [{"type": "text", "text": line or " "}],
        })
    return {"type": "doc", "version": 1, "content": content}


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
    is_sender    = user.role == "studio" and d["sender_studio_id"] == user.studio_id
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
