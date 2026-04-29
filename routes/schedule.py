import asyncio
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from lib.airtable import select_all, create_records
from lib.scheduler import build_schedule
import config

router = APIRouter()


class AssetIdBody(BaseModel):
    assetId: str


class AssetIdsBody(BaseModel):
    assetIds: List[str]


@router.get("/tasks")
async def get_asset_tasks(assetId: str = Query(...), assetName: Optional[str] = Query(None)):
    # Airtable formulas cannot reference linked record IDs directly — {Asset}
    # returns the primary field value (name). Filter by name when available;
    # fall back to a server-side lookup if the caller didn't supply it.
    if not assetName:
        from lib.airtable import find_record
        rec = await find_record(config.tables["assets"], assetId)
        assetName = rec["fields"].get("Name", "")
    escaped = assetName.replace('"', '\\"')
    records = await select_all(
        config.tables["tasks"],
        {
            "filterByFormula": f'{{Asset}} = "{escaped}"',
            "fields": ["Task", "Estimate", "Start Date", "End Date"],
            "sort": [{"field": "Start Date", "direction": "asc"}],
        },
    )
    return [
        {
            "id": r["id"],
            "task": r["fields"].get("Task", ""),
            "estimate": r["fields"].get("Estimate"),
            "startDate": r["fields"].get("Start Date", ""),
            "endDate": r["fields"].get("End Date", ""),
        }
        for r in records
    ]


@router.post("/preview")
async def preview_schedule(body: AssetIdBody):
    if not body.assetId:
        raise HTTPException(status_code=400, detail="assetId is required")
    return await build_schedule(body.assetId)


@router.post("/generate")
async def generate_schedule(body: AssetIdBody):
    if not body.assetId:
        raise HTTPException(status_code=400, detail="assetId is required")

    result = await build_schedule(body.assetId)

    records = [
        {
            "Asset": [body.assetId],
            "Task": task["taskName"],
            "Estimate": task["estimate"],
            "Craft": task["capCraftIds"],
            "Start Date": task["startDate"],
            "End Date": task["endDate"],
        }
        for task in result["tasks"]
    ]

    created = await create_records(config.tables["tasks"], records)
    return {**result, "created": len(created)}


@router.post("/generate-bulk")
async def generate_bulk(body: AssetIdsBody):
    if not body.assetIds:
        raise HTTPException(status_code=400, detail="assetIds array is required")

    results = await asyncio.gather(
        *[build_schedule(aid) for aid in body.assetIds], return_exceptions=True
    )

    all_records = []
    failed = []

    for i, result in enumerate(results):
        if isinstance(result, Exception):
            failed.append({"id": body.assetIds[i], "error": str(result)})
        else:
            for task in result["tasks"]:
                all_records.append(
                    {
                        "Asset": [body.assetIds[i]],
                        "Task": task["taskName"],
                        "Estimate": task["estimate"],
                        "Craft": task["capCraftIds"],
                        "Start Date": task["startDate"],
                        "End Date": task["endDate"],
                    }
                )

    created = await create_records(config.tables["tasks"], all_records) if all_records else []
    return {"created": len(created), "failed": failed}
