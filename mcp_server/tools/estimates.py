"""Estimation read tool — the effective estimate matrix for the org (read-only)."""
from typing import Any

from lib.db import db_client, _url, _headers
from lib.estimate.effective import resolve_effective_matrix
from mcp_server.context import tool_call


async def get_estimates(link_id: str | None = None) -> dict[str, Any]:
    """The organization's effective estimation matrix: per workflow-step, per variable-combination,
    the estimated days.

    Read-only — agents propose changes via a separate surface, never mutate the matrix here. For a
    vendor, pass `link_id` to see the per-link override values layered over the base rates (omit it for
    the base matrix). Returns the driving variable fields, the workflow-step names, and the matrix cells
    (each tagged source='base' or 'override').
    """
    async with tool_call("paw_v1_get_estimates") as p:
        owner_col = "studio_id" if p.owner_type == "studio" else "vendor_id"
        matrix = await resolve_effective_matrix(owner_col, p.owner_id, link_id)

        cfg = await db_client.get(
            _url("/rest/v1/estimate_config"),
            params={"owner_key": f"eq.{p.owner_id}", "select": "variable_fields", "limit": "1"},
            headers=_headers(),
        )
        cfg_rows = cfg.json() if cfg.is_success else []
        variable_fields = (cfg_rows[0].get("variable_fields") if cfg_rows else []) or []

        sr = await db_client.get(
            _url("/rest/v1/workflow_steps"),
            params={"owner_key": f"eq.{p.owner_id}", "select": "id,name,craft", "limit": "500"},
            headers=_headers(),
        )
        steps = {s["id"]: {"name": s.get("name"), "craft": s.get("craft")}
                 for s in (sr.json() if sr.is_success else [])}

        cells = [{
            "workflow_step_id": c["workflow_step_id"],
            "step_name": steps.get(c["workflow_step_id"], {}).get("name"),
            "craft": steps.get(c["workflow_step_id"], {}).get("craft"),
            "variable_values": c.get("variable_values"),
            "estimate_days": c.get("estimate_days"),
            "source": c.get("source"),
        } for c in matrix]

        return {"variable_fields": variable_fields, "steps": steps, "matrix": cells, "count": len(cells)}
