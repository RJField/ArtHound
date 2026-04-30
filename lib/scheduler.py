import asyncio
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from lib.airtable import select_all, find_record
from lib.utils import resolve_name, link_id
import config

ESTIMATES_CONFIG_PATH = Path(__file__).parent.parent / "estimates.config.json"


def sanitize(s: str) -> str:
    return "".join(c for c in str(s) if c.isalnum())[:25] or "unknown"


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


async def build_schedule(asset_id: str) -> dict:
    item_type_records = await select_all(config.tables["itemTypes"])
    item_type_names = {r["id"]: r["fields"].get("Item", r["id"]) for r in item_type_records}

    asset = await find_record(config.tables["assets"], asset_id)
    f = lambda field: asset["fields"].get(field)

    item_type_links = f("Item Type") or []
    asset_item_id = link_id(item_type_links[0]) if item_type_links else None
    if not asset_item_id:
        raise ValueError("Asset has no Item Type linked")
    asset_item_name = item_type_names.get(asset_item_id)
    if not asset_item_name:
        raise ValueError(f"Item Type ID {asset_item_id} not found in Item Types table")

    if not f("Product"):
        raise ValueError("Asset is not linked to a product")

    strategic_priority = f("Priority")
    if strategic_priority is None:
        raise ValueError("Priority is not set on the asset")

    milestone4 = f("Milestone 4 [Dates]")
    date_raw = milestone4[0] if isinstance(milestone4, list) else milestone4
    if not date_raw:
        raise ValueError("Milestone 4 date is not set — cannot schedule backwards")
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

    try:
        estimates_config = json.loads(ESTIMATES_CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        estimates_config = {}

    var_fields = sorted(estimates_config.get("_variableFields", []))
    if not var_fields:
        raise ValueError(
            "Variable fields not configured — run the Estimation Engine Setup wizard first (⚙ button)"
        )

    estimate_col = "_".join(sanitize(resolve_field_value(f(fn))) for fn in var_fields)
    asset_team = resolve_field_value(f("Team (from Product)"))

    templates, templates_str = await asyncio.gather(
        select_all(config.tables["templates"]),
        select_all(config.tables["templates"], {
            "cellFormat": "string",
            "timeZone": "America/Los_Angeles",
            "userLocale": "en-us",
        }),
    )
    # cellFormat=string returns linked record values as display names (comma-separated).
    craft_name_by_template = {
        r["id"]: (r["fields"].get("Crafts") or "").split(",")[0].strip()
        for r in templates_str
    }

    task_graph: dict = {}
    task_estimates: dict = {}
    task_info: dict = {}

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

        estimate = tf(estimate_col) if estimate_col else 0
        task_estimates[template_id] = estimate if estimate is not None else 0

        craft_links = tf("Crafts") or []
        cap_craft_ids = (
            [lid for l in craft_links if (lid := link_id(l))]
            if isinstance(craft_links, list)
            else []
        )
        task_info[template_id] = {
            "taskName": tf("Task") or "Untitled",
            "craft": craft_name_by_template.get(template_id, ""),
            "capCraftIds": cap_craft_ids,
        }

        followed_by = [lid for l in (tf("Depended upon") or []) if (lid := link_id(l))]
        task_graph[template_id] = followed_by

    sorted_ids = reverse_topological_sort(task_graph)
    task_dates: dict = {}

    for template_id in sorted_ids:
        followers = task_graph.get(template_id, [])
        estimate = task_estimates.get(template_id, 0)
        end_date = project_date

        if followers:
            follower_starts = [
                task_dates[fid]["startDate"] for fid in followers if fid in task_dates
            ]
            if follower_starts:
                end_date = min(follower_starts)

        start_date = subtract_working_days(end_date, estimate)
        task_dates[template_id] = {"startDate": start_date, "endDate": end_date}

    asset_name = resolve_name(f("Name")) or asset_id
    tasks = []

    for template_id in sorted_ids:
        info = task_info.get(template_id)
        if not info:
            continue
        estimate = task_estimates.get(template_id, 0)
        if not estimate or estimate <= 0:
            continue

        dates = task_dates[template_id]
        tasks.append(
            {
                "templateId": template_id,
                "taskName": f"{info['taskName']} - {asset_name} - {info['craft']}",
                "craft": info["craft"],
                "capCraftIds": info["capCraftIds"],
                "estimate": estimate,
                "startDate": dates["startDate"].isoformat(),
                "endDate": dates["endDate"].isoformat(),
            }
        )

    return {
        "asset": {
            "id": asset_id,
            "name": asset_name,
            "itemType": asset_item_name,
            "team": asset_team,
            "priority": strategic_priority,
            "projectDate": project_date.isoformat(),
            "estimateCol": estimate_col,
        },
        "tasks": tasks,
    }
