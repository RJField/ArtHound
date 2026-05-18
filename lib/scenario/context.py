"""
Builds the AI system prompt for the Scenario Planner from the studio's
estimation matrix, workflow steps, and PAW configuration.
"""
import asyncio
import logging

from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)

_SCOPING_COMMON_RULES = """\
RULES:
- Only discuss production planning. If asked anything else, redirect politely.
- No more than two questions per turn. Call submit_scope as soon as you have \
  enough information — do not keep asking.
- Do not invent asset types or step names — use only the profiles and steps \
  defined in the matrix below.
- Do not reveal internal tool names or JSON schemas to the user.
- When filling the scale field, copy profile labels character-for-character from \
  the "Asset classification profiles" list in the matrix (e.g. "Hero | High").
- If the user mentions team size or capacity limits, capture craft_caps: per-craft \
  maximum number of simultaneously active assets (e.g. {"2D": 3, "3D": 2}).
"""

_SCOPING_INSTRUCTIONS_EARLIEST_SHIP = """\
You are a production planning assistant inside ArtHound. \
The studio has chosen the EARLIEST SHIP DATE scenario mode: \
given their asset scale and constraints, the system will schedule all work \
forward from today and compute the earliest date everything can ship.

Your job is to collect the asset scale and release structure, then call \
submit_scope. Do NOT ask for a target date or planning horizon — the engine \
derives those from the work itself.

REQUIRED fields to collect:
- Exact asset count per classification profile (scale). Use exact profile labels \
  from the matrix as keys (e.g. "Hero | High").
- Release structure: release cadence + number of products (e.g. 3 milestones, \
  1 single launch, etc.)
- Asset distribution across products (even / front-loaded / back-loaded / \
  milestone-batched)

In your submit_scope call set scenario_category to "earliest_ship". \
Set horizon_months to 24 as a planning buffer (the engine ignores this for scheduling).
"""

_SCOPING_INSTRUCTIONS_TARGET_DATE = """\
You are a production planning assistant inside ArtHound. \
The studio has chosen the TARGET DATE scenario mode: \
given a desired ship date, the system builds a backwards-scheduled plan that \
fits that date — and flags any step chains that cannot complete in time.

Your job is to collect the target date, asset scale, and release structure, \
then call submit_scope.

REQUIRED fields to collect:
- target_date: the desired ship date for the FINAL product (ask for a specific \
  date, e.g. "December 31, 2026"). Convert to YYYY-MM-DD in your tool call.
- Exact asset count per classification profile (scale). Use exact profile labels \
  from the matrix as keys (e.g. "Hero | High").
- Release structure: release cadence + number of products. For a single launch \
  use release_cadence="single_launch", num_products=1.
- Asset distribution across products (even / front-loaded / back-loaded / \
  milestone-batched)

In your submit_scope call set scenario_category to "target_date". \
horizon_months is optional — derive it from (target_date − today) if needed.
"""

