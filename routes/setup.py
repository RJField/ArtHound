import asyncio
import logging
import os
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from lib.airtable import select_all, http_client
from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers, _user_headers
from lib.source_creds import get_studio_airtable_creds
from lib.utils import link_id
import config

router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_entity_table_name(studio_id: str, entity_type: str, fallback: str, jwt: str) -> str:
    """Return the studio-configured table name for entity_type, falling back to fallback."""
    r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  "eq.studio",
            "owner_id":    f"eq.{studio_id}",
            "source_type": "eq.airtable",
            "entity_type": f"eq.{entity_type}",
            "select":      "table_name",
        },
        headers=_user_headers(jwt),
    )
    rows = r.json()
    if rows and rows[0].get("table_name"):
        return rows[0]["table_name"]
    return fallback


async def _get_asset_table_name(studio_id: str, jwt: str) -> str:
    return await _get_entity_table_name(studio_id, "asset", config.tables["assets"], jwt)


async def _get_template_table_name(studio_id: str, jwt: str) -> str:
    return await _get_entity_table_name(studio_id, "template", config.tables["templates"], jwt)



async def fetch_base_schema(token: str, base_id: str) -> list:
    r = await http_client.get(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not r.is_success:
        body = r.json()
        raise ValueError(
            body.get("error", {}).get("message") or f"Schema API returned {r.status_code}"
        )
    return r.json().get("tables", [])



# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/fields")
async def get_fields(current_user: CurrentUser = Depends(require_studio)):
    token, base_id = await get_studio_airtable_creds(current_user.studio_id)
    asset_table_name = await _get_asset_table_name(current_user.studio_id, current_user.token)
    tables = await fetch_base_schema(token, base_id)
    assets_table = next((t for t in tables if t["name"] == asset_table_name), None)
    if not assets_table:
        raise ValueError(f'Assets table "{asset_table_name}" not found')

    eligible_types = {
        "singleSelect", "multipleSelects", "multipleRecordLinks",
        "number", "rating", "lookup", "multipleLookupValues", "rollup",
    }
    fields = [
        {"id": f["id"], "name": f["name"], "type": f["type"]}
        for f in assets_table["fields"]
        if f["type"] in eligible_types
    ]
    return {"fields": fields}


@router.get("/field-values")
async def get_field_values(field: str = Query(...), current_user: CurrentUser = Depends(require_studio)):
    token, base_id = await get_studio_airtable_creds(current_user.studio_id)
    asset_table_name = await _get_asset_table_name(current_user.studio_id, current_user.token)
    tables = await fetch_base_schema(token, base_id)
    assets_table = next((t for t in tables if t["name"] == asset_table_name), None)
    if not assets_table:
        raise ValueError(f'Assets table "{asset_table_name}" not found')

    field_def = next((f for f in assets_table["fields"] if f["name"] == field), None)
    if not field_def:
        raise ValueError(f'Field "{field}" not found')

    values = []
    ftype = field_def["type"]

    if ftype in ("singleSelect", "multipleSelects"):
        values = [
            {"id": c["name"], "name": c["name"]}
            for c in field_def.get("options", {}).get("choices", [])
        ]
    elif ftype == "multipleRecordLinks":
        linked_table_id = field_def.get("options", {}).get("linkedTableId")
        linked_table = next((t for t in tables if t["id"] == linked_table_id), None)
        if not linked_table:
            raise ValueError(f'Linked table not found for field "{field}"')
        primary = linked_table["fields"][0]["name"] if linked_table["fields"] else "Name"
        records = await select_all(linked_table["name"], {"fields": [primary]}, token=token, base_id=base_id)
        values = [{"id": r["id"], "name": r["fields"].get(primary, r["id"])} for r in records]
    else:
        records = await select_all(asset_table_name, {"fields": [field]}, token=token, base_id=base_id)
        seen: dict = {}
        for r in records:
            raw = r["fields"].get(field)
            v = raw[0] if isinstance(raw, list) else raw
            if v is not None:
                seen[str(v)] = v
        values = [
            {"id": k, "name": str(v)}
            for k, v in sorted(seen.items(), key=lambda x: x[1])
        ]

    return {"field": field, "type": ftype, "values": values}


@router.get("/asset-combinations")
async def get_asset_combinations(field: List[str] = Query(default=[]), current_user: CurrentUser = Depends(require_studio)):
    field_names = [f.strip() for f in field if f.strip()]
    if not field_names:
        raise HTTPException(status_code=400, detail="at least one field param required")

    token, base_id = await get_studio_airtable_creds(current_user.studio_id)
    asset_table_name = await _get_asset_table_name(current_user.studio_id, current_user.token)
    tables = await fetch_base_schema(token, base_id)
    assets_table = next((t for t in tables if t["name"] == asset_table_name), None)
    if not assets_table:
        raise ValueError(f'Assets table "{asset_table_name}" not found')

    field_defs = {f["name"]: f for f in assets_table["fields"] if f["name"] in field_names}

    linked_maps: dict = {}
    for name in field_names:
        fd = field_defs.get(name)
        if not fd or fd["type"] != "multipleRecordLinks":
            continue
        linked_table = next(
            (t for t in tables if t["id"] == fd.get("options", {}).get("linkedTableId")), None
        )
        if not linked_table:
            continue
        primary = linked_table["fields"][0]["name"] if linked_table["fields"] else "Name"
        recs = await select_all(linked_table["name"], {"fields": [primary]}, token=token, base_id=base_id)
        linked_maps[name] = {r["id"]: r["fields"].get(primary, r["id"]) for r in recs}

    records = await select_all(asset_table_name, {"fields": field_names}, token=token, base_id=base_id)

    def resolve_value(name: str, raw) -> Optional[str]:
        if raw is None:
            return None
        fd = field_defs.get(name)
        if not fd:
            return str(raw)
        t = fd["type"]
        if t == "singleSelect":
            return raw
        if t == "multipleSelects":
            return (raw[0] if isinstance(raw, list) else raw) if raw else None
        if t == "multipleRecordLinks":
            rid = raw[0] if isinstance(raw, list) else raw
            return linked_maps.get(name, {}).get(rid, rid) if rid else None
        v = raw[0] if isinstance(raw, list) else raw
        return str(v) if v is not None else None

    combo_counts: dict = {}
    for r in records:
        combo: dict = {}
        complete = True
        for name in field_names:
            val = resolve_value(name, r["fields"].get(name))
            if val is None:
                complete = False
                break
            combo[name] = val
        if not complete:
            continue
        key = "\x00".join(combo[f] for f in field_names)
        if key in combo_counts:
            combo_counts[key]["count"] += 1
        else:
            combo_counts[key] = {"values": combo, "count": 1}

    combinations = sorted(
        combo_counts.values(),
        key=lambda x: tuple(x["values"].get(f, "") for f in field_names),
    )
    return {"combinations": combinations}


@router.get("/matrix-table-pg")
async def get_matrix_table_pg(current_user: CurrentUser = Depends(require_studio)):
    studio_id = current_user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this user")

    # Fetch config, steps, dependencies, and matrix rows in parallel
    r_cfg, r_steps, r_matrix = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/estimate_config"),
            params={"studio_id": f"eq.{studio_id}", "select": "variable_fields"},
            headers=_user_headers(current_user.token),
        ),
        db_client.get(
            _url("/rest/v1/workflow_steps"),
            params={"studio_id": f"eq.{studio_id}", "select": "id,name,craft"},
            headers=_user_headers(current_user.token),
        ),
        db_client.get(
            _url("/rest/v1/estimate_matrix"),
            params={
                "studio_id": f"eq.{studio_id}",
                "select": "workflow_step_id,variable_values,estimate_days",
                "limit": "10000",
            },
            headers=_user_headers(current_user.token),
        ),
    )

    cfg_rows = r_cfg.json()
    if not cfg_rows:
        return {"variableFields": [], "combinations": [], "work": [], "attributeFields": []}
    variable_fields = cfg_rows[0]["variable_fields"]

    steps = r_steps.json()
    step_by_id = {s["id"]: s for s in steps}

    # Dependencies (fetch only if steps exist)
    dep_names: dict = {s["id"]: [] for s in steps}
    if steps:
        ids_csv = ",".join(s["id"] for s in steps)
        r_deps = await db_client.get(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"step_id": f"in.({ids_csv})", "select": "step_id,depends_on_step_id"},
            headers=_user_headers(current_user.token),
        )
        dep_graph = {s["id"]: [] for s in steps}
        for d in r_deps.json():
            dep_graph[d["step_id"]].append(d["depends_on_step_id"])
            dep_on = step_by_id.get(d["depends_on_step_id"])
            if dep_on:
                dep_names[d["step_id"]].append(dep_on["name"])
    else:
        dep_graph = {}

    # Topological sort (iterative post-order DFS)
    visited: set = set()
    sorted_ids: list = []
    for start in dep_graph:
        if start in visited:
            continue
        stack = [(start, False)]
        while stack:
            node, post = stack.pop()
            if post:
                sorted_ids.append(node)
                continue
            if node in visited:
                continue
            visited.add(node)
            stack.append((node, True))
            for nxt in dep_graph.get(node, []):
                if nxt not in visited:
                    stack.append((nxt, False))

    # Build step estimates: step_id → {combo_key → days}
    _DEFAULT_COL = "__default__"
    matrix_rows = r_matrix.json()
    step_estimates: dict = {}
    all_combo_keys: set = set()
    for row in matrix_rows:
        sid = row["workflow_step_id"]
        vv = row["variable_values"]
        key = _DEFAULT_COL if not vv else "|".join(str(vv.get(f, "")) for f in variable_fields)
        all_combo_keys.add(key)
        step_estimates.setdefault(sid, {})[key] = row["estimate_days"]

    regular_keys = sorted(k for k in all_combo_keys if k != _DEFAULT_COL)
    combinations = [
        {"key": k, "colName": k, "label": " | ".join(k.split("|"))}
        for k in regular_keys
    ]
    if _DEFAULT_COL in all_combo_keys:
        combinations.append({"key": "Default", "colName": _DEFAULT_COL, "label": "Default"})

    work_steps = []
    for idx, step_id in enumerate(sorted_ids):
        s = step_by_id.get(step_id)
        if not s:
            continue
        linked_values = {}
        if s.get("craft"):
            linked_values["Craft"] = [s["craft"]]
        work_steps.append({
            "id": step_id,
            "step": idx + 1,
            "name": s["name"],
            "linkedValues": linked_values,
            "dependsOn": dep_names.get(step_id, []),
            "estimates": step_estimates.get(step_id, {}),
        })

    attribute_fields = ["Craft"] if any(s.get("craft") for s in steps) else []
    return {
        "variableFields": variable_fields,
        "combinations": combinations,
        "work": work_steps,
        "attributeFields": attribute_fields,
    }


