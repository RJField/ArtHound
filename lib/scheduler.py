import asyncio
import json
import logging
from datetime import date, timedelta
from typing import Optional

log = logging.getLogger(__name__)

from lib.db import db_client, _url, _headers
from lib.utils import resolve_name, link_id

DEFAULT_MATRIX_KEY = json.dumps({}, sort_keys=True)  # sentinel for the default estimate row

# ArtHound standard slots recognised on replicated_assets.
_STANDARD_SLOTS = frozenset({
    "name", "dev_name", "item_type", "priority", "product",
    "project_date", "status", "asset_number",
})

# Slots demoted from named columns to meta["__slots"] (mirror of
# lib/sync/normalizer._DEMOTED_SLOTS). Read from __slots first; the column
# fallback is for rows not yet re-synced/back-filled and is dead after Phase E.
_DEMOTED_SLOTS = frozenset({"dev_name", "item_type", "priority", "status", "team"})


def subtract_working_days(d: date, days: int) -> date:
    result = d
    remaining = days
    while remaining > 0:
        result -= timedelta(days=1)
        if result.weekday() < 5:  # Mon=0 … Fri=4
            remaining -= 1
    return result


def reverse_topological_sort(graph: dict) -> list:
    """Iterative post-order DFS — equivalent to the recursive JS version."""
    visited: set = set()
    sorted_nodes: list = []

    for start in graph:
        if start in visited:
            continue
        stack = [(start, False)]
        while stack:
            node, post = stack.pop()
            if post:
                sorted_nodes.append(node)
                continue
            if node in visited:
                continue
            visited.add(node)
            stack.append((node, True))
            for nxt in graph.get(node, []):
                if nxt in graph and nxt not in visited:
                    stack.append((nxt, False))

    return sorted_nodes


