import asyncio
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.airtable import update_records
from lib.auth import CurrentUser, get_current_user, require_studio
from lib.db import db_client, _url, _headers, _user_headers
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
        first = v[0]
        if all(isinstance(x, str) and x.startswith("rec") for x in v):
            return None  # bare legacy linked-record IDs — not useful for display
        if isinstance(first, dict):
            if "url" in first:
                return v  # attachments — keep as-is for frontend rendering
            if "source_id" in first:
                # Canonical linked record objects [{source_id, display_name}]
                names = [x.get("display_name") or "" for x in v if isinstance(x, dict)]
                names = [n for n in names if n]
                if names:
                    return ", ".join(names)
                return f"{len(v)} linked record{'s' if len(v) != 1 else ''}"
            # Other dict arrays (e.g. select values) — extract label/name
            labels = [x.get("label") or x.get("name") or x.get("display_name") or "" for x in v if isinstance(x, dict)]
            return ", ".join(l for l in labels if l) or None
        # Plain scalar arrays (strings, numbers from lookups/formulas)
        return ", ".join(str(x) for x in v if x is not None and x != "") or None
    if isinstance(v, dict):
        # Canonical single object (collaborator, select value, etc.)
        return v.get("display_name") or v.get("label") or v.get("name") or v.get("email") or None
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
        # Canonical format: [{source_id, display_name}]; legacy: ["recXXX"]
        for entry in (meta.get("Product") or []):
            pid = entry.get("source_id") if isinstance(entry, dict) else entry
            if pid and pid in product_id_to_name:
                product_name = product_id_to_name[pid]
                product_id   = pid
                break

    # Resolve item type — slot column carries the display name after the sync fix.
    # Fall back to meta for records synced before that fix.
    item_type = row.get("item_type")
    if not item_type:
        for entry in (meta.get("Item Type") or []):
            if isinstance(entry, dict):
                # Canonical: display_name is already resolved; source_id as fallback via ref map
                item_type = entry.get("display_name") or item_type_id_to_name.get(entry.get("source_id", ""))
            elif isinstance(entry, str):
                item_type = item_type_id_to_name.get(entry)
            if item_type:
                break

    # Team from meta (multipleLookupValues returns plain strings; handle canonical dicts too)
    team_raw = meta.get("Team (from Product)")
    if isinstance(team_raw, list):
        parts = []
        for x in team_raw:
            if isinstance(x, dict):
                parts.append(x.get("display_name") or x.get("name") or "")
            elif x:
                parts.append(str(x))
        team = ", ".join(p for p in parts if p) or None
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


async def _fetch_ref_table(owner_type: str, owner_id: str, table: str, jwt: str) -> list[dict]:
    r = await db_client.get(
        _url(f"/rest/v1/{table}"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.airtable",
            "select":      "source_record_id,name",
        },
        headers=_user_headers(jwt),
    )
    r.raise_for_status()
    return r.json()


async def _fetch_products_map(owner_type: str, owner_id: str, jwt: str) -> tuple[dict, dict]:
    rows = await _fetch_ref_table(owner_type, owner_id, "replicated_products", jwt)
    id_to_name = {p["source_record_id"]: p["name"] for p in rows}
    name_to_id = {p["name"]: p["source_record_id"] for p in rows}
    return id_to_name, name_to_id


async def _fetch_item_types_map(owner_type: str, owner_id: str, jwt: str) -> dict:
    rows = await _fetch_ref_table(owner_type, owner_id, "replicated_item_types", jwt)
    return {r["source_record_id"]: r["name"] for r in rows}


# ── Products ──────────────────────────────────────────────────────────────────

@router.get("/products")
async def get_products(user: CurrentUser = Depends(get_current_user)):
    owner_type, owner_id = _owner(user)

    # Derive the product list from the distinct values of the `product` slot
    # across all synced assets. This works for both linked-record setups (where
    # the slot holds a display name or source_id) and flat select-based setups
    # (where the slot holds the select option text). Join with replicated_products
    # to resolve source_ids back to display names where available.
    asset_r, prod_rows = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={
                "owner_type":  f"eq.{owner_type}",
                "owner_id":    f"eq.{owner_id}",
                "source_type": "eq.airtable",
                "select":      "product",
                "product":     "not.is.null",
            },
            headers=_user_headers(user.token),
        ),
        _fetch_ref_table(owner_type, owner_id, "replicated_products", user.token),
    )
    asset_r.raise_for_status()

    prod_name_map = {r["source_record_id"]: r["name"] for r in prod_rows if r.get("name")}

    seen: set[str] = set()
    products = []
    for row in asset_r.json():
        val = row.get("product")
        if not val or val in seen:
            continue
        seen.add(val)
        name = prod_name_map.get(val) or val
        products.append({"id": val, "name": name})

    return sorted(products, key=lambda p: p["name"])


