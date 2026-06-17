"""Schedule + workflow-definition read tools."""
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from lib.db import db_client, _url, _headers
from lib.scheduler import build_schedule
from mcp_server.context import tool_call


async def get_schedule(asset_id: str) -> dict[str, Any]:
    """The current derived schedule for one asset: its work items with crafts, estimates, and
    start/end dates, plus any scheduling warnings.

    Studio-only (the scheduler derives studio production timelines). `asset_id` is the asset's stable
    id. This is structured schedule data — dependency-ordered work with dates — not a Gantt rendering.
    """
    async with tool_call("paw_v1_get_schedule") as p:
        if p.owner_type != "studio":
            raise ToolError("get_schedule is studio-only; this credential is for a vendor org")
        try:
            return await build_schedule(asset_id, p.owner_id)
        except ToolError:
            raise
        except Exception as exc:  # surface scheduler failures as a clean tool error
            raise ToolError(f"could not build schedule for {asset_id!r}: {exc}")


async def get_workflow_definition() -> dict[str, Any]:
    """The organization's workflow template: the steps (with craft) and their dependency edges.

    Lets you understand what work *should* happen for an asset type — necessary context for reasoning
    about what *has* happened. Each step lists the steps it depends on (its prerequisites).
    """
    async with tool_call("paw_v1_get_workflow_definition") as p:
        sr = await db_client.get(
            _url("/rest/v1/workflow_steps"),
            params={"owner_key": f"eq.{p.owner_id}", "select": "id,name,craft",
                    "order": "name.asc", "limit": "500"},
            headers=_headers(),
        )
        steps = sr.json() if sr.is_success else []
        if not steps:
            return {"steps": [], "count": 0}

        ids = ",".join(s["id"] for s in steps)
        dr = await db_client.get(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"step_id": f"in.({ids})", "select": "step_id,depends_on_step_id", "limit": "2000"},
            headers=_headers(),
        )
        deps: dict[str, list[str]] = {}
        for d in (dr.json() if dr.is_success else []):
            deps.setdefault(d["step_id"], []).append(d["depends_on_step_id"])

        return {"steps": [{"id": s["id"], "name": s.get("name"), "craft": s.get("craft"),
                           "depends_on": deps.get(s["id"], [])} for s in steps],
                "count": len(steps)}
