import asyncio
import logging
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.airtable import select_all, create_records, find_record
from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers
from lib.scheduler import build_schedule
from lib.source_creds import get_studio_airtable_creds
import config

log = logging.getLogger(__name__)

router = APIRouter()


async def _write_work_snapshots(result: dict, created: list[dict]) -> None:
    """Write a generated_work snapshot row for each work item created in the source tool.

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
            "work_name":          item["workName"],
            "workflow_step_id":   item.get("workflowStepId"),
            "craft":              item.get("craft"),
            "estimate_days":      item.get("estimate"),
            "variable_values":    variable_values,
            "start_date":         item.get("startDate"),
            "end_date":           item.get("endDate"),
        }
        for item, at_rec in zip(result["work"], created)
    ]

    try:
        r = await db_client.post(
            _url("/rest/v1/generated_work"),
            json=rows,
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if not r.is_success:
            log.warning("generated_work write failed: %s %s", r.status_code, r.text)
    except Exception as exc:
        log.warning("generated_work write error: %s", exc)


class AssetIdBody(BaseModel):
    assetId: str


class AssetIdsBody(BaseModel):
    assetIds: List[str]


@router.get("/work-local")
async def get_asset_work_local(
    canonicalAssetId: str = Query(...),
    user: CurrentUser = Depends(require_studio),
):
    """Return work snapshots from generated_work (ArtHound DB).
    Keyed on canonical_asset_id — source-tool-agnostic."""
    if not user.studio_id:
        return []
    r = await db_client.get(
        _url("/rest/v1/generated_work"),
        params={
            "canonical_asset_id": f"eq.{canonicalAssetId}",
            "studio_id":          f"eq.{user.studio_id}",
            "deleted_at":         "is.null",
            "select":             "id,work_name,craft,estimate_days,start_date,end_date",
            "order":              "start_date.asc",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return [
        {
            "id":        row["id"],
            "work":      row["work_name"],
            "craft":     row.get("craft") or "",
            "estimate":  float(row["estimate_days"]) if row["estimate_days"] is not None else None,
            "startDate": row["start_date"],
            "endDate":   row["end_date"],
        }
        for row in r.json()
    ]


@router.get("/work")
async def get_asset_work(assetId: str = Query(...), assetName: Optional[str] = Query(None), _user: CurrentUser = Depends(require_studio)):
    try:
        token, base_id = await get_studio_airtable_creds(_user.studio_id)
    except HTTPException:
        return []

    entity_r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  "eq.studio",
            "owner_id":    f"eq.{_user.studio_id}",
            "source_type": "eq.airtable",
            "entity_type": "eq.work",
            "select":      "table_id,rel_field_name,"
                           "work_name_field_name,work_estimate_field_name,"
                           "work_start_date_field_name,work_end_date_field_name",
        },
        headers=_headers(),
    )
    entity_rows = entity_r.json()

    if entity_rows:
        # New-system path: use studio's configured field names
        ed = entity_rows[0]
        work_table        = ed["table_id"]
        link_field        = ed.get("rel_field_name")
        name_field        = ed.get("work_name_field_name")
        estimate_field    = ed.get("work_estimate_field_name")
        start_date_field  = ed.get("work_start_date_field_name")
        end_date_field    = ed.get("work_end_date_field_name")

        if not name_field or not link_field:
            # Entity def exists but work field mappings not yet configured
            return []

        if not assetName:
            asset_table = config.tables.get("assets", "Assets")
            rec = await find_record(asset_table, assetId, token=token, base_id=base_id)
            assetName = rec["fields"].get("Name", "")

        escaped = assetName.replace('"', '\\"')
        fields_to_fetch = [f for f in [name_field, estimate_field, start_date_field, end_date_field] if f]
        sort_field = start_date_field or name_field

        records = await select_all(
            work_table,
            {
                "filterByFormula": f'{{{link_field}}} = "{escaped}"',
                "fields": fields_to_fetch,
                "sort": [{"field": sort_field, "direction": "asc"}],
            },
            token=token,
            base_id=base_id,
        )
        return [
            {
                "id":        r["id"],
                "work":      r["fields"].get(name_field, ""),
                "estimate":  r["fields"].get(estimate_field) if estimate_field else None,
                "startDate": r["fields"].get(start_date_field, "") if start_date_field else "",
                "endDate":   r["fields"].get(end_date_field, "") if end_date_field else "",
            }
            for r in records
        ]

    # Legacy path: fixed schema with hardcoded field names (pre-entity-def studios)
    work_table = config.tables.get("work", "Tasks")
    if not assetName:
        asset_table = config.tables.get("assets", "Assets")
        rec = await find_record(asset_table, assetId, token=token, base_id=base_id)
        assetName = rec["fields"].get("Name", "")
    escaped = assetName.replace('"', '\\"')
    records = await select_all(
        work_table,
        {
            "filterByFormula": f'{{Asset}} = "{escaped}"',
            "fields": ["Task", "Estimate", "Start Date", "End Date"],
            "sort": [{"field": "Start Date", "direction": "asc"}],
        },
        token=token,
        base_id=base_id,
    )
    return [
        {
            "id":        r["id"],
            "work":      r["fields"].get("Task", ""),
            "estimate":  r["fields"].get("Estimate"),
            "startDate": r["fields"].get("Start Date", ""),
            "endDate":   r["fields"].get("End Date", ""),
        }
        for r in records
    ]


@router.get("/work/{work_id}")
async def get_work_detail(work_id: str, _user: CurrentUser = Depends(require_studio)):
    record, display_records = await asyncio.gather(
        find_record(config.tables["work"], work_id),
        select_all(
            config.tables["work"],
            {
                "filterByFormula": f'RECORD_ID()="{work_id}"',
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


@router.post("/reconcile-work")
async def reconcile_work(user: CurrentUser = Depends(require_studio)):
    """
    Compare active generated_work snapshots against live Airtable work records.
    Soft-deletes any snapshot rows whose source_record_id no longer exists in Airtable.
    """
    if not user.studio_id:
        raise HTTPException(status_code=403, detail="No studio linked")

    # Fetch active snapshot rows that have an Airtable source reference
    r = await db_client.get(
        _url("/rest/v1/generated_work"),
        params={
            "studio_id":        f"eq.{user.studio_id}",
            "deleted_at":       "is.null",
            "source_type":      "eq.airtable",
            "source_record_id": "not.is.null",
            "select":           "id,source_record_id",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    snapshot_rows = r.json()

    if not snapshot_rows:
        return {"checked": 0, "soft_deleted": 0}

    # Fetch all live work IDs from Airtable (one field only to minimise payload)
    live_records = await select_all(config.tables["work"], {"fields": ["Task"]})
    live_ids = {rec["id"] for rec in live_records}

    # Soft-delete snapshots whose Airtable record no longer exists
    orphaned_ids = [row["id"] for row in snapshot_rows if row["source_record_id"] not in live_ids]

    if orphaned_ids:
        del_r = await db_client.patch(
            _url("/rest/v1/generated_work"),
            params={"id": f"in.({','.join(orphaned_ids)})"},
            json={"deleted_at": datetime.now(timezone.utc).isoformat()},
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if not del_r.is_success:
            raise HTTPException(status_code=500, detail="Soft-delete failed during reconciliation")

    log.info(
        "Work reconciliation: %d checked, %d soft-deleted for studio %s",
        len(snapshot_rows), len(orphaned_ids), user.studio_id,
    )
    return {"checked": len(snapshot_rows), "soft_deleted": len(orphaned_ids)}


@router.post("/preview")
async def preview_schedule(body: AssetIdBody, user: CurrentUser = Depends(require_studio)):
    if not body.assetId:
        raise HTTPException(status_code=400, detail="assetId is required")
    token, base_id = await get_studio_airtable_creds(user.studio_id)
    return await build_schedule(body.assetId, user.studio_id, token, base_id)


@router.post("/generate")
async def generate_schedule(body: AssetIdBody, user: CurrentUser = Depends(require_studio)):
    if not body.assetId:
        raise HTTPException(status_code=400, detail="assetId is required")

    token, base_id = await get_studio_airtable_creds(user.studio_id)
    result = await build_schedule(body.assetId, user.studio_id, token, base_id)

    records = [
        {
            "Asset": [body.assetId],
            "Task": item["workName"],
            "Estimate": item["estimate"],
            "Craft": item["capCraftIds"],
            "Start Date": item["startDate"],
            "End Date": item["endDate"],
        }
        for item in result["work"]
    ]

    created = await create_records(config.tables["work"], records, token=token, base_id=base_id)
    await _write_work_snapshots(result, created)
    return {**result, "created": len(created)}


@router.post("/generate-bulk")
async def generate_bulk(body: AssetIdsBody, user: CurrentUser = Depends(require_studio)):
    if not body.assetIds:
        raise HTTPException(status_code=400, detail="assetIds array is required")

    token, base_id = await get_studio_airtable_creds(user.studio_id)
    results = await asyncio.gather(
        *[build_schedule(aid, user.studio_id, token, base_id) for aid in body.assetIds],
        return_exceptions=True,
    )

    all_records = []
    failed = []

    for i, result in enumerate(results):
        if isinstance(result, Exception):
            failed.append({"id": body.assetIds[i], "error": str(result)})
        else:
            for item in result["work"]:
                all_records.append(
                    {
                        "Asset": [body.assetIds[i]],
                        "Task": item["workName"],
                        "Estimate": item["estimate"],
                        "Craft": item["capCraftIds"],
                        "Start Date": item["startDate"],
                        "End Date": item["endDate"],
                    }
                )

    all_warnings = []
    for result in results:
        if not isinstance(result, Exception):
            all_warnings.extend(result.get("warnings", []))

    created = await create_records(config.tables["work"], all_records, token=token, base_id=base_id) if all_records else []

    # Write snapshots: slice `created` back per result using work item counts as boundaries.
    if created:
        offset = 0
        snapshot_coros = []
        for result in results:
            if isinstance(result, Exception):
                continue
            count = len(result.get("work", []))
            snapshot_coros.append(_write_work_snapshots(result, created[offset:offset + count]))
            offset += count
        await asyncio.gather(*snapshot_coros, return_exceptions=True)

    return {"created": len(created), "failed": failed, "warnings": all_warnings}
