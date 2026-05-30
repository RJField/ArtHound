import csv
import io
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, resolve_owner
from lib.db import db_client, _url, _headers
from lib.workflow_graph import detect_cycle

router = APIRouter()


class StepBody(BaseModel):
    name: str
    craft: str | None = None
    depends_on: list[str] = []


class BulkDeleteBody(BaseModel):
    ids: list[str]


async def _fetch_steps_with_deps(owner_col: str, owner_id: str):
    r = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={
            owner_col: f"eq.{owner_id}",
            "select": "id,name,craft,step_deps:workflow_step_dependencies!step_id(depends_on_step_id)",
            "order": "created_at.asc",
        },
        headers=_headers(),
    )
    rows = r.json()

    steps = [{"id": s["id"], "name": s["name"], "craft": s["craft"]} for s in rows]
    deps = [
        {"step_id": s["id"], "depends_on_step_id": d["depends_on_step_id"]}
        for s in rows
        for d in (s.get("step_deps") or [])
    ]

    return steps, deps


async def _validate_deps(owner_col: str, owner_id: str, depends_on: list[str],
                         *, step_id: str | None = None) -> None:
    """Reject dependency changes that are cross-tenant, self-referential, or would form a cycle.

    The route layer is the authoritative guard (the UI also disables cycle-forming choices). On
    create, step_id is None — a brand-new step has no incoming edges so it cannot close a cycle; we
    still validate that every dependency is one of this owner's own steps.
    """
    if not depends_on:
        return

    steps, deps = await _fetch_steps_with_deps(owner_col, owner_id)
    owned = {s["id"] for s in steps}
    name_by_id = {s["id"]: s["name"] for s in steps}

    missing = [d for d in depends_on if d not in owned]
    if missing:
        raise HTTPException(status_code=400, detail="A selected dependency is not a step in your workflow")

    if step_id is not None and step_id in depends_on:
        raise HTTPException(status_code=400, detail="A step cannot depend on itself")

    if step_id is not None:
        cycle = detect_cycle(steps, deps, step_id=step_id, depends_on=depends_on)
        if cycle:
            chain = " → ".join(name_by_id.get(c, c) for c in cycle)
            raise HTTPException(
                status_code=400,
                detail=f"This change would create a circular dependency: {chain}",
            )


# /csv must be declared before /{step_id} so FastAPI matches it as a literal path
@router.get("/csv")
async def download_csv(user: CurrentUser = Depends(get_current_user)):
    owner_col, owner_id = resolve_owner(user)

    steps, deps = await _fetch_steps_with_deps(owner_col, owner_id)
    step_name = {s["id"]: s["name"] for s in steps}

    output = io.StringIO()
    w = csv.writer(output)

    w.writerow(["=== Workflow Steps ==="])
    w.writerow(["ID", "Name", "Craft"])
    for s in steps:
        w.writerow([s["id"], s["name"], s.get("craft") or ""])
    w.writerow([])

    w.writerow(["=== Dependencies ==="])
    w.writerow(["Step", "Depends On"])
    for d in deps:
        w.writerow([
            step_name.get(d["step_id"], d["step_id"]),
            step_name.get(d["depends_on_step_id"], d["depends_on_step_id"]),
        ])
    w.writerow([])

    crafts = sorted({s.get("craft") or "" for s in steps} - {""})
    w.writerow(["=== Crafts ==="])
    w.writerow(["Craft"])
    for c in crafts:
        w.writerow([c])

    content = output.getvalue().encode("utf-8-sig")
    return StreamingResponse(
        io.BytesIO(content),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=workflow_steps.csv"},
    )


@router.get("")
async def list_steps(user: CurrentUser = Depends(get_current_user)):
    owner_col, owner_id = resolve_owner(user)

    steps, deps = await _fetch_steps_with_deps(owner_col, owner_id)
    step_by_id = {s["id"]: s for s in steps}
    depends_on: dict = {s["id"]: [] for s in steps}
    depended_by: dict = {s["id"]: [] for s in steps}
    for d in deps:
        sid = d["step_id"]
        did = d["depends_on_step_id"]
        if sid in depends_on:
            depends_on[sid].append(did)
        if did in depended_by:
            depended_by[did].append(sid)

    return [
        {
            "id": s["id"],
            "name": s["name"],
            "craft": s.get("craft"),
            "depends_on": [
                {"id": did, "name": step_by_id.get(did, {}).get("name", did)}
                for did in depends_on[s["id"]]
            ],
            "depended_by": [
                {"id": bid, "name": step_by_id.get(bid, {}).get("name", bid)}
                for bid in depended_by[s["id"]]
            ],
        }
        for s in steps
    ]


@router.post("")
async def create_step(body: StepBody, user: CurrentUser = Depends(get_current_user)):
    owner_col, owner_id = resolve_owner(user)

    await _validate_deps(owner_col, owner_id, body.depends_on)

    r = await db_client.post(
        _url("/rest/v1/workflow_steps"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            owner_col: owner_id,
            "name": body.name.strip(),
            "craft": body.craft.strip() if body.craft else None,
        },
    )
    if not r.is_success:
        raise HTTPException(status_code=500, detail="Failed to create step")
    step_id = r.json()[0]["id"]

    if body.depends_on:
        dep_rows = [{"step_id": step_id, "depends_on_step_id": did} for did in body.depends_on]
        await db_client.post(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"on_conflict": "step_id,depends_on_step_id"},
            headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            json=dep_rows,
        )

    return {"id": step_id}


@router.patch("/{step_id}")
async def update_step(step_id: str, body: StepBody, user: CurrentUser = Depends(get_current_user)):
    owner_col, owner_id = resolve_owner(user)

    r = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", owner_col: f"eq.{owner_id}", "select": "id"},
        headers=_headers(),
    )
    if not r.json():
        raise HTTPException(status_code=404, detail="Step not found")

    await _validate_deps(owner_col, owner_id, body.depends_on, step_id=step_id)

    await db_client.patch(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", owner_col: f"eq.{owner_id}"},
        headers=_headers(),
        json={
            "name": body.name.strip(),
            "craft": body.craft.strip() if body.craft else None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
    )

    await db_client.delete(
        _url("/rest/v1/workflow_step_dependencies"),
        params={"step_id": f"eq.{step_id}"},
        headers=_headers(),
    )
    if body.depends_on:
        dep_rows = [{"step_id": step_id, "depends_on_step_id": did} for did in body.depends_on]
        await db_client.post(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"on_conflict": "step_id,depends_on_step_id"},
            headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            json=dep_rows,
        )

    return {"ok": True}


@router.delete("/bulk")
async def bulk_delete_steps(body: BulkDeleteBody, user: CurrentUser = Depends(get_current_user)):
    owner_col, owner_id = resolve_owner(user)
    if not body.ids:
        return {"deleted": 0}

    id_list = ",".join(f'"{i}"' for i in body.ids)
    r = await db_client.delete(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"in.({id_list})", owner_col: f"eq.{owner_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=500, detail=r.text)
    return {"deleted": len(body.ids)}


@router.delete("/{step_id}")
async def delete_step(step_id: str, user: CurrentUser = Depends(get_current_user)):
    owner_col, owner_id = resolve_owner(user)

    r = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", owner_col: f"eq.{owner_id}", "select": "id"},
        headers=_headers(),
    )
    if not r.json():
        raise HTTPException(status_code=404, detail="Step not found")

    r = await db_client.delete(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", owner_col: f"eq.{owner_id}"},
        headers=_headers({"Prefer": "return=minimal"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=500, detail=r.text)
    return {"ok": True}
