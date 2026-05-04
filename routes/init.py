"""
Project initialisation routes.

Gated flow:
  1. POST /credentials        — validate + encrypt-store source credentials
  2. POST /discover           — fetch + cache full base schema (all tables)
  3. GET  /schema-cache       — retrieve full table/field schema for hierarchy UI
  4. GET|PUT /entity-definitions — define Product/Asset/Task hierarchy
  5. POST /preview-entity     — validate an entity definition against live data
  6. GET|PUT /field-mappings  — map asset + task fields to ArtHound slots
  7. POST /start              — gate-check then enqueue init job
  8. GET  /jobs/{id}          — poll progress
  POST /reset                 — wipe replicated data then re-enqueue
"""

import logging
from datetime import datetime, timezone
from typing import Literal

import httpx
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_studio
from lib.crypto import decrypt_credentials, encrypt_credentials
from lib.db import db_client, _url, _headers, _user_headers
from lib.sync.connectors.airtable import AirtableConnector, build_filter_formula
from lib.sync.init_runner import REQUIRED_SLOTS, run_init_sync
from lib.sync.normalizer import default_mappings_from_schema

log = logging.getLogger(__name__)

router = APIRouter()

_REQUIRED_SLOT_LABELS = [
    {"slot": "name",      "label": "Name"},
    {"slot": "status",    "label": "Status"},
    {"slot": "item_type", "label": "Item Type"},
]


def _owner(user: CurrentUser) -> tuple[str, str]:
    owner_type = user.role
    owner_id = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")
    return owner_type, owner_id


async def _load_creds(owner_type: str, owner_id: str, source_type: str) -> dict:
    r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "credentials",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=422, detail="No credentials stored — complete step 1 first")
    return decrypt_credentials(rows[0]["credentials"])


async def _check_mappings(owner_type: str, owner_id: str, source_type: str) -> None:
    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "mappings",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=422, detail="No field mappings saved — complete field mapping first")
    mapped_slots = {m["arthound_slot"] for m in rows[0]["mappings"] if m.get("arthound_slot")}
    missing = REQUIRED_SLOTS - mapped_slots
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Required fields not mapped: {', '.join(sorted(missing))}",
        )


# ── 1. Credentials ────────────────────────────────────────────────────────────

class CredentialsBody(BaseModel):
    source_type: str = "airtable"
    credentials: dict


@router.post("/credentials")
async def save_credentials(
    body: CredentialsBody,
    user: CurrentUser = Depends(get_current_user),
):
    """Validate credentials against the source API, then encrypt and store them."""
    owner_type, owner_id = _owner(user)

    if body.source_type == "airtable":
        creds = body.credentials
        if not creds.get("api_token") or not creds.get("base_id"):
            raise HTTPException(status_code=422, detail="api_token and base_id are required")

        async with httpx.AsyncClient(timeout=15.0) as client:
            connector = AirtableConnector(
                api_token=creds["api_token"],
                base_id=creds["base_id"],
                client=client,
            )
            try:
                tables = await connector.fetch_base_schema()
            except httpx.HTTPStatusError as e:
                if e.response.status_code == 401:
                    raise HTTPException(status_code=422, detail="Invalid API token")
                if e.response.status_code == 404:
                    raise HTTPException(status_code=422, detail="Base not found — check base_id")
                raise HTTPException(status_code=422, detail=f"Airtable error {e.response.status_code}")
            except Exception as e:
                raise HTTPException(status_code=422, detail=f"Connection failed: {e}")

        if not tables:
            raise HTTPException(status_code=422, detail="Connected but no tables found in base")
        table_count = len(tables)
        field_count = sum(len(t["fields"]) for t in tables)
    else:
        raise HTTPException(status_code=422, detail=f"Unsupported source_type: {body.source_type}")

    encrypted = encrypt_credentials(body.credentials)
    r = await db_client.post(
        _url("/rest/v1/source_credentials?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": body.source_type,
            "credentials": encrypted,
        },
    )
    r.raise_for_status()

    # Invalidate schema cache so next discover reflects new credentials
    await db_client.delete(
        _url("/rest/v1/source_schema_cache"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{body.source_type}",
        },
        headers=_headers(),
    )

    return {"ok": True, "table_count": table_count, "field_count": field_count}


# ── 2. Discover schema ────────────────────────────────────────────────────────

