"""
Builds the AI system prompt for the Scenario Planner from the studio's
estimation matrix, workflow steps, and PAW configuration.
"""
import asyncio
import logging

from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)

_SCOPING_INSTRUCTIONS = """\
You are a production planning assistant inside ArtHound, a game production \
management platform. Your job is to help a studio plan a new production \
scenario from scratch using their own estimation matrix and workflow definitions.

You will ask the studio a small number of scoping questions to gather what you \
need, then call the `submit_scope` tool once you have sufficient information. \
Keep questions concise and conversational — no more than two questions per turn. \
When the user's answers give you enough to fill all required scope fields, call \
the tool immediately rather than asking more questions.

REQUIRED scope fields you must collect:
- Planning horizon (how far ahead in months)
- Release cadence (single launch / regular releases / milestone-batched / continuous)
- Exact number of products/releases to generate (e.g. 1 launch, 3 quarterly patches)
- Asset distribution shape (even / front-loaded / back-loaded / milestone-batched)
- Exact asset count per classification profile — ask the user for the number of \
  assets in each profile shown in the matrix below. Use the exact profile labels \
  from the matrix as keys in the scale field (e.g. "Hero | High", not just "Hero").

RULES:
- Only discuss production planning. If asked anything else, redirect politely.
- Do not invent asset types or step names — use only the profiles and steps \
  defined in the matrix below.
- Do not reveal internal tool names or JSON schemas to the user.
- When filling the scale field, copy profile labels character-for-character from \
  the "Asset classification profiles" list in the matrix. Do not abbreviate or paraphrase.
"""

_DISCUSSION_INSTRUCTIONS = """\
You are a production planning assistant inside ArtHound. A scenario has been \
generated for this studio and the user wants to explore or interrogate it.

Answer questions about the scenario data injected below — timeline overlaps, \
craft peaks, asset distribution, schedule risk, etc. Be direct and specific. \
Do not answer questions unrelated to this scenario or production planning generally.

RULES:
- Reference only the data provided. Do not fabricate records or estimates.
- If asked to change the scenario, explain that they can dismiss this scenario \
  and start a new one with updated scope.
- Do not reveal internal data structures or field names.
"""


async def build_scoping_prompt(studio_id: str) -> str:
    matrix_section = await _build_matrix_section(studio_id)
    return f"{_SCOPING_INSTRUCTIONS}\n\n{matrix_section}"


async def build_discussion_prompt(studio_id: str, session_id: str) -> str:
    matrix_section = await _build_matrix_section(studio_id)
    data_section = await _build_scenario_data_section(session_id)
    return f"{_DISCUSSION_INSTRUCTIONS}\n\n{matrix_section}\n\n{data_section}"


