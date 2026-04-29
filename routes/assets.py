import asyncio
import os
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.airtable import select_all, find_record, update_records, http_client
from lib.auth import CurrentUser, require_studio
from lib.utils import resolve_name, link_id
import config

router = APIRouter()


def _is_record_id(s) -> bool:
    return isinstance(s, str) and s.startswith("rec") and len(s) >= 10 and s[3:].isalnum()


def _format_field_value(field_name: str, val):
    if val is None:
        return None
    if isinstance(val, bool):
        return "Yes" if val else "No"
    if isinstance(val, (int, float)):
        if field_name == "Priority":
            return f"P{int(val)}"
        return str(int(val)) if val == int(val) else str(round(val, 4))
    if isinstance(val, str):
        if not val:
            return None
        if len(val) >= 10 and val[4:5] == "-" and val[7:8] == "-":
            try:
                d = date.fromisoformat(val[:10])
                return f"{d.month}/{d.day}/{d.year}"
            except Exception:
                pass
        return val
    if isinstance(val, list):
        if not val:
            return None
        if all(isinstance(v, str) for v in val):
            # Bare linked-record ID arrays — caller resolves these separately
            if all(_is_record_id(v) for v in val):
                return None
            return ", ".join(v for v in val if v) or None
        if all(isinstance(v, dict) for v in val):
            first = val[0]
            extra_keys = set(first.keys()) - {"id", "deleted"}
            if not extra_keys:
                return None
            names = [
                str(v.get("name") or v.get("text") or v.get("value") or v.get("email") or "")
                for v in val
            ]
            return ", ".join(n for n in names if n) or None
        return None
    if isinstance(val, dict):
        n = val.get("name") or val.get("text") or val.get("value") or val.get("email")
        return str(n) if n else None
    return str(val)


async def _fetch_product_names() -> dict:
    records = await select_all(config.tables["products"], {"fields": ["Product"]})
    return {r["id"]: r["fields"].get("Product", r["id"]) for r in records}


async def _fetch_item_type_names() -> dict:
    records = await select_all(config.tables["itemTypes"], {"fields": ["Item"]})
    return {r["id"]: r["fields"].get("Item", r["id"]) for r in records}


async def _fetch_task_names() -> dict:
    records = await select_all(config.tables["tasks"], {"fields": ["Task"]})
    return {r["id"]: r["fields"].get("Task", r["id"]) for r in records}


def _normalize_asset(
    r: dict,
    product_names: dict = {},
    item_type_names: dict = {},
    linked_id_map: dict = {},
) -> dict:
    milestone4 = r["fields"].get("Milestone 4 [Dates]")
    product_links = r["fields"].get("Product") or []
    item_links = r["fields"].get("Item Type") or []
    product_id = link_id(product_links[0]) if product_links else None
    item_type_id = link_id(item_links[0]) if item_links else None

    raw_fields = {}
    for k, v in r["fields"].items():
        formatted = _format_field_value(k, v)
        if formatted is not None:
            raw_fields[k] = formatted
        elif isinstance(v, list) and v and all(_is_record_id(x) for x in v):
            # Linked record IDs — resolve via pre-fetched map when possible
            names = [linked_id_map[x] for x in v if x in linked_id_map]
            if names:
                raw_fields[k] = ", ".join(names)

    return {
        "id": r["id"],
        "assetNumber": r["fields"].get("ID"),
        "name": resolve_name(r["fields"].get("Name")),
        "devName": resolve_name(r["fields"].get("Dev Name")),
        "productId": product_id,
        "product": product_names.get(product_id, product_id) if product_id else None,
        "itemType": item_type_names.get(item_type_id, item_type_id) if item_type_id else None,
        "team": resolve_name(r["fields"].get("Team (from Product)")),
        "priority": r["fields"].get("Priority"),
        "projectDate": (
            (milestone4[0] if isinstance(milestone4, list) else milestone4)
            if milestone4
            else None
        ),
        "rawFields": raw_fields,
    }


@router.get("/products")
async def get_products():
    records = await select_all(
        config.tables["products"],
        {"fields": ["Product"], "sort": [{"field": "Product", "direction": "asc"}]},
    )
    return [{"id": r["id"], "name": r["fields"].get("Product", r["id"])} for r in records]


@router.get("")
@router.get("/")
async def get_assets(productId: Optional[str] = Query(None)):
    records, product_names, item_type_names, task_names = await asyncio.gather(
        select_all(
            config.tables["assets"],
            {"sort": [{"field": "Name", "direction": "asc"}]},
        ),
        _fetch_product_names(),
        _fetch_item_type_names(),
        _fetch_task_names(),
    )
    linked_id_map = {**task_names}

    assets = [_normalize_asset(r, product_names, item_type_names, linked_id_map) for r in records]
    if productId:
        assets = [a for a in assets if a["productId"] == productId]
    return assets


@router.get("/fields")
async def get_asset_fields():
    token = os.environ.get("AIRTABLE_TOKEN", "")
    base_id = os.environ.get("AIRTABLE_BASE_ID", "")
    r = await http_client.get(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not r.is_success:
        raise HTTPException(
            status_code=502,
            detail=f"Airtable metadata API returned {r.status_code}. "
                   "Ensure your token has the 'schema.bases:read' scope.",
        )
    tables = r.json().get("tables", [])
    table = next((t for t in tables if t["name"] == config.tables["assets"]), None)
    if not table:
        raise HTTPException(status_code=404, detail=f"Assets table '{config.tables['assets']}' not found in schema")
    return [{"name": f["name"], "type": f["type"]} for f in table.get("fields", [])]


@router.get("/{asset_id}")
async def get_asset(asset_id: str):
    record, product_names, item_type_names, task_names = await asyncio.gather(
        find_record(config.tables["assets"], asset_id),
        _fetch_product_names(),
        _fetch_item_type_names(),
        _fetch_task_names(),
    )
    return _normalize_asset(record, product_names, item_type_names, {**task_names})


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