@router.post("/discover")
async def discover_schema(
    source_type: str = "airtable",
    user: CurrentUser = Depends(get_current_user),
):
    """Fetch full base schema (all tables + fields with options) and cache it."""
    owner_type, owner_id = _owner(user)
    creds = await _load_creds(owner_type, owner_id, source_type)

    async with httpx.AsyncClient(timeout=30.0) as client:
        if source_type == "airtable":
            connector = AirtableConnector(
                api_token=creds["api_token"],
                base_id=creds["base_id"],
                client=client,
            )
        else:
            raise HTTPException(status_code=422, detail=f"Unsupported source_type: {source_type}")

        tables = await connector.fetch_base_schema()

    discovered_at = datetime.now(timezone.utc).isoformat()

    # Cache stores all tables; hierarchy step reads this to build table selectors
    await db_client.post(
        _url("/rest/v1/source_schema_cache?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "owner_type":    owner_type,
            "owner_id":      owner_id,
            "source_type":   source_type,
            "fields":        tables,
            "discovered_at": discovered_at,
        },
    )

    return {"tables": tables, "discovered_at": discovered_at}


# ── 3. Schema cache (read) ────────────────────────────────────────────────────

@router.get("/schema-cache")
async def get_schema_cache(
    source_type: str = "airtable",
    user: CurrentUser = Depends(get_current_user),
):
    """Return full cached base schema. Call /discover first if this returns empty."""
    owner_type, owner_id = _owner(user)

    r = await db_client.get(
        _url("/rest/v1/source_schema_cache"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "fields,discovered_at",
        },
        headers=_user_headers(user.token),
    )
    rows = r.json()
    if not rows:
        return {"tables": [], "discovered_at": None}
    return {"tables": rows[0]["fields"], "discovered_at": rows[0]["discovered_at"]}


# ── 4. Entity definitions ─────────────────────────────────────────────────────

EntityType   = Literal["product", "asset", "work", "item_type"]
RelDirection = Literal["child_holds_link", "parent_holds_link"]

_PARENT_OF: dict[str, str | None] = {
    "product":   None,
    "asset":     "product",
    "work":      "asset",
    "item_type": None,
}


class FilterRule(BaseModel):
    field_id:   str
    field_name: str
    operator:   str = "eq"  # eq | neq | contains
    value:      str


class EntityDefinitionBody(BaseModel):
    source_type:    str = "airtable"
    entity_type:    EntityType
    table_id:       str
    table_name:     str
    filters:        list[FilterRule] = []
    rel_field_id:   str | None = None
    rel_field_name: str | None = None
    rel_direction:  RelDirection | None = None
    # Work-specific field mappings (only populated when entity_type == 'work')
    work_name_field_id:         str | None = None
    work_name_field_name:       str | None = None
    work_status_field_id:       str | None = None
    work_status_field_name:     str | None = None
    work_start_date_field_id:   str | None = None
    work_start_date_field_name: str | None = None
    work_end_date_field_id:     str | None = None
    work_end_date_field_name:   str | None = None
    work_estimate_field_id:     str | None = None
    work_estimate_field_name:   str | None = None
    field_mappings:             dict       = {}


@router.get("/entity-definitions")
async def get_entity_definitions(
    source_type: str = "airtable",
    user: CurrentUser = Depends(get_current_user),
):
    """Return all saved entity definitions keyed by entity_type."""
    owner_type, owner_id = _owner(user)

    r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "entity_type,table_id,table_name,filters,"
                           "parent_entity_type,rel_field_id,rel_field_name,rel_direction,"
                           "work_name_field_id,work_name_field_name,"
                           "work_status_field_id,work_status_field_name,"
                           "work_start_date_field_id,work_start_date_field_name,"
                           "work_end_date_field_id,work_end_date_field_name,"
                           "work_estimate_field_id,work_estimate_field_name,"
                           "field_mappings",
        },
        headers=_user_headers(user.token),
    )
    r.raise_for_status()
    return {row["entity_type"]: row for row in r.json()}


