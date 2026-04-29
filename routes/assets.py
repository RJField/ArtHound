import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from lib.airtable import select_all, find_record, update_records
from lib.utils import resolve_name, link_id
import config

router = APIRouter()


async def _fetch_product_names() -> dict:
    records = await select_all(config.tables["products"], {"fields": ["Product"]})
    return {r["id"]: r["fields"].get("Product", r["id"]) for r in records}


async def _fetch_item_type_names() -> dict:
    records = await select_all(config.tables["itemTypes"], {"fields": ["Item"]})
    return {r["id"]: r["fields"].get("Item", r["id"]) for r in records}


def _normalize_asset(r: dict, product_names: dict = {}, item_type_names: dict = {}) -> dict:
    milestone4 = r["fields"].get("Milestone 4 [Dates]")
    product_links = r["fields"].get("Product") or []
    item_links = r["fields"].get("Item Type") or []
    product_id = link_id(product_links[0]) if product_links else None
    item_type_id = link_id(item_links[0]) if item_links else None

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
    }


@router.get("/products")
async def get_products():
    records = await select_all(
        config.tables["products"],
        {"fields": ["Product"], "sort": [{"field": "Product", "direction": "asc"}]},
    )
    return [{"id": r["id"], "name": r["fields"].get("Product", r["id"])} for r in records]


@router.get("/")
async def get_assets(productId: Optional[str] = Query(None)):
    records, product_names, item_type_names = await asyncio.gather(
        select_all(
            config.tables["assets"],
            {
                "fields": [
                    "Name", "ID", "Dev Name", "Product", "Item Type",
                    "Team (from Product)", "Priority", "Milestone 4 [Dates]",
                ],
                "sort": [{"field": "Name", "direction": "asc"}],
            },
        ),
        _fetch_product_names(),
        _fetch_item_type_names(),
    )

    assets = [_normalize_asset(r, product_names, item_type_names) for r in records]
    if productId:
        assets = [a for a in assets if a["productId"] == productId]
    return assets


@router.get("/{asset_id}")
async def get_asset(asset_id: str):
    record, product_names, item_type_names = await asyncio.gather(
        find_record(config.tables["assets"], asset_id),
        _fetch_product_names(),
        _fetch_item_type_names(),
    )
    return _normalize_asset(record, product_names, item_type_names)


class NameUpdate(BaseModel):
    name: str


@router.patch("/{asset_id}/name")
async def update_asset_name(asset_id: str, body: NameUpdate):
    if not body.name:
        raise HTTPException(status_code=400, detail="name is required")
    await update_records(config.tables["assets"], [{"id": asset_id, "fields": {"Name": body.name}}])
    return {"ok": True}
