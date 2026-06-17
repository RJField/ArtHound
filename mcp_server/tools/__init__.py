"""Tool registry — versioned `paw_v1_*` names (the external API contract).

Names use underscores (not dots) for maximum MCP-client compatibility; the `paw_v1_` prefix is the
version namespace. A breaking schema change ships as `paw_v2_*` alongside, never in place.
"""
from mcp_server.tools import products, assets, work, estimates, schedule, timeline, writes

# (function, exported tool name) — descriptions come from each function's docstring.
_TOOLS = [
    # ── reads (Phase 1) ──
    (products.list_products,             "paw_v1_list_products"),
    (products.get_product,               "paw_v1_get_product"),
    (assets.list_assets,                 "paw_v1_list_assets"),
    (assets.get_asset,                   "paw_v1_get_asset"),
    (work.list_work,                     "paw_v1_list_work"),
    (work.get_work,                      "paw_v1_get_work"),
    (estimates.get_estimates,            "paw_v1_get_estimates"),
    (schedule.get_schedule,              "paw_v1_get_schedule"),
    (schedule.get_workflow_definition,   "paw_v1_get_workflow_definition"),
    (timeline.get_asset_timeline,        "paw_v1_get_asset_timeline"),
    # ── lightweight writes (Phase 2) — paper-trail records, no production mutation ──
    (writes.flag_asset_risk,             "paw_v1_flag_asset_risk"),
    (writes.request_human_review,        "paw_v1_request_human_review"),
    (writes.propose_estimate_adjustment, "paw_v1_propose_estimate_adjustment"),
]


def register_all(mcp) -> None:
    for fn, name in _TOOLS:
        mcp.add_tool(fn, name=name)