@router.put("/entity-definitions")
async def save_entity_definition(
    body: EntityDefinitionBody,
    user: CurrentUser = Depends(get_current_user),
):
    """Save one entity definition. Asset and Task require rel_field_id + rel_direction."""
    owner_type, owner_id = _owner(user)

    parent_entity_type = _PARENT_OF[body.entity_type]

    r = await db_client.post(
        _url("/rest/v1/source_entity_definitions"
             "?on_conflict=owner_type,owner_id,source_type,entity_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "owner_type":                owner_type,
            "owner_id":                  owner_id,
            "source_type":               body.source_type,
            "entity_type":               body.entity_type,
            "table_id":                  body.table_id,
            "table_name":                body.table_name,
            "filters":                   [f.model_dump() for f in body.filters],
            "parent_entity_type":        parent_entity_type,
            "rel_field_id":              body.rel_field_id,
            "rel_field_name":            body.rel_field_name,
            "rel_direction":             body.rel_direction,
            "work_name_field_id":        body.work_name_field_id,
            "work_name_field_name":      body.work_name_field_name,
            "work_status_field_id":      body.work_status_field_id,
            "work_status_field_name":    body.work_status_field_name,
            "work_start_date_field_id":  body.work_start_date_field_id,
            "work_start_date_field_name": body.work_start_date_field_name,
            "work_end_date_field_id":    body.work_end_date_field_id,
            "work_end_date_field_name":  body.work_end_date_field_name,
            "work_estimate_field_id":    body.work_estimate_field_id,
            "work_estimate_field_name":  body.work_estimate_field_name,
            "field_mappings":            body.field_mappings,
        },
    )
    r.raise_for_status()

    # When the asset table is selected, seed default field mappings from that
    # specific table's fields (only if no mappings have been saved yet).
    if body.entity_type == "asset":
        existing_r = await db_client.get(
            _url("/rest/v1/source_field_mappings"),
            params={
                "owner_type":  f"eq.{owner_type}",
                "owner_id":    f"eq.{owner_id}",
                "source_type": f"eq.{body.source_type}",
                "select":      "id",
            },
            headers=_headers(),
        )
        if not existing_r.json():
            cache_r = await db_client.get(
                _url("/rest/v1/source_schema_cache"),
                params={
                    "owner_type":  f"eq.{owner_type}",
                    "owner_id":    f"eq.{owner_id}",
                    "source_type": f"eq.{body.source_type}",
                    "select":      "fields",
                },
                headers=_headers(),
            )
            cache_rows = cache_r.json()
            if cache_rows:
                all_tables = cache_rows[0]["fields"]
                table = next((t for t in all_tables if t["id"] == body.table_id), None)
                if table:
                    from lib.sync.connector import SchemaField as SF
                    from lib.sync.writer import save_default_mappings
                    schema_objs = [
                        SF(id=f["id"], name=f["name"], type=f["type"],
                           category=f["category"], options=f.get("options") or {})
                        for f in table["fields"]
                    ]
                    await save_default_mappings(
                        owner_type, owner_id, body.source_type,
                        default_mappings_from_schema(schema_objs),
                    )

    return {"ok": True}


# ── 5. Entity preview ─────────────────────────────────────────────────────────

class PreviewBody(BaseModel):
    source_type: str = "airtable"
    entity_type: EntityType
    table_id:    str
    filters:     list[FilterRule] = []