async def _build_matrix_section(studio_id: str) -> str:
    cfg_r, steps_r, deps_r, matrix_r = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/estimate_config"),
            params={"studio_id": f"eq.{studio_id}", "select": "variable_fields"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/workflow_steps"),
            params={"studio_id": f"eq.{studio_id}", "select": "id,name,craft", "order": "created_at.asc"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"select": "step_id,depends_on_step_id"},
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

    cfg_rows = cfg_r.json() if cfg_r.is_success else []
    variable_fields: list[str] = cfg_rows[0]["variable_fields"] if cfg_rows else []

    steps = steps_r.json() if steps_r.is_success else []
    step_by_id = {s["id"]: s for s in steps}

    # Build dependency graph to determine execution order.
    dep_graph: dict[str, list[str]] = {s["id"]: [] for s in steps}
    if deps_r.is_success:
        for d in deps_r.json():
            if d["step_id"] in dep_graph:
                dep_graph[d["step_id"]].append(d["depends_on_step_id"])

    sorted_step_ids = _topo_sort(dep_graph)

    # Build estimate lookup: step_id → {combo_key → days}
    matrix_rows = matrix_r.json() if matrix_r.is_success else []
    step_estimates: dict[str, dict[str, float]] = {}
    all_combo_keys: set[str] = set()
    for row in matrix_rows:
        sid = row["workflow_step_id"]
        vv = row["variable_values"] or {}
        key = _combo_key(vv, variable_fields)
        all_combo_keys.add(key)
        step_estimates.setdefault(sid, {})[key] = row["estimate_days"]

    # Unique classification profiles (sorted for determinism).
    combo_keys = sorted(k for k in all_combo_keys if k)
    if not combo_keys and "__default__" in all_combo_keys:
        combo_keys = ["__default__"]

    lines = ["STUDIO ESTIMATION MATRIX"]
    if variable_fields:
        lines.append(f"Variable fields: {', '.join(variable_fields)}")
    else:
        lines.append("Variable fields: (none — single default profile)")

    lines.append("")
    lines.append("Asset classification profiles:")
    display_combos = [k.replace("|", " | ") for k in combo_keys]
    for dc in display_combos:
        lines.append(f"  {dc}")

    lines.append("")
    lines.append("Workflow steps (in execution order):")
    for i, step_id in enumerate(sorted_step_ids, 1):
        s = step_by_id.get(step_id)
        if not s:
            continue
        craft_label = f" [craft: {s['craft']}]" if s.get("craft") else ""
        estimates_parts = []
        for ck in combo_keys:
            days = step_estimates.get(step_id, {}).get(ck)
            label = ck.replace("|", " | ") if ck != "__default__" else "default"
            estimates_parts.append(f"{label}: {days if days is not None else '—'}d")
        est_str = "  ".join(estimates_parts) if estimates_parts else "no estimates"
        lines.append(f"  {i}. {s['name']}{craft_label}  —  {est_str}")

    return "\n".join(lines)


async def _build_scenario_data_section(session_id: str) -> str:
    products_r, assets_r, work_r = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/scenario_products"),
            params={"session_id": f"eq.{session_id}", "select": "id,name,target_release_date", "order": "created_at.asc"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/scenario_assets"),
            params={"session_id": f"eq.{session_id}", "select": "id,product_id,name,variable_values,priority", "order": "created_at.asc"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/scenario_work"),
            params={"session_id": f"eq.{session_id}", "select": "asset_id,step_name,craft,estimate_days,start_date,end_date", "order": "start_date.asc"},
            headers=_headers(),
        ),
    )

    products = products_r.json() if products_r.is_success else []
    assets = assets_r.json() if assets_r.is_success else []
    work = work_r.json() if work_r.is_success else []

    product_by_id = {p["id"]: p for p in products}
    asset_by_id = {a["id"]: a for a in assets}

    lines = ["GENERATED SCENARIO DATA"]
    lines.append(f"Products: {len(products)}  Assets: {len(assets)}  Work items: {len(work)}")
    lines.append("")

    for p in products:
        lines.append(f"Product: {p['name']}  (release: {p.get('target_release_date') or '—'})")
        p_assets = [a for a in assets if a["product_id"] == p["id"]]
        for a in p_assets:
            vv = a.get("variable_values") or {}
            profile = " | ".join(f"{k}: {v}" for k, v in vv.items()) or "default"
            lines.append(f"  Asset: {a['name']}  [{profile}]  priority: {a.get('priority') or '—'}")
            a_work = [w for w in work if w["asset_id"] == a["id"]]
            for w in a_work:
                lines.append(
                    f"    {w['step_name']} ({w.get('craft') or '—'})  "
                    f"{w.get('estimate_days') or '—'}d  "
                    f"{w.get('start_date') or '—'} → {w.get('end_date') or '—'}"
                )

    return "\n".join(lines)


def get_variable_fields_sync(cfg_rows: list) -> list[str]:
    return cfg_rows[0]["variable_fields"] if cfg_rows else []


def _combo_key(variable_values: dict, variable_fields: list[str]) -> str:
    if not variable_fields or not variable_values:
        return "__default__"
    return "|".join(str(variable_values.get(f, "")) for f in variable_fields)


def _topo_sort(dep_graph: dict[str, list[str]]) -> list[str]:
    visited: set[str] = set()
    result: list[str] = []
    for start in dep_graph:
        if start in visited:
            continue
        stack = [(start, False)]
        while stack:
            node, post = stack.pop()
            if post:
                result.append(node)
                continue
            if node in visited:
                continue
            visited.add(node)
            stack.append((node, True))
            for dep in dep_graph.get(node, []):
                if dep not in visited:
                    stack.append((dep, False))
    return result