# ── Asset list ────────────────────────────────────────────────────────────────

@router.get("")
@router.get("/")
async def get_assets(
    productId: Optional[str] = Query(None),
    unassigned: bool = Query(False),
    current_user: CurrentUser = Depends(get_current_user),
):
    owner_type, owner_id = _owner(current_user)

    # Fetch reference maps first — needed to resolve the product filter value.
    (prod_id_to_name, prod_name_to_id), it_id_to_name = await asyncio.gather(
        _fetch_products_map(owner_type, owner_id, current_user.token),
        _fetch_item_types_map(owner_type, owner_id, current_user.token),
    )

    asset_params = {
        "owner_type":  f"eq.{owner_type}",
        "owner_id":    f"eq.{owner_id}",
        "source_type": "eq.airtable",
        "order":       "name.asc",
    }

    if unassigned:
        # product column is NULL for assets with no product link.
        asset_params["product"] = "is.null"
    elif productId:
        # The product column stores either the display name or the Airtable
        # source_id (when the product has no display name). Check both.
        target_name = prod_id_to_name.get(productId, "")
        if target_name and target_name != productId:
            # Named product: match by name OR source_id (handles data from
            # before the normalizer fix stored source_id as fallback).
            asset_params["or"] = f"(product.eq.{target_name},product.eq.{productId})"
        else:
            # Blank-named product: the column stores the source_id directly.
            asset_params["product"] = f"eq.{productId}"

    asset_r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params=asset_params,
        headers=_user_headers(current_user.token),
    )
    asset_r.raise_for_status()
    rows = asset_r.json()

    return [_build_asset_response(r, prod_id_to_name, prod_name_to_id, it_id_to_name) for r in rows]


_SLOT_LABELS: dict[str, str] = {
    "name":         "Name",
    "dev_name":     "Dev Name",
    "item_type":    "Item Type",
    "priority":     "Priority",
    "product":      "Product",
    "project_date": "Date",
    "status":       "Status",
    "asset_number": "Asset #",
}

_DEFAULT_VISIBLE_SLOTS: set[str] = {"name", "item_type", "priority"}


# ── View schema (column spec for the asset grid + detail panel) ───────────────

@router.get("/view-schema")
async def get_view_schema(user: CurrentUser = Depends(get_current_user)):
    """Return the studio's column spec: mapped slots then unmapped meta fields."""
    owner_type, owner_id = _owner(user)
    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.airtable",
            "select":      "mappings",
        },
        headers=_user_headers(user.token),
    )
    r.raise_for_status()
    rows     = r.json()
    mappings = rows[0].get("mappings", []) if rows else []

    columns: list[dict] = []
    seen_slots: set[str] = set()

    for m in mappings:
        slot = m.get("arthound_slot")
        if slot and slot in _SLOT_LABELS and slot not in seen_slots:
            seen_slots.add(slot)
            columns.append({
                "id":             f"slot:{slot}",
                "label":          _SLOT_LABELS[slot],
                "source":         "slot",
                "slotKey":        slot,
                "fieldType":      m.get("source_field_type", "singleLineText"),
                "defaultVisible": slot in _DEFAULT_VISIBLE_SLOTS,
            })

    for slot, label in _SLOT_LABELS.items():
        if slot not in seen_slots:
            columns.append({
                "id":             f"slot:{slot}",
                "label":          label,
                "source":         "slot",
                "slotKey":        slot,
                "fieldType":      "singleLineText",
                "defaultVisible": slot in _DEFAULT_VISIBLE_SLOTS,
            })

    for m in mappings:
        if m.get("arthound_slot") is None:
            columns.append({
                "id":             f"meta:{m['source_field_name']}",
                "label":          m["source_field_name"],
                "source":         "meta",
                "fieldName":      m["source_field_name"],
                "fieldType":      m.get("source_field_type", "singleLineText"),
                "defaultVisible": False,
            })

    return {"columns": columns}


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
        headers=_user_headers(user.token),
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
            headers=_user_headers(current_user.token),
        ),
        _fetch_products_map(owner_type, owner_id, current_user.token),
        _fetch_item_types_map(owner_type, owner_id, current_user.token),
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
    asset_id: str, body: NameUpdate, current_user: CurrentUser = Depends(require_studio)
):
    if not body.name:
        raise HTTPException(status_code=400, detail="name is required")
    owner_type, owner_id = _owner(current_user)
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "owner_type":       f"eq.{owner_type}",
            "owner_id":         f"eq.{owner_id}",
            "source_record_id": f"eq.{asset_id}",
            "select":           "source_record_id",
        },
        headers=_user_headers(current_user.token),
    )
    r.raise_for_status()
    if not r.json():
        raise HTTPException(status_code=404, detail="Asset not found")
    await update_records(config.tables["assets"], [{"id": asset_id, "fields": {"Name": body.name}}])
    return {"ok": True}
