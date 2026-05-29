"""
Effective estimate-matrix resolution (vendor-estimate-share plan §4.3).

A vendor's *effective* matrix for a studio link = base rows (link_id IS NULL) overlaid with that
link's override rows (link_id = L), the override winning per (workflow_step_id, variable_values).
For a studio owner — or a vendor with no link selected — this is simply the base matrix.

This is the single source of truth for base⊕override resolution, reused by the matrix editor view
(routes/matrix.py) and, in Phase 2, the share projector.
"""
import json

from lib.db import db_client, _url, _headers


def vv_key(vv: dict | None) -> str:
    """Stable key for a variable_values payload (order-independent)."""
    return json.dumps(vv or {}, sort_keys=True)


async def _fetch_cells(owner_col: str, owner_id: str, link_filter: str) -> list[dict]:
    r = await db_client.get(
        _url("/rest/v1/estimate_matrix"),
        params={
            owner_col:  f"eq.{owner_id}",
            "link_id":  link_filter,
            "select":   "workflow_step_id,variable_values,estimate_days",
            "limit":    "10000",
        },
        headers=_headers(),
    )
    return r.json()


async def resolve_effective_matrix(
    owner_col: str, owner_id: str, link_id: str | None = None
) -> list[dict]:
    """
    Return effective matrix cells:
        [{workflow_step_id, variable_values, estimate_days, source}]
    where source is 'override' when the value comes from a link override, else 'base'.

    Caller is responsible for validating that link_id belongs to the owner (vendor-only).
    """
    base_rows = await _fetch_cells(owner_col, owner_id, "is.null")

    if not link_id:
        return [{**r, "source": "base"} for r in base_rows]

    override_rows = await _fetch_cells(owner_col, owner_id, f"eq.{link_id}")
    overrides = {
        (o["workflow_step_id"], vv_key(o["variable_values"])): o["estimate_days"]
        for o in override_rows
    }

    effective: list[dict] = []
    seen: set = set()
    for b in base_rows:
        k = (b["workflow_step_id"], vv_key(b["variable_values"]))
        seen.add(k)
        if k in overrides:
            effective.append({**b, "estimate_days": overrides[k], "source": "override"})
        else:
            effective.append({**b, "source": "base"})

    # Overrides that have no base counterpart still contribute their value.
    for o in override_rows:
        k = (o["workflow_step_id"], vv_key(o["variable_values"]))
        if k not in seen:
            effective.append({**o, "source": "override"})

    return effective
