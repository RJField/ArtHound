"""Asset-tier read tools. The asset is ArtHound's central entity — most agent reasoning starts here."""
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from lib.db import db_client, _url, _headers
from mcp_server.context import tool_call
from mcp_server.shaping import owner_filter, clean_meta, get_slot, slots

_ASSET_COLS = ("source_record_id,canonical_asset_id,name,product_source_record_id,"
               "asset_number,project_date,meta")


def _summary(a: dict) -> dict:
    return {
        "asset_id": a["source_record_id"],
        "canonical_asset_id": a.get("canonical_asset_id"),
        "name": a.get("name"),
        "item_type": get_slot(a.get("meta"), "item_type"),
        "status": get_slot(a.get("meta"), "status"),
        "priority": get_slot(a.get("meta"), "priority"),
        "product_id": a.get("product_source_record_id"),
    }


async def list_assets(product_id: str | None = None, status: str | None = None,
                      item_type: str | None = None, limit: int = 100) -> dict[str, Any]:
    """List assets in scope, optionally filtered by product, status, or item type.

    An Asset is the discrete creative unit (a character, prop, environment, VFX element) — the middle
    tier of PAW and the stable identity everything else anchors to. `product_id` filters to one
    product; `status`/`item_type` filter on the normalized slot values (case-insensitive). Returns
    summaries with PAW position; call get_asset for the full record.
    """
    async with tool_call("paw_v1_list_assets") as p:
        params = {**owner_filter(p), "select": _ASSET_COLS, "order": "name.asc",
                  "limit": str(min(limit, 500))}
        if product_id:
            params["product_source_record_id"] = f"eq.{product_id}"
        r = await db_client.get(_url("/rest/v1/replicated_assets"), params=params, headers=_headers())
        rows = r.json() if r.is_success else []

        def _match(a: dict) -> bool:
            if status and str(get_slot(a.get("meta"), "status") or "").lower() != status.lower():
                return False
            if item_type and str(get_slot(a.get("meta"), "item_type") or "").lower() != item_type.lower():
                return False
            return True

        out = [_summary(a) for a in rows if _match(a)]
        return {"assets": out, "count": len(out)}


async def get_asset(asset_id: str) -> dict[str, Any]:
    """The full PAW record for one asset: normalized slots, source fields, its product context, and a
    summary of the work attached to it.

    `asset_id` is the asset's stable id (the `asset_id` returned by list_assets / get_product).
    This is the workhorse read — it pre-joins the product name and a work rollup so you can reason
    about the asset's place in production without further calls.
    """
    async with tool_call("paw_v1_get_asset") as p:
        ar = await db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={**owner_filter(p), "source_record_id": f"eq.{asset_id}",
                    "select": _ASSET_COLS, "limit": "1"},
            headers=_headers(),
        )
        rows = ar.json() if ar.is_success else []
        if not rows:
            raise ToolError(f"no asset {asset_id!r} in scope")
        a = rows[0]

        # product context
        product = None
        if a.get("product_source_record_id"):
            pr = await db_client.get(
                _url("/rest/v1/replicated_products"),
                params={**owner_filter(p), "source_record_id": f"eq.{a['product_source_record_id']}",
                        "select": "source_record_id,name", "limit": "1"},
                headers=_headers(),
            )
            pj = pr.json() if pr.is_success else []
            if pj:
                product = {"product_id": pj[0]["source_record_id"], "name": pj[0].get("name")}

        # work rollup (anchored on the canonical asset)
        work = []
        if a.get("canonical_asset_id"):
            wr = await db_client.get(
                _url("/rest/v1/replicated_work"),
                params={**owner_filter(p), "canonical_asset_id": f"eq.{a['canonical_asset_id']}",
                        "select": "id,name,status,estimate", "limit": "200"},
                headers=_headers(),
            )
            work = wr.json() if wr.is_success else []

        return {
            "asset_id": a["source_record_id"],
            "canonical_asset_id": a.get("canonical_asset_id"),
            "name": a.get("name"),
            "asset_number": a.get("asset_number"),
            "project_date": a.get("project_date"),
            "slots": slots(a.get("meta")),
            "product": product,
            "work": {"count": len(work),
                     "items": [{"work_id": w["id"], "name": w.get("name"),
                                "status": w.get("status"), "estimate": w.get("estimate")} for w in work]},
            "fields": clean_meta(a.get("meta")),
        }
