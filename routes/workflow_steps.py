import csv
import io
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers, _user_headers

router = APIRouter()


class StepBody(BaseModel):
    name: str
    craft: Optional[str] = None
    depends_on: List[str] = []


async def _fetch_steps_with_deps(studio_id: str, jwt: str):
    r = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={
            "studio_id": f"eq.{studio_id}",
            "select": "id,name,craft,step_deps:workflow_step_dependencies!step_id(depends_on_step_id)",
            "order": "created_at.asc",
        },
        headers=_user_headers(jwt),
    )
    rows = r.json()

    steps = [{"id": s["id"], "name": s["name"], "craft": s["craft"]} for s in rows]
    deps = [
        {"step_id": s["id"], "depends_on_step_id": d["depends_on_step_id"]}
        for s in rows
        for d in (s.get("step_deps") or [])
    ]

    return steps, deps


# /csv must be declared before /{step_id} so FastAPI matches it as a literal path
@router.get("/csv")
async def download_csv(user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked")

    steps, deps = await _fetch_steps_with_deps(studio_id, user.token)
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
async def list_steps(user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked")

    steps, deps = await _fetch_steps_with_deps(studio_id, user.token)
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
async def create_step(body: StepBody, user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked")

    r = await db_client.post(
        _url("/rest/v1/workflow_steps"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "studio_id": studio_id,
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
async def update_step(step_id: str, body: StepBody, user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked")

    r = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", "studio_id": f"eq.{studio_id}", "select": "id"},
        headers=_user_headers(user.token),
    )
    if not r.json():
        raise HTTPException(status_code=404, detail="Step not found")

    await db_client.patch(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", "studio_id": f"eq.{studio_id}"},
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


@router.delete("/{step_id}")
async def delete_step(step_id: str, user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked")

    r = await db_client.get(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", "studio_id": f"eq.{studio_id}", "select": "id"},
        headers=_user_headers(user.token),
    )
    if not r.json():
        raise HTTPException(status_code=404, detail="Step not found")

    await db_client.delete(
        _url("/rest/v1/workflow_steps"),
        params={"id": f"eq.{step_id}", "studio_id": f"eq.{studio_id}"},
        headers=_headers(),
    )
    return {"ok": True}
