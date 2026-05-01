import asyncio
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.airtable import select_all, create_records, find_record
from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers
from lib.scheduler import build_schedule
import config

log = logging.getLogger(__name__)

router = APIRouter()


async def _write_task_snapshots(result: dict, created: list[dict]) -> None:
    """Write a generated_tasks snapshot row for each task created in the source tool.

    Non-fatal — a Supabase write failure here must never roll back the Airtable
    write, which is the source of truth. Errors are logged and swallowed.
    """
    canonical_asset_id = result["asset"].get("canonicalAssetId")
    studio_id          = result.get("_studioId")
    variable_values    = result.get("_variableValues", {})

    if not canonical_asset_id or not studio_id or not created:
        return

    rows = [
        {
            "canonical_asset_id": canonical_asset_id,
            "studio_id":          studio_id,
            "source_type":        "airtable",
            "source_record_id":   at_rec.get("id"),
            "task_name":          task["taskName"],
            "workflow_step_id":   task.get("workflowStepId"),
            "craft":              task.get("craft"),
            "estimate_days":      task.get("estimate"),
            "variable_values":    variable_values,
            "start_date":         task.get("startDate"),
            "end_date":           task.get("endDate"),
        }
        for task, at_rec in zip(result["tasks"], created)
    ]

    try:
        r = await db_client.post(
            _url("/rest/v1/generated_tasks"),
            json=rows,
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if not r.is_success:
            log.warning("generated_tasks write failed: %s %s", r.status_code, r.text)
    except Exception as exc:
        log.warning("generated_tasks write error: %s", exc)


class AssetIdBody(BaseModel):
    assetId: str


class AssetIdsBody(BaseModel):
    assetIds: List[str]


@router.get("/tasks-local")
async def get_asset_tasks_local(
    canonicalAssetId: str = Query(...),
    user: CurrentUser = Depends(require_studio),
):
    """Return task snapshots from generated_tasks (ArtHound DB).
    Keyed on canonical_asset_id — source-tool-agnostic."""
    if not user.studio_id:
        return []
    r = await db_client.get(
        _url("/rest/v1/generated_tasks"),
        params={
            "canonical_asset_id": f"eq.{canonicalAssetId}",
            "studio_id":          f"eq.{user.studio_id}",
            "deleted_at":         "is.null",
            "select":             "id,task_name,estimate_days,start_date,end_date",
            "order":              "start_date.asc",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return [
        {
            "id":        row["id"],
            "task":      row["task_name"],
            "estimate":  float(row["estimate_days"]) if row["estimate_days"] is not None else None,
            "startDate": row["start_date"],
            "endDate":   row["end_date"],
        }
        for row in r.json()
    ]


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


@router.get("/tasks/{task_id}")
async def get_task_detail(task_id: str):
    record, display_records = await asyncio.gather(
        find_record(config.tables["tasks"], task_id),
        select_all(
            config.tables["tasks"],
            {
                "filterByFormula": f'RECORD_ID()="{task_id}"',
                "cellFormat": "string",
                "timeZone": "America/Los_Angeles",
                "userLocale": "en-us",
            },
        ),
    )
    display_fields = display_records[0]["fields"] if display_records else {}
    return {
        "id": record["id"],
        "fields": record.get("fields", {}),
        "displayFields": display_fields,
    }


@router.post("/preview")
async def preview_schedule(body: AssetIdBody, _: CurrentUser = Depends(require_studio)):
    if not body.assetId:
        raise HTTPException(status_code=400, detail="assetId is required")
    return await build_schedule(body.assetId)


@router.post("/generate")
async def generate_schedule(body: AssetIdBody, _: CurrentUser = Depends(require_studio)):
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
    await _write_task_snapshots(result, created)
    return {**result, "created": len(created)}


@router.post("/generate-bulk")
async def generate_bulk(body: AssetIdsBody, _: CurrentUser = Depends(require_studio)):
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

    all_warnings = []
    for result in results:
        if not isinstance(result, Exception):
            all_warnings.extend(result.get("warnings", []))

    created = await create_records(config.tables["tasks"], all_records) if all_records else []

    # Write snapshots: slice `created` back per result using task counts as boundaries.
    if created:
        offset = 0
        snapshot_coros = []
        for result in results:
            if isinstance(result, Exception):
                continue
            count = len(result.get("tasks", []))
            snapshot_coros.append(_write_task_snapshots(result, created[offset:offset + count]))
            offset += count
        await asyncio.gather(*snapshot_coros, return_exceptions=True)

    return {"created": len(created), "failed": failed, "warnings": all_warnings}