async def _fetch_item_type_names(studio_id: str) -> dict[str, str]:
    """Read item types from replicated_item_types (Supabase) keyed by source_record_id."""
    r = await db_client.get(
        _url("/rest/v1/replicated_item_types"),
        params={
            "owner_type": "eq.studio",
            "owner_id":   f"eq.{studio_id}",
            "select":     "source_record_id,name",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return {row["source_record_id"]: row["name"] for row in r.json()}


async def _fetch_slot_field_names(studio_id: str) -> dict[str, str]:
    """Return {arthound_slot: source_field_name} from the studio's field mappings."""
    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type": "eq.studio",
            "owner_id":   f"eq.{studio_id}",
            "select":     "mappings",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return {}
    mappings = rows[0].get("mappings") or []
    return {
        m["arthound_slot"]: m["source_field_name"]
        for m in mappings
        if m.get("arthound_slot") and m.get("source_field_name")
    }


async def build_schedule(asset_id: str, studio_id: str) -> dict:
    item_type_names, slot_fields = await asyncio.gather(
        _fetch_item_type_names(studio_id),
        _fetch_slot_field_names(studio_id),
    )

    # Fetch asset from replicated_assets. No explicit select: the demoted slots
    # (item_type, priority, …) live in meta["__slots"] and the named columns are
    # dropped by the slot-demotion migration. Fetching all columns keeps the
    # column fallback working pre-migration without 400-ing post-drop.
    r_asset = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "owner_type":       "eq.studio",
            "owner_id":         f"eq.{studio_id}",
            "source_record_id": f"eq.{asset_id}",
        },
        headers=_headers(),
    )
    r_asset.raise_for_status()
    asset_rows = r_asset.json()
    if not asset_rows:
        raise ValueError(
            f"Asset '{asset_id}' not found in replicated_assets for studio {studio_id}. "
            "Run a sync first or verify the asset ID."
        )

    asset_row = asset_rows[0]
    meta: dict = asset_row.get("meta") or {}
    _aslots: dict = meta.get("__slots") or {}
    canonical_asset_id: Optional[str] = asset_row.get("canonical_asset_id")

    def _slot_val(slot):
        """Read an ArtHound slot value. Demoted slots live in meta['__slots'];
        the column fallback covers rows not yet re-synced/back-filled (dead post-Phase E)."""
        if slot in _DEMOTED_SLOTS:
            return _aslots.get(slot) or asset_row.get(slot)
        return asset_row.get(slot)

    # Invert slot_fields so we can look up slot from source field name.
    _fn_to_slot = {v: k for k, v in slot_fields.items()}

    def f(source_field_name):
        """Return asset value for a source field name.
        Checks normalized slots first (column or __slots), then falls back to meta."""
        if not source_field_name:
            return None
        slot = _fn_to_slot.get(source_field_name)
        if slot in _STANDARD_SLOTS:
            return _slot_val(slot)
        return meta.get(source_field_name)

    # item_type is already the display name string (normalised by the sync layer).
    asset_item_name: Optional[str] = _slot_val("item_type") or None
    item_type_name_to_id = {v: k for k, v in item_type_names.items()}
    asset_item_id: Optional[str] = item_type_name_to_id.get(asset_item_name) if asset_item_name else None

    if not asset_item_name:
        fn_it = slot_fields.get("item_type", "<unmapped>")
        raise ValueError(
            f"Asset has no Item Type set (mapped source field: '{fn_it}'). "
            "Re-run the field mapping wizard or re-sync to refresh item types."
        )

    if not asset_row.get("product"):
        fn_prod = slot_fields.get("product", "<unmapped>")
        raise ValueError(f"Asset is not linked to a product (mapped source field: '{fn_prod}')")

    strategic_priority = _slot_val("priority")

    date_raw = asset_row.get("project_date")
    if not date_raw:
        fn_pd = slot_fields.get("project_date", "<unmapped>")
        raise ValueError(
            f"Project date is not set (mapped source field: '{fn_pd}') — cannot schedule backwards"
        )
    project_date = date.fromisoformat(str(date_raw)[:10])

    _DISPLAY_KEYS = ("name", "label", "displayName", "value", "title")

    def resolve_field_value(raw) -> str:
        if raw is None:
            return ""
        if isinstance(raw, list):
            if not raw:
                return ""
            first = raw[0]
            if isinstance(first, dict):
                for key in _DISPLAY_KEYS:
                    if first.get(key):
                        return str(first[key])
                return ""
            lid = link_id(first)
            if lid and lid in item_type_names:
                return item_type_names[lid]
            name = resolve_name(raw)
            return str(name) if name is not None else ""
        if isinstance(raw, dict):
            for key in _DISPLAY_KEYS:
                if raw.get(key):
                    return str(raw[key])
            return ""
        return str(raw)

    fn_team = slot_fields.get("team")
    asset_team = resolve_field_value(meta.get(fn_team)) if fn_team else ""

    # -- Load estimates from ArtHound Matrix (Postgres) --
    r_cfg = await db_client.get(
        _url("/rest/v1/estimate_config"),
        params={"studio_id": f"eq.{studio_id}", "select": "variable_fields"},
        headers=_headers(),
    )
    cfg_rows = r_cfg.json()
    if not cfg_rows:
        raise ValueError(
            "ArtHound Matrix not configured — run the ArtHound Matrix Setup wizard first"
        )

    var_fields = cfg_rows[0]["variable_fields"]
    r_steps, r_matrix = await asyncio.gather(
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
    steps_data: list[dict] = r_steps.json() if isinstance(r_steps.json(), list) else []
    matrix_lookup: dict = {}
    for row in r_matrix.json():
        key = (row["workflow_step_id"], json.dumps(row["variable_values"], sort_keys=True))
        matrix_lookup[key] = float(row["estimate_days"] or 0)

    # Variable fields: use f() to resolve from slot columns or meta.
    asset_var_values = {fn: resolve_field_value(f(fn)) for fn in var_fields}
    variable_values_key = json.dumps(asset_var_values, sort_keys=True)
    estimate_col = " | ".join(asset_var_values[fn] for fn in var_fields)

    work_graph: dict = {}
    work_estimates: dict = {}
    work_info: dict = {}

    # Build dependency graph from workflow_step_dependencies.
    step_ids = [row["id"] for row in steps_data]
    deps: list[dict] = []
    if step_ids:
        try:
            r_deps = await db_client.get(
                _url("/rest/v1/workflow_step_dependencies"),
                params={
                    "step_id": f"in.({','.join(step_ids)})",
                    "select":  "step_id,depends_on_step_id",
                },
                headers=_headers(),
            )
            r_deps.raise_for_status()
            raw_deps = r_deps.json()
            deps = raw_deps if isinstance(raw_deps, list) else []
        except Exception:
            deps = []

    for row in steps_data:
        sid = row["id"]
        specific = matrix_lookup.get((sid, variable_values_key))
        estimate = specific if specific is not None else matrix_lookup.get((sid, DEFAULT_MATRIX_KEY), 0)
        work_estimates[sid] = estimate or 0
        work_info[sid] = {
            "workName":    row["name"],
            "craft":       row.get("craft") or "",
            "capCraftIds": [],
        }
        work_graph[sid] = []

    # Build graph: predecessor → [followers]
    for dep in deps:
        predecessor = dep["depends_on_step_id"]
        follower    = dep["step_id"]
        if predecessor in work_graph:
            work_graph[predecessor].append(follower)

    sorted_ids = reverse_topological_sort(work_graph)
    work_dates: dict = {}

    for node_id in sorted_ids:
        followers = work_graph.get(node_id, [])
        estimate = work_estimates.get(node_id, 0)
        end_date = project_date

        if followers:
            follower_starts = [
                work_dates[fid]["startDate"] for fid in followers if fid in work_dates
            ]
            if follower_starts:
                end_date = min(follower_starts)

        start_date = subtract_working_days(end_date, estimate)
        work_dates[node_id] = {"startDate": start_date, "endDate": end_date}

    asset_name = asset_row.get("name") or asset_id
    work = []
    warnings = []

    for node_id in sorted_ids:
        info = work_info.get(node_id)
        if not info:
            continue
        estimate = work_estimates.get(node_id, 0)
        if not estimate or estimate <= 0:
            warnings.append(
                f"'{info['workName']}' skipped — no estimate found for [{estimate_col}] "
                f"and no Default set"
            )
            continue

        dates = work_dates[node_id]
        work.append(
            {
                "templateId":     None,
                "workflowStepId": node_id,
                "workName":       f"{info['workName']} - {asset_name} - {info['craft']}",
                "craft":          info["craft"],
                "capCraftIds":    info["capCraftIds"],
                "estimate":       estimate,
                "startDate":      dates["startDate"].isoformat(),
                "endDate":        dates["endDate"].isoformat(),
            }
        )

    return {
        "asset": {
            "id":               asset_id,
            "canonicalAssetId": canonical_asset_id,
            "name":             asset_name,
            "itemType":         asset_item_name,
            "team":             asset_team,
            "priority":         strategic_priority,
            "projectDate":      project_date.isoformat(),
            "estimateCol":      estimate_col,
        },
        "_studioId":       studio_id,
        "_variableValues": asset_var_values,
        "work":            work,
        "warnings":        warnings,
    }