_DISCUSSION_INSTRUCTIONS = """\
You are a production planning assistant inside ArtHound. THE SCENARIO HAS ALREADY \
BEEN GENERATED — the aggregated data is injected below. Do not say the scenario \
has not been created or that you are waiting to build it. It exists.

Answer questions about the injected scenario data — timeline overlaps, craft peaks, \
asset distribution, schedule risk, hotspot analysis, etc. Be direct and specific. \
Compute answers from the concurrency and step distribution tables provided. \
Do not answer questions unrelated to this scenario or production planning generally.

RULES:
- The scenario IS generated. Never say otherwise.
- Reference only the data provided. Do not fabricate records or estimates.
- Do not reveal internal data structures or field names.
- If the user asks to change one or more of these parameters and regenerate: \
  craft caps, cadence interval, number of products/sprints, or asset counts per profile — \
  answer naturally (confirm what you understood), then append a SCENARIO_ACTION block \
  on its own line at the very end of your response. Format:\n\
  SCENARIO_ACTION: {"type":"regenerate","scope_changes":{...},"description":"..."}\n\
  Valid scope_changes keys:\n\
    craft_caps: object mapping craft name to integer cap (e.g. {"2D": 3}) — \
      only include crafts the user explicitly changed; null removes the cap\n\
    release_interval_days: integer — cadence interval in days\n\
    num_products: integer — number of sprints/releases\n\
    scale: object mapping profile label to integer count — \
      only include profiles the user explicitly changed\n\
  description: one sentence plain-English summary of the change.\n\
  Only emit SCENARIO_ACTION when the user is explicitly asking to change params and re-run. \
  For hypothetical "what if" questions, just compute the answer from the existing data without emitting the block.
- ALL time analysis must use DAYS as the unit — never weeks. \
  Peak concurrency figures are daily peaks (max tasks running on a single day). \
  When reporting dates or durations always say "days", not "weeks". \
  Do not convert days to weeks in your answers.
- PROFILE RULE: Every asset belongs to exactly ONE profile with ONE estimate per \
  step. NEVER sum estimates across multiple profiles — that produces meaningless \
  totals. To compute total work for a step: use (asset count for each profile) × \
  (that profile's estimate for the step), summed across profiles. Use \
  get_asset_schedule() for per-asset estimates; use the 'Work items by step' \
  count table for item totals. If you cannot derive a number without summing \
  across profiles, use the tool instead.
- NUMERIC GROUNDING: every count, date, duration, or rollup you state must \
  either (a) come directly from a value in the injected data, or (b) be a \
  mathematical derivation you show step-by-step from values in the injected data. \
  Derivation is encouraged — e.g. computing a critical path by summing step \
  durations along a DAG chain, or totalling asset counts from the scale table. \
  What is not allowed: estimates, approximations, or numbers that cannot be \
  traced back to the data through explicit arithmetic. If you cannot derive a \
  number from the data, say "I cannot verify that from the schedule data" and \
  explain what information would be needed. Show your working when deriving — \
  list the steps and durations you are summing so the answer is auditable.
"""


_DISCUSSION_DEFINITIONS = """\
PRODUCTION PLANNING DEFINITIONS AND FORMULAS
Use these precise definitions when answering questions. Show your working.

Critical path
  The longest chain of causally-connected steps from the first scheduled work item
  to the last. Its length equals the minimum possible duration of the whole scenario.
  Formula: sum all estimate_days values along the longest DAG path from any root step
  (no prerequisites) to any leaf step (nothing depends on it).
  To find it: trace every root-to-leaf path through the Step dependency DAG above,
  summing estimate_days at each node, then take the maximum total.

Total float (slack)
  How many days a step can be delayed before it pushes out the project end date.
  Formula: float(step) = Latest Start − Earliest Start
  where Earliest Start is the day the step can begin given its dependencies,
  and Latest Start is the last day it could begin without extending the critical path.
  A step on the critical path has float = 0.

Free float
  How many days a step can be delayed before it pushes out any of its successor steps.
  Formula: free_float(step) = min(earliest_start of all successors) − (start_date + estimate_days)

Concurrency (per craft)
  The number of tasks of that craft running simultaneously on a given calendar day.
  Derived from the injected "Craft concurrency" table: peak N tasks/day on DATE.
  Day-level concurrency = count of work items where start_date ≤ day ≤ end_date.

Craft utilisation
  How heavily a craft is loaded relative to its cap.
  Formula: utilisation = (peak concurrent tasks) / (craft cap)
  If no craft cap was set, utilisation is unconstrained (report the raw peak instead).
  Example: peak 3 tasks, cap 4 → 75% utilisation.

Product span
  Calendar duration from the earliest start_date to the latest end_date across all
  work items assigned to a product.
  Formula: span_days = (latest end_date) − (earliest start_date) + 1

Schedule density
  Work items per product: total work items for that product divided by asset count.
  Higher density → more steps per asset (more complex profiles in that product).

Asset throughput
  Average number of assets that complete per day across the scenario.
  Formula: throughput = total_assets / total_span_days
  where total_span_days = (latest end_date across all products) − (earliest start_date) + 1

Bottleneck step
  The step that appears most often on the critical path, or that has the highest
  peak concurrency relative to its craft cap. To identify: find which step has the
  highest (peak concurrency / craft cap) ratio.

All date arithmetic uses calendar days (not working days unless stated).
When showing derivations, list each step name and its estimate_days contribution.
"""


