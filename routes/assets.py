import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.airtable import update_records
from lib.auth import CurrentUser, get_current_user, require_studio
from lib.db import db_client, _url, _headers
import config

router = APIRouter()


def _owner(user: CurrentUser) -> tuple[str, str]:
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")
    return owner_type, owner_id


def _fmt(v) -> object:
    """Convert a meta value to a display-friendly form."""
    if v is None:
        return None
    if isinstance(v, list):
        if not v:
            return None
        if all(isinstance(x, str) and x.startswith("rec") for x in v):
            return None  # bare linked-record IDs — not useful for display
        if all(isinstance(x, dict) and "url" in x for x in v):
            return v  # attachments — keep as-is
        return ", ".join(str(x) for x in v if x) or None
    if isinstance(v, bool):
        return "Yes" if v else "No"
    return v


def _build_asset_response(
    row: dict,
    product_id_to_name: dict,
    product_name_to_id: dict,
    item_type_id_to_name: dict,
) -> dict:
    meta = row.get("meta") or {}

    # Resolve product name + source ID
    product_name = row.get("product")
    product_id   = product_name_to_id.get(product_name) if product_name else None
    if not product_id:
        for pid in (meta.get("Product") or []):
            if pid in product_id_to_name:
                product_name = product_id_to_name[pid]
                product_id   = pid
                break

    # Resolve item type — slot is null for linked records; fall back to meta IDs
    item_type = row.get("item_type")
    if not item_type:
        for iid in (meta.get("Item Type") or []):
            if iid in item_type_id_to_name:
                item_type = item_type_id_to_name[iid]
                break

    # Team from meta (Airtable lookup field returns a list)
    team_raw = meta.get("Team (from Product)")
    if isinstance(team_raw, list):
        team = ", ".join(str(x) for x in team_raw if x) or None
    else:
        team = str(team_raw) if team_raw else None

    # Reconstruct rawFields from meta, skipping bare record-ID arrays
    raw_fields = {}
    for k, v in meta.items():
        display = _fmt(v)
        if display is not None:
            raw_fields[k] = display

    # Expose slot values that aren't in BUILTIN_FIELDS so they're available in the
    # field selector's "Additional" section (e.g. Status).
    for slot, field_name in (("status", "Status"),):
        val = row.get(slot)
        if val is not None and field_name not in raw_fields:
            raw_fields[field_name] = str(val)

    return {
        "id":           row["source_record_id"],
        "canonicalId":  row.get("canonical_asset_id"),
        "assetNumber":  row.get("asset_number"),
        "name":         row.get("name") or "",
        "devName":      row.get("dev_name"),
        "productId":    product_id,
        "product":      product_name,
        "itemType":     item_type,
        "team":         team,
        "priority":     row.get("priority"),
        "projectDate":  row.get("project_date"),
        "rawFields":    raw_fields,
    }


async def _fetch_ref_table(owner_type: str, owner_id: str, table: str) -> list[dict]:
    r = await db_client.get(
        _url(f"/rest/v1/{table}"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.airtable",
            "select":      "source_record_id,name",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return r.json()


async def _fetch_products_map(owner_type: str, owner_id: str) -> tuple[dict, dict]:
    """Returns (source_record_id → name, name → source_record_id) for replicated_products."""
    rows = await _fetch_ref_table(owner_type, owner_id, "replicated_products")
    id_to_name = {p["source_record_id"]: p["name"] for p in rows}
    name_to_id = {p["name"]: p["source_record_id"] for p in rows}
    return id_to_name, name_to_id


async def _fetch_item_types_map(owner_type: str, owner_id: str) -> dict:
    """Returns source_record_id → name for replicated_item_types."""
    rows = await _fetch_ref_table(owner_type, owner_id, "replicated_item_types")
    return {r["source_record_id"]: r["name"] for r in rows}


# ── Products ──────────────────────────────────────────────────────────────────

@router.get("/products")
async def get_products(user: CurrentUser = Depends(get_current_user)):
    owner_type, owner_id = _owner(user)
    r = await db_client.get(
        _url("/rest/v1/replicated_products"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.airtable",
            "select":      "source_record_id,name",
            "order":       "name.asc",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return [{"id": p["source_record_id"], "name": p["name"]} for p in r.json()]


# ── Asset list ────────────────────────────────────────────────────────────────

@router.get("")
@router.get("/")
async def get_assets(
    productId: Optional[str] = Query(None),
    current_user: CurrentUser = Depends(get_current_user),
):
    owner_type, owner_id = _owner(current_user)

    asset_params = {
        "owner_type":  f"eq.{owner_type}",
        "owner_id":    f"eq.{owner_id}",
        "source_type": "eq.airtable",
        "order":       "name.asc",
    }

    asset_r, (prod_id_to_name, prod_name_to_id), it_id_to_name = await asyncio.gather(
        db_client.get(_url("/rest/v1/replicated_assets"), params=asset_params, headers=_headers()),
        _fetch_products_map(owner_type, owner_id),
        _fetch_item_types_map(owner_type, owner_id),
    )
    asset_r.raise_for_status()
    rows = asset_r.json()

    if productId:
        target_name = prod_id_to_name.get(productId)
        rows = [
            row for row in rows
            if productId in (row.get("meta") or {}).get("Product", [])
            or (target_name and row.get("product") == target_name)
        ]

    return [_build_asset_response(r, prod_id_to_name, prod_name_to_id, it_id_to_name) for r in rows]


# ── Field list (for detail panel field picker) ───────────────────────────────

@router.get("/fields")
async def get_asset_fields(user: CurrentUser = Depends(get_current_user)):
    """Return discovered source fields from the synced field mapping."""
    owner_type, owner_id = _owner(user)
    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.airtable",
            "select":      "mappings",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return []
    mappings = rows[0].get("mappings") or []
    return [{"name": m["source_field_name"], "type": "text"} for m in mappings]


# ── Single asset ──────────────────────────────────────────────────────────────

@router.get("/{asset_id}")
async def get_asset(asset_id: str, current_user: CurrentUser = Depends(get_current_user)):
    owner_type, owner_id = _owner(current_user)

    asset_r, (prod_id_to_name, prod_name_to_id), it_id_to_name = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={
                "owner_type":       f"eq.{owner_type}",
                "owner_id":         f"eq.{owner_id}",
                "source_type":      "eq.airtable",
                "source_record_id": f"eq.{asset_id}",
            },
            headers=_headers(),
        ),
        _fetch_products_map(owner_type, owner_id),
        _fetch_item_types_map(owner_type, owner_id),
    )
    asset_r.raise_for_status()
    rows = asset_r.json()
    if not rows:
        raise HTTPException(status_code=404, detail="Asset not found")
    return _build_asset_response(rows[0], prod_id_to_name, prod_name_to_id, it_id_to_name)


# ── Name update (write-back to source) ───────────────────────────────────────

class NameUpdate(BaseModel):
    name: str


@router.patch("/{asset_id}/name")
async def update_asset_name(
    asset_id: str, body: NameUpdate, _: CurrentUser = Depends(require_studio)
):
    if not body.name:
        raise HTTPException(status_code=400, detail="name is required")
    await update_records(config.tables["assets"], [{"id": asset_id, "fields": {"Name": body.name}}])
    return {"ok": True}
