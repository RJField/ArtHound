"""Product-tier read tools."""
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from lib.db import db_client, _url, _headers
from mcp_server.context import tool_call
from mcp_server.shaping import owner_filter, clean_meta, get_slot


async def list_products(limit: int = 100) -> dict[str, Any]:
    """List the products (projects/titles) in your organization's scope.

    A Product is the top tier of ArtHound's PAW model (Product → Asset → Work) — a game title,
    film, or season that assets belong to. Use this as an entry point to discover what projects
    exist before drilling into assets. Returns lightweight summaries; call get_product for detail.
    """
    async with tool_call("paw_v1_list_products") as p:
        r = await db_client.get(
            _url("/rest/v1/replicated_products"),
            params={**owner_filter(p), "select": "source_record_id,name", "order": "name.asc",
                    "limit": str(min(limit, 500))},
            headers=_headers(),
        )
        rows = r.json() if r.is_success else []
        return {"products": [{"product_id": x["source_record_id"], "name": x.get("name")} for x in rows],
                "count": len(rows)}


async def get_product(product_id: str) -> dict[str, Any]:
    """Full context for one product: its source fields plus the assets that belong to it.

    `product_id` is the product's stable id (the `product_id` returned by list_products). Returns the
    product's fields and a summary of its linked assets (id, name, item_type, status) — the
    "tell me about this project" call.
    """
    async with tool_call("paw_v1_get_product") as p:
        pr = await db_client.get(
            _url("/rest/v1/replicated_products"),
            params={**owner_filter(p), "source_record_id": f"eq.{product_id}",
                    "select": "source_record_id,name,meta", "limit": "1"},
            headers=_headers(),
        )
        prod = (pr.json() if pr.is_success else [None])
        if not prod or prod[0] is None:
            raise ToolError(f"no product {product_id!r} in scope")
        prod = prod[0]

        ar = await db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={**owner_filter(p), "product_source_record_id": f"eq.{product_id}",
                    "select": "source_record_id,name,meta", "order": "name.asc", "limit": "500"},
            headers=_headers(),
        )
        assets = ar.json() if ar.is_success else []
        return {
            "product_id": prod["source_record_id"],
            "name": prod.get("name"),
            "fields": clean_meta(prod.get("meta")),
            "asset_count": len(assets),
            "assets": [{"asset_id": a["source_record_id"], "name": a.get("name"),
                        "item_type": get_slot(a.get("meta"), "item_type"),
                        "status": get_slot(a.get("meta"), "status")} for a in assets],
        }