async def build_scoping_prompt(studio_id: str, category: str = "target_date") -> str:
    matrix_section = await _build_matrix_section(studio_id)
    instructions = (
        _SCOPING_INSTRUCTIONS_EARLIEST_SHIP
        if category == "earliest_ship"
        else _SCOPING_INSTRUCTIONS_TARGET_DATE
    )
    return f"{instructions}\n{_SCOPING_COMMON_RULES}\n{matrix_section}"


async def build_discussion_prompt(studio_id: str, session_id: str) -> str:
    session_r = await db_client.get(
        _url("/rest/v1/scenario_sessions"),
        params={"id": f"eq.{session_id}", "select": "scope_json", "limit": "1"},
        headers=_headers(),
    )
    scope: dict = {}
    if session_r.is_success and session_r.json():
        scope = session_r.json()[0].get("scope_json") or {}

    craft_caps = scope.get("craft_caps") or {}
    workflow_section = await _build_workflow_structure_section(studio_id)
    scope_section    = _build_scope_section(scope)
    data_section     = await _build_scenario_data_section(session_id, craft_caps)
    return (
        f"{_DISCUSSION_INSTRUCTIONS}\n\n"
        f"{_DISCUSSION_DEFINITIONS}\n\n"
        f"{scope_section}\n\n"
        f"{workflow_section}\n\n"
        f"{data_section}"
    )


def _build_scope_section(scope: dict) -> str:
    """Render the generation scope so Haiku knows the constraints used."""
    if not scope:
        return "GENERATION CONSTRAINTS\n  (not available)"

    lines = ["GENERATION CONSTRAINTS (inputs used to build this scenario)"]

    category = scope.get("scenario_category", "target_date")
    lines.append(f"  Mode: {category}")
    if category == "target_date" and scope.get("target_date"):
        lines.append(f"  Target date: {scope['target_date']}")

    cadence = scope.get("release_cadence")
    n       = scope.get("num_products")
    interval = scope.get("release_interval_days")
    if cadence:
        lines.append(f"  Release cadence: {cadence}" + (f"  ({n} products)" if n else ""))
    if interval:
        lines.append(f"  Release interval: {interval} days between products")

    scale = scope.get("scale") or {}
    if scale:
        lines.append("  Requested asset scale (total across all products):")
        for profile, count in scale.items():
            lines.append(f"    {profile}: {count}")

    craft_caps = scope.get("craft_caps") or {}
    if craft_caps:
        lines.append("  Craft caps (max concurrent tasks per craft):")
        for craft, cap in craft_caps.items():
            lines.append(f"    {craft}: {cap}")
    else:
        lines.append("  Craft caps: none (unconstrained)")

    dist = scope.get("distribution")
    if dist:
        lines.append(f"  Asset distribution across products: {dist}")

    constraints = scope.get("constraints") or []
    if constraints:
        lines.append("  Additional constraints:")
        for c in constraints:
            lines.append(f"    - {c}")

    return "\n".join(lines)


