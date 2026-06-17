"""Work-tier read tools. Work = the synced source tasks/deliverables attached to an asset."""
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from lib.db import db_client, _url, _headers
from mcp_server.context import tool_call
from mcp_server.shaping import owner_filter, clean_meta


async def list_work(asset_id: str | None = None, status: str | None = None, limit: int = 100) -> dict[str, Any]:
    """List work records (source tasks/deliverables) in scope, optionally filtered by asset or status.

    Work is the bottom tier of PAW — a modelling pass, review cycle, or vendor delivery attached to an
    asset. `asset_id` filters to the work for one asset (matched on the asset's source record id).
    These are the replicated source-tool work items; call get_work for a single record's full detail.
    """
    async with tool_call("paw_v1_list_work") as p:
        params = {**owner_filter(p),
                  "select": "id,name,status,estimate,canonical_asset_id,source_asset_record_id",
                  "order": "name.asc", "limit": str(min(limit, 500))}
        if asset_id:
            params["source_asset_record_id"] = f"eq.{asset_id}"
        if status:
            params["status"] = f"eq.{status}"
        r = await db_client.get(_url("/rest/v1/replicated_work"), params=params, headers=_headers())
        rows = r.json() if r.is_success else []
        return {"work": [{"work_id": w["id"], "name": w.get("name"), "status": w.get("status"),
                          "estimate": w.get("estimate"),
                          "canonical_asset_id": w.get("canonical_asset_id"),
                          "asset_id": w.get("source_asset_record_id")} for w in rows],
                "count": len(rows)}


async def get_work(work_id: str) -> dict[str, Any]:
    """Full detail for one work record: status, estimate, its asset linkage, and source fields.

    `work_id` is the `work_id` returned by list_work / get_asset. Returns the record's fields plus the
    canonical asset it belongs to (every work item is anchored to a canonical asset).
    """
    async with tool_call("paw_v1_get_work") as p:
        r = await db_client.get(
            _url("/rest/v1/replicated_work"),
            params={**owner_filter(p), "id": f"eq.{work_id}",
                    "select": "id,name,status,estimate,canonical_asset_id,source_asset_record_id,meta",
                    "limit": "1"},
            headers=_headers(),
        )
        rows = r.json() if r.is_success else []
        if not rows:
            raise ToolError(f"no work {work_id!r} in scope")
        w = rows[0]
        return {
            "work_id": w["id"],
            "name": w.get("name"),
            "status": w.get("status"),
            "estimate": w.get("estimate"),
            "asset": {"canonical_asset_id": w.get("canonical_asset_id"),
                      "asset_id": w.get("source_asset_record_id")},
            "fields": clean_meta(w.get("meta")),
        }
