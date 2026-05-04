import asyncio
import json
from datetime import date, timedelta
from typing import Optional

from lib.airtable import select_all, find_record
from lib.db import db_client, _url, _headers
from lib.canonical import get_or_create_canonical_ids
from lib.utils import resolve_name, link_id
import config

DEFAULT_MATRIX_KEY = json.dumps({}, sort_keys=True)  # sentinel for the default estimate row


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


async def _fetch_entity_table_id(studio_id: str, entity_type: str, fallback: str) -> str:
    """Return the studio's Airtable table ID/name for the given entity type,
    falling back to `fallback` if not configured in source_entity_definitions."""
    r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  "eq.studio",
            "owner_id":    f"eq.{studio_id}",
            "source_type": "eq.airtable",
            "entity_type": f"eq.{entity_type}",
            "select":      "table_id,table_name",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if rows:
        return rows[0].get("table_id") or rows[0].get("table_name") or fallback
    return fallback


async def _fetch_asset_table_id(studio_id: str) -> str:
    return await _fetch_entity_table_id(studio_id, "asset", config.tables["assets"])


async def _fetch_slot_field_names(studio_id: str) -> dict[str, str]:
    """Return {arthound_slot: source_field_name} from the studio's field mappings."""
    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  "eq.studio",
            "owner_id":    f"eq.{studio_id}",
            "source_type": "eq.airtable",
            "select":      "mappings",
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