async def _build_workflow_structure_section(studio_id: str) -> str:
    """
    Workflow structure for the discussion prompt: step names, crafts, and dependency DAG only.
    Estimate values are intentionally omitted — each asset has exactly ONE profile with ONE
    estimate per step; summing estimates across profiles produces meaningless numbers.
    Per-asset estimates are available via get_asset_schedule().
    """
    steps_r, deps_r = await asyncio.gather(
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
    )

    steps = steps_r.json() if steps_r.is_success else []
    step_by_id = {s["id"]: s for s in steps}

    dep_graph: dict[str, list[str]] = {s["id"]: [] for s in steps}
    if deps_r.is_success:
        for d in deps_r.json():
            if d["step_id"] in dep_graph:
                dep_graph[d["step_id"]].append(d["depends_on_step_id"])

    sorted_step_ids = _topo_sort(dep_graph)

    dep_by_name: dict[str, list[str]] = {}
    for s in steps:
        dep_ids = dep_graph.get(s["id"], [])
        dep_by_name[s["name"]] = [step_by_id[did]["name"] for did in dep_ids if did in step_by_id]

    lines = [
        "WORKFLOW STRUCTURE",
        "NOTE: Estimate values are NOT shown here. Each asset has exactly ONE profile;",
        "each step has exactly ONE estimate for that profile. Never sum estimates across",
        "profiles — that produces meaningless totals. Use get_asset_schedule() for",
        "per-asset estimates, or the 'Work items by step' table below for item counts.",
        "",
        "Steps (name | craft):",
    ]
    for i, sid in enumerate(sorted_step_ids, 1):
        s = step_by_id.get(sid)
        if not s:
            continue
        craft = s.get("craft") or "unassigned"
        lines.append(f"  {i}. {s['name']} | {craft}")

    lines.append("")
    lines.append("Step dependency DAG (what must finish before each step can start):")
    has_deps = False
    for sid in sorted_step_ids:
        s = step_by_id.get(sid)
        if not s:
            continue
        dep_names = dep_by_name.get(s["name"], [])
        if dep_names:
            has_deps = True
            lines.append(f"  {s['name']}  requires: {', '.join(dep_names)}")
    if not has_deps:
        lines.append("  (no dependencies defined — all steps run in parallel)")

    return "\n".join(lines)


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

    # Build name-keyed dependency map for readable output.
    dep_by_name: dict[str, list[str]] = {}
    for s in steps:
        dep_ids = dep_graph.get(s["id"], [])
        dep_names = [step_by_id[did]["name"] for did in dep_ids if did in step_by_id]
        dep_by_name[s["name"]] = dep_names

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
    lines.append("Workflow steps with estimates (days) and craft assignments:")
    lines.append("(Steps with N/A do not apply to that profile and are not scheduled.)")
    for i, step_id in enumerate(sorted_step_ids, 1):
        s = step_by_id.get(step_id)
        if not s:
            continue
        craft_label = f" [craft: {s['craft']}]" if s.get("craft") else " [craft: unassigned]"
        estimates_parts = []
        for ck in combo_keys:
            days = step_estimates.get(step_id, {}).get(ck)
            label = ck.replace("|", " | ") if ck != "__default__" else "default"
            estimates_parts.append(f"{label}: {int(days)}d" if days else f"{label}: N/A")
        est_str = "  ".join(estimates_parts) if estimates_parts else "no estimates"
        lines.append(f"  {i}. {s['name']}{craft_label}  —  {est_str}")

    lines.append("")
    lines.append("Step dependency DAG (what must finish before each step can start):")
    lines.append("(Steps not listed here have no prerequisites and can start immediately.)")
    lines.append("(Steps that share the same prerequisite run in PARALLEL with each other.)")
    has_deps = False
    for step_id in sorted_step_ids:
        s = step_by_id.get(step_id)
        if not s:
            continue
        dep_names = dep_by_name.get(s["name"], [])
        if dep_names:
            has_deps = True
            lines.append(f"  {s['name']}  requires: {', '.join(dep_names)}")
    if not has_deps:
        lines.append("  (no dependencies defined — all steps are independent)")

    return "\n".join(lines)


