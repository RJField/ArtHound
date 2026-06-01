import asyncio
import logging
import re
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers
from lib.scheduler import build_schedule
from lib.token_refresh import get_jira_token
from lib.sync.connectors.jira import JiraConnector
from lib.sync.connectors.airtable import AirtableConnector
from lib.sync.qualifiers import airtable_write_defaults, airtable_qualifier_gaps, jira_write_defaults
from lib.source_creds import get_studio_airtable_creds

log = logging.getLogger(__name__)

router = APIRouter()


async def _write_work_snapshots(result: dict) -> dict[str, str]:
    """Write generated_work snapshot rows.
    Returns {workflow_step_id: generated_work_id} for source write-back.
    Non-fatal — errors are logged and an empty map is returned.
    """
    canonical_asset_id = result["asset"].get("canonicalAssetId")
    studio_id          = result.get("_studioId")
    variable_values    = result.get("_variableValues", {})
    work_items         = result.get("work", [])

    if not canonical_asset_id or not studio_id or not work_items:
        return {}

    rows = [
        {
            "canonical_asset_id": canonical_asset_id,
            "studio_id":          studio_id,
            "work_name":          item["workName"],
            "workflow_step_id":   item.get("workflowStepId"),
            "craft":              item.get("craft"),
            "estimate_days":      item.get("estimate"),
            "variable_values":    variable_values,
            "start_date":         item.get("startDate"),
            "end_date":           item.get("endDate"),
        }
        for item in work_items
    ]

    try:
        r = await db_client.post(
            _url("/rest/v1/generated_work"),
            json=rows,
            headers=_headers({"Prefer": "return=representation"}),
        )
        if not r.is_success:
            log.warning("generated_work write failed: %s %s", r.status_code, r.text)
            return {}
        return {
            row["workflow_step_id"]: row["id"]
            for row in r.json()
            if row.get("workflow_step_id") and row.get("id")
        }
    except Exception as exc:
        log.warning("generated_work write error: %s", exc)
        return {}


# ── Source write-back helpers ─────────────────────────────────────────────────

async def _get_studio_source_type(studio_id: str) -> str | None:
    # source_credentials is an F-table (deny-all to users); read as the system identity.
    from lib.system_auth import system_identity
    async with system_identity():
        r = await db_client.get(
            _url("/rest/v1/source_credentials"),
            params={"owner_type": "eq.studio", "owner_id": f"eq.{studio_id}",
                    "select": "source_type", "limit": "1"},
            headers=_headers(),
        )
    rows = r.json() if r.is_success else []
    return rows[0]["source_type"] if rows else None


def _to_adf(text: str) -> dict:
    """Wrap plain text in Atlassian Document Format for Jira Cloud v3."""
    content = [
        {"type": "paragraph", "content": [{"type": "text", "text": line or " "}]}
        for line in text.split("\n")
    ]
    return {"version": 1, "type": "doc", "content": content}


def _build_asset_description(asset: dict) -> str:
    pairs = [
        ("Asset",        asset.get("name")),
        ("Type",         asset.get("itemType")),
        ("Team",         asset.get("team")),
        ("Priority",     asset.get("priority")),
        ("Project date", asset.get("projectDate")),
        ("Variables",    asset.get("estimateCol")),
    ]
    return "\n".join(f"{label}: {val}" for label, val in pairs if val)


async def _get_asset_table_id(studio_id: str) -> str | None:
    r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  "eq.studio",
            "owner_id":    f"eq.{studio_id}",
            "entity_type": "eq.asset",
            "select":      "table_id",
            "limit":       "1",
        },
        headers=_headers(),
    )
    rows = r.json() if r.is_success else []
    return rows[0]["table_id"] if rows else None


async def _get_work_entity_def(studio_id: str) -> dict | None:
    r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  "eq.studio",
            "owner_id":    f"eq.{studio_id}",
            "entity_type": "eq.work",
            "select": (
                "table_id,jql_filter,filters,rel_field_id,rel_field_name,"
                "work_name_field_id,work_start_date_field_id,"
                "work_end_date_field_id,work_estimate_field_id"
            ),
            "limit": "1",
        },
        headers=_headers(),
    )
    rows = r.json() if r.is_success else []
    return rows[0] if rows else None


async def _get_asset_jira_key(studio_id: str, source_record_id: str) -> str | None:
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "owner_type":       "eq.studio",
            "owner_id":         f"eq.{studio_id}",
            "source_record_id": f"eq.{source_record_id}",
            "select":           "meta",
            "limit":            "1",
        },
        headers=_headers(),
    )
    rows = r.json() if r.is_success else []
    if not rows:
        return None
    return (rows[0].get("meta") or {}).get("_jira_key")


