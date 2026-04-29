import asyncio
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lib.airtable import create_records
from lib.scheduler import build_schedule
import config

router = APIRouter()


class AssetIdBody(BaseModel):
    assetId: str


class AssetIdsBody(BaseModel):
    assetIds: List[str]


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