class VariableFieldItem(BaseModel):
    field: str
    type: str


class CreateMatrixBody(BaseModel):
    variables: List[VariableFieldItem]
    combinations: List[dict]
    prefillCol: str = ""
    clearExisting: bool = False


@router.post("/create-matrix-pg")
async def create_matrix_pg(
    body: CreateMatrixBody,
    background_tasks: BackgroundTasks,
    current_user: CurrentUser = Depends(require_studio),
):
    """ArtHound-native estimation matrix stored in Postgres instead of Airtable columns."""
    studio_id = current_user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this user")

    variable_fields = sorted(v.field for v in body.variables)

    # 1. Clear existing matrix rows and Airtable-sourced workflow steps if requested.
    # Manually-added steps (airtable_template_id IS NULL) are preserved.
    if body.clearExisting:
        await db_client.delete(
            _url("/rest/v1/estimate_matrix"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )
        await db_client.delete(
            _url("/rest/v1/workflow_steps"),
            params={
                "studio_id": f"eq.{studio_id}",
                "airtable_template_id": "not.is.null",
            },
            headers=_headers(),
        )

    # 2. Upsert estimate_config for this studio
    await db_client.post(
        _url("/rest/v1/estimate_config"),
        params={"on_conflict": "studio_id"},
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={"studio_id": studio_id, "variable_fields": variable_fields},
    )

    # 3. Optionally import workflow steps from Airtable task templates.
    # If the studio's base has no templates table (or access is denied), skip
    # silently — the user can manage steps manually via the Workflows UI.
    at_token, at_base_id = await get_studio_airtable_creds(studio_id)
    template_table = await _get_template_table_name(studio_id, current_user.token)
    try:
        templates, templates_str = await asyncio.gather(
            select_all(template_table, token=at_token, base_id=at_base_id),
            select_all(template_table, {
                "cellFormat": "string",
                "timeZone": "America/Los_Angeles",
                "userLocale": "en-us",
            }, token=at_token, base_id=at_base_id),
        )
        craft_name_by_template = {
            r["id"]: (r["fields"].get("Crafts") or "").split(",")[0].strip()
            for r in templates_str
        }

        # 4. Upsert workflow_steps from Airtable templates
        step_rows = [
            {
                "studio_id": studio_id,
                "name": t["fields"].get("Task") or "Untitled",
                "craft": craft_name_by_template.get(t["id"], ""),
                "airtable_template_id": t["id"],
            }
            for t in templates
        ]
        r = await db_client.post(
            _url("/rest/v1/workflow_steps"),
            params={"on_conflict": "studio_id,airtable_template_id"},
            headers=_headers({"Prefer": "resolution=merge-duplicates,return=representation"}),
            json=step_rows,
        )
        if not r.is_success:
            raise HTTPException(status_code=500, detail=f"Failed to upsert workflow_steps: {r.text}")

        upserted_steps = r.json()
        template_to_step_id = {row["airtable_template_id"]: row["id"] for row in upserted_steps}

        # 5. Sync workflow_step_dependencies from Airtable "Depends upon" field
        step_ids = [row["id"] for row in upserted_steps]
        if step_ids:
            ids_csv = ",".join(step_ids)
            await db_client.delete(
                _url("/rest/v1/workflow_step_dependencies"),
                params={"step_id": f"in.({ids_csv})"},
                headers=_headers(),
            )
            dep_rows = []
            for t in templates:
                step_id = template_to_step_id.get(t["id"])
                if not step_id:
                    continue
                for l in (t["fields"].get("Depends upon") or []):
                    dep_template_id = link_id(l)
                    if not dep_template_id:
                        continue
                    dep_step_id = template_to_step_id.get(dep_template_id)
                    if dep_step_id:
                        dep_rows.append({"step_id": step_id, "depends_on_step_id": dep_step_id})
            if dep_rows:
                await db_client.post(
                    _url("/rest/v1/workflow_step_dependencies"),
                    params={"on_conflict": "step_id,depends_on_step_id"},
                    headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
                    json=dep_rows,
                )
    except Exception:
        upserted_steps = []

    # 6. Fetch all workflow steps for this studio (includes manually-added ones)
    r_steps = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={"studio_id": f"eq.{studio_id}", "select": "id"},
        headers=_headers(),
    )
    workflow_steps = r_steps.json()

    # 7. Upsert estimate_matrix rows: one per (workflow_step × active combo)
    active_combos = body.combinations
    matrix_rows = []
    for step in workflow_steps:
        step_id = step["id"]
        for combo in active_combos:
            variable_values = {f: combo["values"].get(f, {}).get("name", "") for f in variable_fields}
            matrix_rows.append({
                "studio_id": studio_id,
                "workflow_step_id": step_id,
                "variable_values": variable_values,
                "estimate_days": 0,
            })

    if matrix_rows:
        r = await db_client.post(
            _url("/rest/v1/estimate_matrix"),
            params={"on_conflict": "studio_id,workflow_step_id,variable_values"},
            headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            json=matrix_rows,
        )
        if not r.is_success:
            raise HTTPException(status_code=500, detail=f"Failed to upsert estimate_matrix: {r.text}")

    # Always upsert a Default row (variable_values={}) for every step — used as fallback
    # when no specific combination matches an asset. Existing values are preserved.
    default_rows = [
        {"studio_id": studio_id, "workflow_step_id": step["id"], "variable_values": {}, "estimate_days": 0}
        for step in workflow_steps
    ]
    if default_rows:
        await db_client.post(
            _url("/rest/v1/estimate_matrix"),
            params={"on_conflict": "studio_id,workflow_step_id,variable_values"},
            headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            json=default_rows,
        )

    # 8. Prefill from existing Airtable column if requested
    prefill_pending = False
    if body.prefillCol and upserted_steps:
        prefill_pending = True

        _prefill_template_to_step = {row["airtable_template_id"]: row["id"] for row in upserted_steps}

        async def run_pg_prefill():
            try:
                await asyncio.sleep(1.0)
                # Read Airtable template records with the prefill column value
                records = await select_all(template_table, {"fields": ["Task", body.prefillCol]}, token=at_token, base_id=at_base_id)
                updates = []
                for rec in records:
                    val = rec["fields"].get(body.prefillCol)
                    if val is None:
                        continue
                    step_id = _prefill_template_to_step.get(rec["id"])
                    if not step_id:
                        continue
                    try:
                        days = float(val)
                    except (TypeError, ValueError):
                        continue
                    # Update all matrix rows for this step to the prefill value
                    await db_client.patch(
                        _url("/rest/v1/estimate_matrix"),
                        params={"studio_id": f"eq.{studio_id}", "workflow_step_id": f"eq.{step_id}"},
                        headers=_headers(),
                        json={"estimate_days": days},
                    )
                print(f"[pg-prefill] done, updated {len(records)} steps")
            except Exception as e:
                print(f"[pg-prefill error] {e}")

        background_tasks.add_task(run_pg_prefill)

    return {
        "stepsUpserted": len(upserted_steps),
        "matrixRows": len(matrix_rows),
        "cleared": body.clearExisting,
        "prefillPending": prefill_pending,
    }