async def _write_back_to_source(
    result: dict,
    snapshot_map: dict[str, str],
) -> tuple[int, list[str]]:
    """Push generated work items to the studio's source tool.
    Returns (created_count, qualifier_warnings). Non-fatal — errors are logged.
    qualifier_warnings lists any entity filters that could not be auto-injected.
    """
    studio_id  = result["_studioId"]
    work_items = result["work"]

    if not snapshot_map or not work_items:
        return 0, []

    source_type = await _get_studio_source_type(studio_id)
    if source_type not in ("jira", "airtable"):
        return 0, []

    async with httpx.AsyncClient(timeout=30.0) as client:
        if source_type == "jira":
            try:
                jira_creds = await get_jira_token("studio", studio_id, client)
            except RuntimeError as exc:
                log.warning("Jira write-back: cannot get token for studio %s — %s", studio_id, exc)
                return 0, []

            work_def = await _get_work_entity_def(studio_id)
            if not work_def:
                log.warning("Jira write-back: no work entity def for studio %s", studio_id)
                return 0, []

            asset_jira_key = await _get_asset_jira_key(studio_id, result["asset"]["id"])
            if not asset_jira_key:
                log.warning(
                    "Jira write-back: no _jira_key in meta for asset %s — "
                    "re-sync the asset then retry",
                    result["asset"]["id"],
                )
                return 0, []

            connector = JiraConnector(
                access_token=jira_creds["access_token"],
                client=client,
                cloud_id=jira_creds.get("cloud_id"),
                deployment=jira_creds.get("deployment", "cloud"),
                instance_url=jira_creds.get("instance_url"),
            )

            project_key    = work_def.get("table_id")
            # rel_field_id is null in Jira wizard saves; fall back to rel_field_name
            rel_field      = work_def.get("rel_field_id") or work_def.get("rel_field_name")
            start_field_id = work_def.get("work_start_date_field_id")
            end_field_id   = work_def.get("work_end_date_field_id")
            est_field_id   = work_def.get("work_estimate_field_id")

            jira_q_defaults = jira_write_defaults(
                work_def.get("jql_filter"), work_def.get("filters") or []
            )
            issue_type = (jira_q_defaults.get("issuetype") or {}).get("name")
            if not issue_type:
                available = await connector.fetch_project_issue_types(project_key)
                issue_type = available[0] if available else "Task"
                jira_q_defaults = {"issuetype": {"name": issue_type}}
                log.info(
                    "Jira write-back: no issuetype in JQL or filters — using '%s' from project %s (available: %s)",
                    issue_type, project_key, available,
                )

            log.info(
                "Jira write-back: project=%s issuetype=%s rel_field=%s asset=%s",
                project_key, issue_type, rel_field, asset_jira_key,
            )

            source_id_updates: list[dict] = []
            created = 0
            _LINK_TYPE = "Relates"

            _desc_text = _build_asset_description(result["asset"])
            _desc_field = (
                _to_adf(_desc_text)
                if _desc_text and connector._deployment == "cloud"
                else _desc_text or None
            )

            for item in work_items:
                fields: dict = {
                    "project": {"key": project_key},
                    "summary": item["workName"],
                    # issuetype supplied by jira_q_defaults via connector merge
                }
                if _desc_field:
                    fields["description"] = _desc_field

                if start_field_id and item.get("startDate"):
                    fields[start_field_id] = item["startDate"]
                if end_field_id and item.get("endDate"):
                    fields[end_field_id] = item["endDate"]
                if est_field_id and item.get("estimate") is not None:
                    fields[est_field_id] = item["estimate"]

                try:
                    issue_key = await connector.create_issue(fields, jira_q_defaults)
                    created += 1
                    gw_id = snapshot_map.get(item.get("workflowStepId") or "")
                    if gw_id:
                        source_id_updates.append({"id": gw_id, "source_record_id": issue_key})

                    if asset_jira_key:
                        try:
                            await connector.create_issue_link(_LINK_TYPE, asset_jira_key, issue_key)
                        except Exception as link_exc:
                            log.warning(
                                "Jira write-back: issue link failed (%s → %s): %s",
                                asset_jira_key, issue_key, link_exc,
                            )
                except Exception as exc:
                    log.warning(
                        "Jira write-back: create_issue failed for '%s' (project=%s issuetype=%s): %s",
                        item["workName"], project_key, issue_type, exc,
                    )

            if source_id_updates:
                try:
                    await db_client.post(
                        _url("/rest/v1/generated_work?on_conflict=id"),
                        json=source_id_updates,
                        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                    )
                except Exception as exc:
                    log.warning("Jira write-back: source_record_id update failed: %s", exc)

            log.info(
                "Jira write-back: %d/%d issues created for asset %s (studio %s)",
                created, len(work_items), result["asset"]["id"], studio_id,
            )
            return created, []

        else:  # airtable
            try:
                api_token, base_id = await get_studio_airtable_creds(studio_id)
            except Exception as exc:
                log.warning("Airtable write-back: cannot get creds for studio %s — %s", studio_id, exc)
                return 0, []

            work_def = await _get_work_entity_def(studio_id)
            if not work_def:
                log.warning("Airtable write-back: no work entity def for studio %s", studio_id)
                return 0, []

            table_id       = work_def.get("table_id")
            name_field_id  = work_def.get("work_name_field_id")
            start_field_id = work_def.get("work_start_date_field_id")
            end_field_id   = work_def.get("work_end_date_field_id")
            est_field_id   = work_def.get("work_estimate_field_id")
            rel_field_id   = work_def.get("rel_field_id") or work_def.get("rel_field_name")

            if not table_id or not name_field_id:
                log.warning(
                    "Airtable write-back: work entity def missing table_id or name field for studio %s",
                    studio_id,
                )
                return 0, []

            at_q_defaults = airtable_write_defaults(work_def.get("filters") or [])
            at_q_gaps     = airtable_qualifier_gaps(work_def.get("filters") or [], source_tool="Airtable")

            connector = AirtableConnector(api_token=api_token, base_id=base_id, client=client)
            # For Airtable, source_record_id IS the record ID (rec...)
            asset_at_id = result["asset"]["id"]
            desc_text   = _build_asset_description(result["asset"])

            # Resolve the work→asset link field. The entity def may store the asset-side
            # field ID instead of the work-side one, so we validate against the work schema
            # and auto-discover the correct field by linkedTableId if needed.
            # Abort entirely if we can't resolve it — orphaned records are worse than none.
            if rel_field_id:
                try:
                    work_schema   = await connector.fetch_asset_schema(table_id)
                    work_field_map = {f.id: f for f in work_schema}
                    if rel_field_id not in work_field_map:
                        asset_table_id = await _get_asset_table_id(studio_id)
                        discovered = next(
                            (
                                f.id for f in work_schema
                                if f.type == "multipleRecordLinks"
                                and f.options.get("linkedTableId") == asset_table_id
                            ),
                            None,
                        )
                        if discovered:
                            log.info(
                                "Airtable write-back: rel_field_id %s not on work table — "
                                "auto-discovered link field %s via linkedTableId",
                                rel_field_id, discovered,
                            )
                            rel_field_id = discovered
                        else:
                            log.error(
                                "Airtable write-back: rel_field_id %s not found on work table %s "
                                "and no multipleRecordLinks field points to asset table %s — "
                                "aborting to prevent orphaned records",
                                rel_field_id, table_id, asset_table_id,
                            )
                            return 0, at_q_gaps
                except Exception as exc:
                    log.error(
                        "Airtable write-back: schema fetch failed — aborting to prevent orphaned records: %s", exc,
                    )
                    return 0, at_q_gaps

            log.info(
                "Airtable write-back: table=%s name_field=%s rel_field=%s asset=%s",
                table_id, name_field_id, rel_field_id, asset_at_id,
            )

            source_id_updates: list[dict] = []
            created = 0

            for item in work_items:
                # Connector is the sole merge site for qualifier defaults — do not pre-spread.
                fields: dict = {name_field_id: item["workName"]}
                if start_field_id and item.get("startDate"):
                    fields[start_field_id] = item["startDate"]
                if end_field_id and item.get("endDate"):
                    fields[end_field_id] = item["endDate"]
                if est_field_id and item.get("estimate") is not None:
                    fields[est_field_id] = item["estimate"]
                if rel_field_id and asset_at_id:
                    fields[rel_field_id] = [asset_at_id]
                if desc_text and work_def.get("work_notes_field_id"):
                    fields[work_def["work_notes_field_id"]] = desc_text

                try:
                    record_id = await connector.create_record(table_id, fields, at_q_defaults)
                    created += 1
                    gw_id = snapshot_map.get(item.get("workflowStepId") or "")
                    if gw_id:
                        source_id_updates.append({"id": gw_id, "source_record_id": record_id})
                except Exception as exc:
                    log.warning(
                        "Airtable write-back: create_record failed for '%s' (table=%s): %s",
                        item["workName"], table_id, exc,
                    )

            if source_id_updates:
                try:
                    await db_client.post(
                        _url("/rest/v1/generated_work?on_conflict=id"),
                        json=source_id_updates,
                        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                    )
                except Exception as exc:
                    log.warning("Airtable write-back: source_record_id update failed: %s", exc)

            log.info(
                "Airtable write-back: %d/%d records created for asset %s (studio %s)",
                created, len(work_items), result["asset"]["id"], studio_id,
            )
            return created, at_q_gaps


