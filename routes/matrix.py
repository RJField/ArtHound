import asyncio
import logging
import random
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, require_studio, require_admin
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()


@router.get("/matrix-table-pg")
async def get_matrix_table_pg(current_user: CurrentUser = Depends(require_studio)):
    studio_id = current_user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this user")

    r_cfg, r_steps, r_matrix = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/estimate_config"),
            params={"studio_id": f"eq.{studio_id}", "select": "variable_fields"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/workflow_steps"),
            params={"studio_id": f"eq.{studio_id}", "select": "id,name,craft"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/estimate_matrix"),
            params={
                "studio_id": f"eq.{studio_id}",
                "select": "workflow_step_id,variable_values,estimate_days",
                "limit": "10000",
            },
            headers=_headers(),
        ),
    )

    cfg_rows = r_cfg.json()
    if not cfg_rows:
        return {"variableFields": [], "combinations": [], "work": [], "attributeFields": []}
    variable_fields = cfg_rows[0]["variable_fields"]

    steps = r_steps.json()
    step_by_id = {s["id"]: s for s in steps}

    dep_names: dict = {s["id"]: [] for s in steps}
    if steps:
        ids_csv = ",".join(s["id"] for s in steps)
        r_deps = await db_client.get(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"step_id": f"in.({ids_csv})", "select": "step_id,depends_on_step_id"},
            headers=_headers(),
        )
        dep_graph = {s["id"]: [] for s in steps}
        for d in r_deps.json():
            dep_graph[d["step_id"]].append(d["depends_on_step_id"])
            dep_on = step_by_id.get(d["depends_on_step_id"])
            if dep_on:
                dep_names[d["step_id"]].append(dep_on["name"])
    else:
        dep_graph = {}

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


class MatrixCellBody(BaseModel):
    workflow_step_id: str
    variable_values: dict
    estimate_days: float


@router.patch("/matrix-cell")
async def update_matrix_cell(
    body: MatrixCellBody,
    current_user: CurrentUser = Depends(require_studio),
):
    studio_id = current_user.studio_id
    if body.estimate_days < 0:
        raise HTTPException(status_code=422, detail="estimate_days must be >= 0")

    r = await db_client.post(
        _url("/rest/v1/estimate_matrix?on_conflict=studio_id,workflow_step_id,variable_values"),
        json={
            "studio_id":        studio_id,
            "workflow_step_id": body.workflow_step_id,
            "variable_values":  body.variable_values,
            "estimate_days":    body.estimate_days,
        },
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=500, detail=f"Failed to update cell: {r.text}")
    return {"ok": True}


class VariableFieldItem(BaseModel):
    field: str
    type: str


class CreateMatrixBody(BaseModel):
    variables: List[VariableFieldItem]
    combinations: List[dict]
    clearExisting: bool = False
    prefillFromDefault: bool = False


@router.post("/create-matrix-pg")
async def create_matrix_pg(
    body: CreateMatrixBody,
    current_user: CurrentUser = Depends(require_studio),
):
    """ArtHound-native estimation matrix stored in Postgres."""
    studio_id = current_user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this user")

    variable_fields = sorted(v.field for v in body.variables)

    if body.clearExisting:
        await db_client.delete(
            _url("/rest/v1/estimate_matrix"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )

    await db_client.post(
        _url("/rest/v1/estimate_config"),
        params={"on_conflict": "studio_id"},
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={"studio_id": studio_id, "variable_fields": variable_fields},
    )

    r_steps = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={"studio_id": f"eq.{studio_id}", "select": "id"},
        headers=_headers(),
    )
    workflow_steps = r_steps.json()

    # Fetch existing defaults per step if prefill is requested
    default_by_step: dict = {}
    if body.prefillFromDefault:
        r_defaults = await db_client.get(
            _url("/rest/v1/estimate_matrix"),
            params={
                "studio_id": f"eq.{studio_id}",
                "variable_values": "eq.{}",
                "select": "workflow_step_id,estimate_days",
            },
            headers=_headers(),
        )
        for row in r_defaults.json():
            default_by_step[row["workflow_step_id"]] = row["estimate_days"]

    active_combos = body.combinations
    matrix_rows = []
    for step in workflow_steps:
        step_id = step["id"]
        seed = default_by_step.get(step_id, 0) if body.prefillFromDefault else 0
        for combo in active_combos:
            variable_values = {f: combo["values"].get(f, {}).get("name", "") for f in variable_fields}
            matrix_rows.append({
                "studio_id": studio_id,
                "workflow_step_id": step_id,
                "variable_values": variable_values,
                "estimate_days": seed,
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

    return {
        "stepsUpserted": 0,
        "matrixRows": len(matrix_rows),
        "cleared": body.clearExisting,
    }


@router.post("/randomize-matrix")
async def randomize_matrix(current_user: CurrentUser = Depends(require_studio)):
    """Admin-only: overwrite every existing matrix cell with a random value between 5 and 25."""
    require_admin(current_user)
    studio_id = current_user.studio_id

    r = await db_client.get(
        _url("/rest/v1/estimate_matrix"),
        params={
            "studio_id": f"eq.{studio_id}",
            "select": "workflow_step_id,variable_values",
            "limit": "10000",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        return {"updated": 0}

    updates = [
        {
            "studio_id": studio_id,
            "workflow_step_id": row["workflow_step_id"],
            "variable_values": row["variable_values"],
            "estimate_days": random.randint(5, 25),
        }
        for row in rows
    ]

    await db_client.post(
        _url("/rest/v1/estimate_matrix"),
        params={"on_conflict": "studio_id,workflow_step_id,variable_values"},
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json=updates,
    )
    return {"updated": len(updates)}