async def _build_scenario_data_section(session_id: str, craft_caps: dict | None = None) -> str:
    """
    Build an aggregated summary of the scenario for Haiku.
    Per-asset detail is available on demand via tool calls (list_assets_in_product,
    get_asset_schedule) — this section stays compact regardless of scenario size.
    """
    from lib.db import drain_pages
    from collections import defaultdict, Counter
    from datetime import date as _date, timedelta as _td

    products_r, assets_r = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/scenario_products"),
            params={"session_id": f"eq.{session_id}", "select": "id,name,target_release_date",
                    "order": "created_at.asc"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/scenario_assets"),
            params={"session_id": f"eq.{session_id}",
                    "select": "id,product_id,name,variable_values,priority",
                    "order": "created_at.asc"},
            headers=_headers(),
        ),
    )
    work = await drain_pages(
        _url("/rest/v1/scenario_work"),
        params={"session_id": f"eq.{session_id}",
                "select": "asset_id,step_name,craft,estimate_days,start_date,end_date",
                "order": "start_date.asc,created_at.asc"},
        headers=_headers(),
        page=1000,
    )

    products = products_r.json() if products_r.is_success else []
    assets   = assets_r.json()   if assets_r.is_success   else []

    # Group work items by asset_id.
    work_by_asset: dict[str, list] = defaultdict(list)
    for w in work:
        work_by_asset[w["asset_id"]].append(w)

    # Group assets by product_id.
    assets_by_product: dict[str, list] = defaultdict(list)
    for a in assets:
        assets_by_product[a["product_id"]].append(a)

    lines = [
        "GENERATED SCENARIO DATA",
        f"Total: {len(products)} products  {len(assets)} assets  {len(work)} work items",
        "",
        "Use the list_assets_in_product and get_asset_schedule tools when you need",
        "per-asset or per-product detail to answer a specific question.",
        "",
        "PRODUCT SUMMARIES (name | release date | span | assets | work items):",
    ]

    for p in products:
        p_assets = assets_by_product.get(p["id"], [])
        p_work_all = [w for a in p_assets for w in work_by_asset.get(a["id"], [])]
        p_start = min((w["start_date"] for w in p_work_all if w.get("start_date")), default="—")
        p_end   = max((w["end_date"]   for w in p_work_all if w.get("end_date")),   default="—")
        release = p.get("target_release_date") or "—"
        lines.append(
            f"  {p['name']} | release:{release}"
            f" | span:{p_start}→{p_end}"
            f" | {len(p_assets)} assets | {len(p_work_all)} work items"
        )

    lines.append("")
    lines.append("ASSET PROFILE DISTRIBUTION (total assets per profile across all products):")
    profile_counts: Counter = Counter()
    for a in assets:
        vv = a.get("variable_values") or {}
        profile = " | ".join(str(v) for v in vv.values()) if vv else "default"
        profile_counts[profile] += 1
    for profile, count in profile_counts.most_common():
        lines.append(f"  {profile}: {count}")

    lines.append("")

    # ── Per-craft cap utilization (sweep-line over calendar spans) ───────────
    caps = craft_caps or {}
    craft_events: dict[str, list] = defaultdict(list)
    for w in work:
        craft = w.get("craft") or "Uncrafted"
        try:
            sd = _date.fromisoformat(w["start_date"])
            ed = _date.fromisoformat(w["end_date"])
        except (TypeError, ValueError):
            continue
        craft_events[craft].append((sd, +1))
        craft_events[craft].append((ed + _td(days=1), -1))

    lines.append("Craft cap utilization:")
    for craft in sorted(craft_events):
        events = sorted(craft_events[craft])
        cap = caps.get(craft)

        running = peak = 0
        peak_date = None
        days_at_cap = days_above_cap = days_below_cap = 0
        prev_date: _date | None = None

        for ev_date, delta in events:
            if prev_date is not None:
                span = (ev_date - prev_date).days
                if cap is None:
                    pass  # no cap defined — just track peak
                elif running > cap:
                    days_above_cap += span
                elif running == cap:
                    days_at_cap += span
                else:
                    days_below_cap += span
            running += delta
            if running > peak:
                peak = running
                peak_date = ev_date
            prev_date = ev_date

        if cap is not None:
            lines.append(
                f"  {craft}: cap={cap}  peak={peak} (on {peak_date})  "
                f"days_at_cap={days_at_cap}  days_below_cap={days_below_cap}"
                + (f"  days_above_cap={days_above_cap}" if days_above_cap else "")
            )
        else:
            lines.append(f"  {craft}: uncapped  peak={peak} tasks/day  (on {peak_date})")
    lines.append("")

    # ── Step distribution ──────────────────────────────────────────────────────
    step_counts = Counter(w["step_name"] for w in work)
    lines.append("Work items by step (total across all products):")
    for step, count in step_counts.most_common():
        lines.append(f"  {step}: {count}")

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