# ── Route models ──────────────────────────────────────────────────────────────

class AssetIdBody(BaseModel):
    assetId: str


class AssetIdsBody(BaseModel):
    assetIds: list[str]


# ── Routes ────────────────────────────────────────────────────────────────────

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


@router.post("/reconcile-work")
async def reconcile_work(user: CurrentUser = Depends(require_studio)):
    """
    Compare active generated_work snapshots against replicated_work.
    Soft-deletes any snapshot rows whose source_record_id no longer exists in the sync layer.
    """
    if not user.studio_id:
        raise HTTPException(status_code=403, detail="No studio linked")

    r = await db_client.get(
        _url("/rest/v1/generated_work"),
        params={
            "studio_id":        f"eq.{user.studio_id}",
            "deleted_at":       "is.null",
            "source_record_id": "not.is.null",
            "select":           "id,source_record_id",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    snapshot_rows = r.json()

    if not snapshot_rows:
        return {"checked": 0, "soft_deleted": 0}

    r_live = await db_client.get(
        _url("/rest/v1/replicated_work"),
        params={
            "owner_type": "eq.studio",
            "owner_id":   f"eq.{user.studio_id}",
            "select":     "source_record_id",
        },
        headers=_headers(),
    )
    r_live.raise_for_status()
    live_ids = {row["source_record_id"] for row in r_live.json() if row.get("source_record_id")}

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
    return await build_schedule(body.assetId, user.studio_id)


@router.post("/generate")
async def generate_schedule(body: AssetIdBody, user: CurrentUser = Depends(require_studio)):
    if not body.assetId:
        raise HTTPException(status_code=400, detail="assetId is required")

    result       = await build_schedule(body.assetId, user.studio_id)
    snapshot_map = await _write_work_snapshots(result)
    source_created, qualifier_warnings = await _write_back_to_source(result, snapshot_map)
    resp = {**result, "created": len(result["work"]), "sourceCreated": source_created}
    if qualifier_warnings:
        resp["qualifierWarnings"] = qualifier_warnings
    return resp


@router.post("/generate-bulk")
async def generate_bulk(body: AssetIdsBody, user: CurrentUser = Depends(require_studio)):
    if not body.assetIds:
        raise HTTPException(status_code=400, detail="assetIds array is required")

    results = await asyncio.gather(
        *[build_schedule(aid, user.studio_id) for aid in body.assetIds],
        return_exceptions=True,
    )

    failed = [
        {"id": body.assetIds[i], "error": str(r)}
        for i, r in enumerate(results)
        if isinstance(r, Exception)
    ]
    all_warnings = [
        w
        for r in results
        if not isinstance(r, Exception)
        for w in r.get("warnings", [])
    ]
    created_count = sum(
        len(r.get("work", []))
        for r in results
        if not isinstance(r, Exception)
    )

    valid_results = [r for r in results if not isinstance(r, Exception)]

    snapshot_maps = await asyncio.gather(
        *[_write_work_snapshots(r) for r in valid_results],
        return_exceptions=True,
    )

    source_results = await asyncio.gather(
        *[
            _write_back_to_source(
                valid_results[i],
                snapshot_maps[i] if not isinstance(snapshot_maps[i], Exception) else {},
            )
            for i in range(len(valid_results))
        ],
        return_exceptions=True,
    )
    source_created = sum(
        r[0] for r in source_results if isinstance(r, tuple)
    )
    qualifier_warnings = list({
        w
        for r in source_results if isinstance(r, tuple)
        for w in r[1]
    })

    return {
        "created":       created_count,
        "sourceCreated": source_created,
        "failed":        failed,
        "warnings":      all_warnings,
        **({"qualifierWarnings": qualifier_warnings} if qualifier_warnings else {}),
    }