@router.post("/preview-entity")
async def preview_entity(
    body: PreviewBody,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Fetch up to 101 records matching the entity definition. Returns count,
    has_more flag, and 3 name samples — validates the definition before committing.
    """
    owner_type, owner_id = _owner(user)
    creds = await _load_creds(owner_type, owner_id, body.source_type)

    formula = build_filter_formula([f.model_dump() for f in body.filters])

    async with httpx.AsyncClient(timeout=30.0) as client:
        if body.source_type == "airtable":
            connector = AirtableConnector(
                api_token=creds["api_token"],
                base_id=creds["base_id"],
                client=client,
            )
        else:
            raise HTTPException(
                status_code=422,
                detail=f"Unsupported source_type: {body.source_type}",
            )
        try:
            records = await connector.fetch_entity(
                table_id=body.table_id,
                filter_formula=formula,
                max_records=101,
            )
        except httpx.HTTPStatusError as e:
            raise HTTPException(
                status_code=422,
                detail=f"Airtable error {e.response.status_code}: {e.response.text[:200]}",
            )

    has_more = len(records) > 100
    records  = records[:100]

    def _name(fields: dict) -> str:
        for key in ("Name", "name", "Title", "title", "Asset Name", "Task Name"):
            if isinstance(fields.get(key), str) and fields[key].strip():
                return fields[key]
        return next((v for v in fields.values() if isinstance(v, str) and v.strip()), "(unnamed)")

    return {
        "count":    len(records),
        "has_more": has_more,
        "samples":  [_name(r.fields) for r in records[:3]],
    }


# ── 6. Field mappings (with required-slot gate) ───────────────────────────────

class FieldMappingsBody(BaseModel):
    source_type: str = "airtable"
    mappings: list[dict]


@router.put("/field-mappings")
async def save_field_mappings(
    body: FieldMappingsBody,
    user: CurrentUser = Depends(get_current_user),
):
    """Persist field mappings. Rejects if any required slot is not covered."""
    owner_type, owner_id = _owner(user)

    mapped_slots = {m["arthound_slot"] for m in body.mappings if m.get("arthound_slot")}
    missing = REQUIRED_SLOTS - mapped_slots
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Required fields not mapped: {', '.join(sorted(missing))}",
        )

    r = await db_client.post(
        _url("/rest/v1/source_field_mappings?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": body.source_type,
            "mappings":    body.mappings,
        },
    )
    r.raise_for_status()
    return {"ok": True, "mapped_slots": sorted(mapped_slots)}


@router.get("/field-mappings")
async def get_field_mappings(
    source_type: str = "airtable",
    user: CurrentUser = Depends(get_current_user),
):
    """Return current mappings, available slots, and which slots are required."""
    owner_type, owner_id = _owner(user)

    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "mappings,updated_at",
        },
        headers=_user_headers(user.token),
    )
    rows = r.json()
    mappings = rows[0]["mappings"] if rows else []
    mapped_slots = {m["arthound_slot"] for m in mappings if m.get("arthound_slot")}

    return {
        "mappings":         mappings,
        "required_slots":   _REQUIRED_SLOT_LABELS,
        "missing_required": sorted(REQUIRED_SLOTS - mapped_slots),
        "updated_at":       rows[0].get("updated_at") if rows else None,
    }


# ── 7. Start init ─────────────────────────────────────────────────────────────

class StartBody(BaseModel):
    source_type: str = "airtable"


@router.post("/start")
async def start_init(
    body: StartBody,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(require_studio),
):
    """Gate-check credentials + mappings, then enqueue an init sync job."""
    owner_type, owner_id = _owner(user)
    await _load_creds(owner_type, owner_id, body.source_type)
    await _check_mappings(owner_type, owner_id, body.source_type)

    r = await db_client.post(
        _url("/rest/v1/init_jobs"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": body.source_type,
            "status":      "pending",
            "is_reset":    False,
        },
    )
    r.raise_for_status()
    job_id = r.json()[0]["id"]

    background_tasks.add_task(
        run_init_sync,
        job_id=job_id,
        owner_type=owner_type,
        owner_id=owner_id,
        source_type=body.source_type,
    )
    return {"job_id": job_id}


# ── 8. Job status ─────────────────────────────────────────────────────────────

@router.get("/jobs/{job_id}")
async def get_job(
    job_id: str,
    user: CurrentUser = Depends(get_current_user),
):
    """Poll init job status and progress."""
    owner_type, owner_id = _owner(user)

    r = await db_client.get(
        _url("/rest/v1/init_jobs"),
        params={
            "id":          f"eq.{job_id}",
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "select":      "id,status,phase,progress_current,progress_total,"
                           "error_log,is_reset,created_at,started_at,completed_at",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Job not found")
    return rows[0]


# ── Reset ─────────────────────────────────────────────────────────────────────

class ResetBody(BaseModel):
    source_type: str = "airtable"


@router.post("/reset")
async def reset_project(
    body: ResetBody,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(require_studio),
):
    """Wipe replicated data, soft-delete tasks, clear cursor, then re-enqueue."""
    owner_type, owner_id = _owner(user)
    await _load_creds(owner_type, owner_id, body.source_type)
    await _check_mappings(owner_type, owner_id, body.source_type)

    for table in ("replicated_assets", "replicated_products", "replicated_item_types"):
        await db_client.delete(
            _url(f"/rest/v1/{table}"),
            params={
                "owner_type":  f"eq.{owner_type}",
                "owner_id":    f"eq.{owner_id}",
                "source_type": f"eq.{body.source_type}",
            },
            headers=_headers(),
        )

    if owner_type == "studio":
        await db_client.patch(
            _url("/rest/v1/generated_work"),
            params={"studio_id": f"eq.{owner_id}", "deleted_at": "is.null"},
            json={"deleted_at": datetime.now(timezone.utc).isoformat()},
            headers=_headers({"Prefer": "return=minimal"}),
        )

    await db_client.patch(
        _url("/rest/v1/sync_cursors"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{body.source_type}",
        },
        json={"last_synced_at": None},
        headers=_headers({"Prefer": "return=minimal"}),
    )

    if owner_type == "studio":
        await db_client.patch(
            _url(f"/rest/v1/studios?id=eq.{owner_id}"),
            json={"initialized_at": None},
            headers=_headers({"Prefer": "return=minimal"}),
        )

    r = await db_client.post(
        _url("/rest/v1/init_jobs"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": body.source_type,
            "status":      "pending",
            "is_reset":    True,
        },
    )
    r.raise_for_status()
    job_id = r.json()[0]["id"]

    background_tasks.add_task(
        run_init_sync,
        job_id=job_id,
        owner_type=owner_type,
        owner_id=owner_id,
        source_type=body.source_type,
    )
    return {"job_id": job_id}