async def build_schedule(
    asset_id: str,
    studio_id: str,
    airtable_token: str,
    airtable_base_id: str,
) -> dict:
    at_kw = {"token": airtable_token, "base_id": airtable_base_id}

    # Item types come from Supabase (already replicated); avoids a hardcoded
    # Airtable table name that may not exist in the studio's base.
    item_type_names, asset_table, template_table, slot_fields = await asyncio.gather(
        _fetch_item_type_names(studio_id),
        _fetch_asset_table_id(studio_id),
        _fetch_entity_table_id(studio_id, "template", config.tables["templates"]),
        _fetch_slot_field_names(studio_id),
    )

    # Resolve actual Airtable field names from slot mappings (studio-specific).
    fn_item_type    = slot_fields.get("item_type",    "Item Type")
    fn_product      = slot_fields.get("product",      "Product")
    fn_priority     = slot_fields.get("priority",     "Priority")
    fn_project_date = slot_fields.get("project_date", "Milestone 4 [Dates]")
    fn_name         = slot_fields.get("name",         "Name")

    asset = await find_record(asset_table, asset_id, **at_kw)
    f = lambda field: asset["fields"].get(field)

    # Build reverse lookup so we can resolve display-name → record ID for
    # studios whose item type field is a single-select/lookup (not a linked record).
    item_type_name_to_id = {v: k for k, v in item_type_names.items()}

    item_type_raw = f(fn_item_type)
    asset_item_id: Optional[str] = None
    asset_item_name: Optional[str] = None

    if isinstance(item_type_raw, list) and item_type_raw:
        first = item_type_raw[0]
        lid = link_id(first)
        if lid and lid.startswith("rec"):
            # Standard linked record — value IS the record ID.
            asset_item_id = lid
            asset_item_name = item_type_names.get(asset_item_id)
        else:
            # Lookup/formula returning display names.
            name = str(first) if isinstance(first, str) else None
            if name:
                asset_item_name = name
                asset_item_id = item_type_name_to_id.get(name)
    elif isinstance(item_type_raw, str) and item_type_raw:
        # Single-select or plain text field.
        asset_item_name = item_type_raw
        asset_item_id = item_type_name_to_id.get(item_type_raw)

    if not asset_item_name and not asset_item_id:
        raise ValueError(
            f"Asset has no Item Type set (field: '{fn_item_type}', value: {item_type_raw!r}). "
            "Re-run the field mapping wizard if the field name has changed, or re-sync to refresh item types."
        )
    # asset_item_id may be None when the studio has no separate item types table
    # (single-select field). Template matching still works correctly in that case
    # because templates with no item type filter match all assets.
    if not asset_item_name:
        asset_item_name = item_type_names.get(asset_item_id, asset_item_id)

    if not f(fn_product):
        raise ValueError(f"Asset is not linked to a product (field: '{fn_product}')")

    strategic_priority = f(fn_priority)  # informational only — not required for scheduling

    milestone4 = f(fn_project_date)
    date_raw = milestone4[0] if isinstance(milestone4, list) else milestone4
    if not date_raw:
        raise ValueError(f"Project date is not set (field: '{fn_project_date}') — cannot schedule backwards")
    project_date = date.fromisoformat(str(date_raw)[:10])

    def resolve_field_value(raw) -> str:
        if raw is None:
            return ""
        if isinstance(raw, list):
            if not raw:
                return ""
            lid = link_id(raw[0])
            if lid and lid in item_type_names:
                return item_type_names[lid]
            name = resolve_name(raw)
            return str(name) if name is not None else ""
        return str(raw)

    # -- Resolve canonical asset ID --
    canonical_map = await get_or_create_canonical_ids([asset_id], studio_id)
    canonical_asset_id = canonical_map.get(asset_id)

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
            params={"studio_id": f"eq.{studio_id}", "select": "id,name,craft,airtable_template_id"},
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
    raw_steps = r_steps.json()
    steps_data: list[dict] = raw_steps if isinstance(raw_steps, list) else []
    # airtable_template_id → supabase step UUID (for Airtable-template path)
    step_lookup: dict = {
        row["airtable_template_id"]: row["id"]
        for row in steps_data
        if row.get("airtable_template_id")
    }
    matrix_lookup: dict = {}  # (step_uuid, variable_values_key) → float
    for row in r_matrix.json():
        key = (row["workflow_step_id"], json.dumps(row["variable_values"], sort_keys=True))
        matrix_lookup[key] = float(row["estimate_days"] or 0)

    asset_var_values = {fn: resolve_field_value(f(fn)) for fn in var_fields}
    variable_values_key = json.dumps(asset_var_values, sort_keys=True)
    estimate_col = " | ".join(asset_var_values[fn] for fn in var_fields)

    asset_team = resolve_field_value(f("Team (from Product)"))

    work_graph: dict = {}
    work_estimates: dict = {}
    work_info: dict = {}

    # ── Try Airtable task-templates table first; fall back to Supabase ──────────
    airtable_templates_ok = False
    templates = []
    templates_str = []
    try:
        templates, templates_str = await asyncio.gather(
            select_all(template_table, **at_kw),
            select_all(template_table, {
                "cellFormat": "string",
                "timeZone": "America/Los_Angeles",
                "userLocale": "en-us",
            }, **at_kw),
        )
        airtable_templates_ok = True
    except Exception:
        pass  # table doesn't exist in this base — use Supabase steps below

    if airtable_templates_ok:
        # cellFormat=string gives craft display names (comma-separated).
        craft_name_by_template = {
            r["id"]: (r["fields"].get("Crafts") or "").split(",")[0].strip()
            for r in templates_str
        }

        for template in templates:
            tf = lambda field, t=template: t["fields"].get(field)
            template_id = template["id"]

            template_item_types = tf("Item Type") or []
            matches_item = (
                not isinstance(template_item_types, list)
                or len(template_item_types) == 0
                or any(link_id(l) == asset_item_id for l in template_item_types)
            )
            if not matches_item:
                continue

            step_id = step_lookup.get(template_id)
            if step_id:
                specific = matrix_lookup.get((step_id, variable_values_key))
                estimate = specific if specific is not None else matrix_lookup.get((step_id, DEFAULT_MATRIX_KEY), 0)
            else:
                estimate = 0
            work_estimates[template_id] = estimate if estimate is not None else 0

            craft_links = tf("Crafts") or []
            cap_craft_ids = (
                [lid for l in craft_links if (lid := link_id(l))]
                if isinstance(craft_links, list)
                else []
            )
            work_info[template_id] = {
                "workName": tf("Task") or "Untitled",
                "craft": craft_name_by_template.get(template_id, ""),
                "capCraftIds": cap_craft_ids,
            }

            followed_by = [lid for l in (tf("Depended upon") or []) if (lid := link_id(l))]
            work_graph[template_id] = followed_by

    else:
        # ── Supabase-native path ─────────────────────────────────────────────
        # workflow_steps + workflow_step_dependencies are the source of truth.
        # Keys are Supabase step UUIDs; capCraftIds is unavailable without
        # the Airtable templates table (written as [] to the generated task).
        step_ids = [row["id"] for row in steps_data]
        deps: list[dict] = []
        if step_ids:
            try:
                r_deps = await db_client.get(
                    _url("/rest/v1/workflow_step_dependencies"),
                    params={
                        "step_id": f"in.({','.join(step_ids)})",
                        "select":  "step_id,depends_on",
                    },
                    headers=_headers(),
                )
                r_deps.raise_for_status()
                raw_deps = r_deps.json()
                deps = raw_deps if isinstance(raw_deps, list) else []
            except Exception:
                deps = []  # no dependency graph — steps will be scheduled independently

        for row in steps_data:
            sid = row["id"]
            specific = matrix_lookup.get((sid, variable_values_key))
            estimate = specific if specific is not None else matrix_lookup.get((sid, DEFAULT_MATRIX_KEY), 0)
            work_estimates[sid] = estimate or 0
            work_info[sid] = {
                "workName":   row["name"],
                "craft":      row.get("craft") or "",
                "capCraftIds": [],
            }
            work_graph[sid] = []  # followers added below

        # Build graph: predecessor → [followers]
        for dep in deps:
            predecessor = dep["depends_on"]
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

    asset_name = resolve_name(f(fn_name)) or asset_id
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
        # In Airtable path, node_id is an Airtable recId; workflowStepId is the UUID.
        # In Supabase path, node_id IS the UUID; templateId is None.
        is_airtable_path = airtable_templates_ok
        work.append(
            {
                "templateId":     node_id if is_airtable_path else None,
                "workflowStepId": step_lookup.get(node_id) if is_airtable_path else node_id,
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
        # Internal fields used by the route to write generated_work snapshots.
        # Not intended for the frontend response.
        "_studioId":       studio_id,
        "_variableValues": asset_var_values,
        "work":            work,
        "warnings":        warnings,
    }
