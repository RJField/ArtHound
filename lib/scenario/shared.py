"""
Shared helpers used by both the AI generator (generator.py) and the
deterministic engine (deterministic.py).

Everything here is pure logic or DB I/O — no AI calls.
"""
import bisect
import logging
import math
from datetime import date, timedelta

from lib.db import db_client, _url, _headers
from lib.scenario.context import _combo_key, _topo_sort

log = logging.getLogger(__name__)


# ── Key normalisation ─────────────────────────────────────────────────────────

def normalize_scale_key(k: str) -> str:
    """
    Convert a display-format scope.scale key ("Hero | High") to the bare-pipe
    combo key used internally ("Hero|High").  The matrix section renders profiles
    with " | " separators so the scoping agent returns that format; internal combo
    keys use "|" with no surrounding spaces.

    "Default" (any case/spacing variant) maps to "__default__" so the wizard's
    generic fallback label matches the matrix's internal default key.
    """
    normalised = k.strip().replace(" | ", "|")
    if normalised.lower().strip("_") == "default":
        return "__default__"
    return normalised


def normalize_vv_keys(vv: dict, variable_fields: list[str]) -> dict:
    """
    Remap AI-abbreviated variable_values keys to the exact variable_fields names.
    Tries: exact → case-insensitive → field-starts-with-key → key-in-field.
    Returns a new dict with corrected keys; unmatched keys are passed through.
    """
    if not variable_fields or not vv:
        return vv
    if set(vv.keys()) == set(variable_fields):
        return vv

    result = {}
    used: set[str] = set()
    for ai_key, val in vv.items():
        matched = None
        lower = ai_key.lower()
        for f in variable_fields:
            if f not in used and f == ai_key:
                matched = f; break
        if not matched:
            for f in variable_fields:
                if f not in used and f.lower() == lower:
                    matched = f; break
        if not matched:
            for f in variable_fields:
                if f not in used and f.lower().startswith(lower):
                    matched = f; break
        if not matched:
            for f in variable_fields:
                if f not in used and lower in f.lower():
                    matched = f; break
        key = matched or ai_key
        result[key] = val
        if matched:
            used.add(matched)
    return result


# ── Validation helpers ────────────────────────────────────────────────────────

def normalize_profile_counts(profiles: list, scope: dict, session_id: str) -> list:
    """
    Adjust per-profile total_counts so they sum to the total requested in scope.
    Logs a warning and corrects in-place if the total is off.
    """
    scale = scope.get("scale") or {}
    if not scale:
        return profiles

    expected_total = sum(int(v) for v in scale.values() if isinstance(v, (int, float)))
    if expected_total <= 0:
        return profiles

    actual_total = sum(max(int(p.get("total_count") or 1), 1) for p in profiles)
    if actual_total == expected_total:
        return profiles

    log.warning(
        "Scenario %s — profile count mismatch: generated %d assets, scope requested %d; correcting",
        session_id, actual_total, expected_total,
    )

    scaled = [max(1, round(max(int(p.get("total_count") or 1), 1) * expected_total / actual_total))
              for p in profiles]
    diff = expected_total - sum(scaled)
    if diff != 0:
        largest = max(range(len(profiles)), key=lambda i: profiles[i].get("total_count") or 1)
        scaled[largest] = max(1, scaled[largest] + diff)

    for p, count in zip(profiles, scaled):
        p["total_count"] = count

    return profiles


def validate_profiles(profiles: list, variable_fields: list, known_combo_keys: set) -> None:
    for p in profiles:
        vv = p.get("variable_values") or {}
        if variable_fields and set(vv.keys()) != set(variable_fields):
            raise ValueError(f"Profile variable_values keys {list(vv.keys())} don't match {variable_fields}")
        key = _combo_key(vv, variable_fields)
        if key not in known_combo_keys:
            raise ValueError(f"Profile '{key}' not in estimate matrix")


# ── DB helpers ────────────────────────────────────────────────────────────────

async def fetch_validation_data(studio_id: str):
    """
    Returns (valid_steps, variable_fields, known_combo_keys, step_order,
             matrix_by_step_name, craft_by_step_name).
    """
    import asyncio
    steps_r, cfg_r, matrix_r, deps_r = await asyncio.gather(
        db_client.get(_url("/rest/v1/workflow_steps"),
                      params={"studio_id": f"eq.{studio_id}", "select": "id,name,craft", "order": "created_at.asc"},
                      headers=_headers()),
        db_client.get(_url("/rest/v1/estimate_config"),
                      params={"studio_id": f"eq.{studio_id}", "select": "variable_fields"},
                      headers=_headers()),
        db_client.get(_url("/rest/v1/estimate_matrix"),
                      params={"studio_id": f"eq.{studio_id}",
                               "select": "workflow_step_id,variable_values,estimate_days",
                               "limit": "10000"},
                      headers=_headers()),
        db_client.get(_url("/rest/v1/workflow_step_dependencies"),
                      params={"select": "step_id,depends_on_step_id"},
                      headers=_headers()),
    )
    steps = steps_r.json() if steps_r.is_success else []
    step_by_id = {s["id"]: s for s in steps}
    valid_steps = {s["name"] for s in steps}
    craft_by_step_name = {s["name"]: s.get("craft") for s in steps}

    cfg_rows = cfg_r.json() if cfg_r.is_success else []
    variable_fields = cfg_rows[0]["variable_fields"] if cfg_rows else []

    matrix_rows = matrix_r.json() if matrix_r.is_success else []
    known_combo_keys = {_combo_key(r.get("variable_values") or {}, variable_fields) for r in matrix_rows}

    matrix_by_step_name: dict[str, dict[str, float]] = {}
    for row in matrix_rows:
        s = step_by_id.get(row["workflow_step_id"])
        if not s:
            continue
        name = s["name"]
        key = _combo_key(row.get("variable_values") or {}, variable_fields)
        matrix_by_step_name.setdefault(name, {})[key] = row["estimate_days"] or 0

    dep_graph: dict[str, list[str]] = {s["id"]: [] for s in steps}
    if deps_r.is_success:
        for d in deps_r.json():
            if d["step_id"] in dep_graph:
                dep_graph[d["step_id"]].append(d["depends_on_step_id"])
    sorted_ids = _topo_sort(dep_graph)
    step_order = [step_by_id[sid]["name"] for sid in sorted_ids if sid in step_by_id]

    # Build name-keyed dependency graph for the schedulers.
    # dep_by_step_name[name] = [names of steps this step depends on]
    dep_by_step_name: dict[str, list[str]] = {}
    for s in steps:
        dep_ids  = dep_graph.get(s["id"], [])
        dep_names = [step_by_id[did]["name"] for did in dep_ids if did in step_by_id]
        dep_by_step_name[s["name"]] = dep_names

    return valid_steps, variable_fields, known_combo_keys, step_order, matrix_by_step_name, craft_by_step_name, dep_by_step_name


async def insert_products(session_id: str, studio_id: str, products: list) -> list:
    if not products:
        raise ValueError("Generation produced no products")
    r = await db_client.post(
        _url("/rest/v1/scenario_products"),
        json=[{"session_id": session_id, "studio_id": studio_id,
               "name": p["name"], "target_release_date": p.get("target_release_date")}
              for p in products],
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success:
        raise RuntimeError(f"Failed to insert scenario_products: {r.text}")
    return r.json()


async def expand_and_insert_assets(
    session_id: str, studio_id: str, profiles: list, inserted_products: list,
    variable_fields: list, scope: dict,
) -> list:
    """
    Distribute profile totals across products server-side, then insert.
    profiles: [{variable_values, total_count, priority}]
    """
    distribution_shape = scope.get("distribution", "even")
    n_products = len(inserted_products)
    if n_products == 0:
        raise ValueError("No products to distribute assets across")

    payload = []
    for prof in profiles:
        vv       = prof.get("variable_values") or {}
        total    = max(int(prof.get("total_count") or 1), 1)
        priority = prof.get("priority")
        profile_label = " ".join(str(v) for v in vv.values()) if vv else "Asset"

        counts = distribute_counts(total, n_products, distribution_shape)
        asset_num = 1
        for prod, count in zip(inserted_products, counts):
            for _ in range(count):
                payload.append({
                    "session_id":      session_id,
                    "studio_id":       studio_id,
                    "product_id":      prod["id"],
                    "name":            f"{profile_label} {asset_num:03d}",
                    "variable_values": vv,
                    "priority":        priority,
                })
                asset_num += 1

    if not payload:
        raise ValueError("Profile spec produced no assets")

    inserted = []
    for chunk in _chunk(payload, 500):
        r = await db_client.post(
            _url("/rest/v1/scenario_assets"),
            json=chunk,
            headers=_headers({"Prefer": "return=representation"}),
        )
        if not r.is_success:
            raise RuntimeError(f"Failed to insert scenario_assets: {r.text}")
        inserted.extend(r.json())

    return [
        {"id": a["id"], "name": a["name"],
         "variable_values": a["variable_values"], "product_id": a["product_id"]}
        for a in inserted
    ]


async def expand_and_insert_work(
    session_id: str,
    studio_id: str,
    asset_rows: list,
    templates: list,
    inserted_products: list,
    scope: dict,
    step_order: list[str],
    variable_fields: list,
    matrix_by_step_name: dict,
    craft_by_step_name: dict,
    craft_caps: dict | None = None,
    scenario_category: str = "target_date",
    dep_by_step_name: dict | None = None,
) -> dict[str, str]:
    """
    Expand templates into per-asset work rows and insert.

    scenario_category:
      "target_date"   — schedule backwards from each product's release date (default).
      "earliest_ship" — schedule forward from today; product release dates are
                        derived and must be updated by the caller post-insert.

    craft_caps: optional {craft_name: max_concurrent_assets}.
    High-priority assets get earliest slots; lower-priority assets are pushed
    forward until concurrent-asset count is within cap.
    """
    product_release: dict[str, date] = {}
    for p in inserted_products:
        rd = p.get("target_release_date")
        if rd:
            try:
                product_release[p["id"]] = date.fromisoformat(rd)
            except ValueError:
                pass

    today         = date.today()
    horizon_start = today
    caps          = craft_caps or {}
    forward       = (scenario_category == "earliest_ship")
    deps          = dep_by_step_name or {}

    assets_by_product: dict[str, list] = {}
    for a in asset_rows:
        assets_by_product.setdefault(a["product_id"], []).append(a)

    _PRIORITY_ORDER = {"high": 0, "medium": 1, "normal": 1, "low": 2}

    payload = []
    max_end_by_product: dict[str, str] = {}  # returned to caller for earliest_ship

    # For earliest_ship, each product starts after the previous product ends.
    product_cursor = today  # advances per product in forward mode

    # Global across all products — the cap represents a studio-wide concurrency
    # constraint; all assets across all sprints compete for the same slots.
    craft_starts: dict[str, list[date]] = {}
    craft_ends:   dict[str, list[date]] = {}

    # Cache for uncapped paths: assets sharing (combo_key, product) get identical
    # dates so we schedule once and clone, skipping redundant DAG work.
    _uncapped_cache: dict[tuple, list] = {}

    for pid in sorted(assets_by_product, key=lambda p: product_release.get(p, date.max)):
        p_assets = assets_by_product[pid]
        release = product_release.get(pid, today + timedelta(days=365))

        if caps:
            p_assets = sorted(
                p_assets,
                key=lambda a: _PRIORITY_ORDER.get((a.get("priority") or "").lower(), 1),
            )

        # For backward scheduling with caps: pre-compute a batch anchor that gives
        # all assets in this product enough runway to complete before release.
        # Per-asset cp_days is far too short when many assets compete for capped crafts.
        batch_start: date | None = None
        if caps and not forward and p_assets:
            batch_start = _batch_chain_start(
                p_assets, templates, variable_fields,
                matrix_by_step_name, craft_by_step_name, step_order,
                deps, release, horizon_start, caps,
            )

        product_end: date = product_cursor  # track latest end date for forward mode

        for asset in p_assets:
            vv = asset.get("variable_values") or {}
            combo_key = _combo_key(vv, variable_fields)
            template = _find_matching_template(vv, templates)
            if not template:
                continue

            step_name_list = template.get("step_names", [])
            ordered_names = sort_step_names(step_name_list, step_order)
            steps = []
            for name in ordered_names:
                days = (matrix_by_step_name.get(name) or {}).get(combo_key) or 1
                steps.append({
                    "step_name":    name,
                    "craft":        craft_by_step_name.get(name),
                    "estimate_days": days,
                })

            if forward:
                if caps:
                    work_items = _schedule_steps_forward_capped(
                        steps, deps, product_cursor, craft_starts, craft_ends, caps
                    )
                else:
                    _key = (combo_key, pid)
                    if _key in _uncapped_cache:
                        work_items = _uncapped_cache[_key]
                    else:
                        work_items = schedule_steps_forward(steps, deps, product_cursor)
                        _uncapped_cache[_key] = work_items
            else:
                if caps:
                    work_items = _schedule_steps_capped(
                        steps, deps, release, horizon_start, craft_starts, craft_ends, caps,
                        chain_start_override=batch_start,
                    )
                else:
                    _key = (combo_key, pid)
                    if _key in _uncapped_cache:
                        work_items = _uncapped_cache[_key]
                    else:
                        work_items = schedule_steps(steps, deps, release, horizon_start)
                        _uncapped_cache[_key] = work_items

            for w in work_items:
                payload.append({
                    "session_id":    session_id,
                    "studio_id":     studio_id,
                    "asset_id":      asset["id"],
                    "step_name":     w["step_name"],
                    "craft":         w.get("craft"),
                    "estimate_days": w.get("estimate_days"),
                    "start_date":    w["start_date"],
                    "end_date":      w["end_date"],
                })
                try:
                    product_end = max(product_end, date.fromisoformat(w["end_date"]))
                except ValueError:
                    pass

        # Always track the latest work end date per product so callers can
        # update product release dates to reflect actual asset availability.
        max_end_by_product[pid] = product_end.isoformat()

        # Advance cursor so the next product starts after this one finishes.
        if forward:
            product_cursor = product_end + timedelta(days=1)

    if not payload:
        raise ValueError("Work expansion produced no work items")

    for chunk in _chunk(payload, 500):
        r = await db_client.post(
            _url("/rest/v1/scenario_work"),
            json=chunk,
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if not r.is_success:
            raise RuntimeError(f"Failed to insert scenario_work: {r.text}")

    return max_end_by_product


async def expand_and_insert_work_cadence(
    session_id: str,
    studio_id: str,
    asset_rows: list,
    templates: list,
    inserted_products: list,
    scope: dict,
    step_order: list[str],
    variable_fields: list,
    matrix_by_step_name: dict,
    craft_by_step_name: dict,
    craft_caps: dict | None = None,
    dep_by_step_name: dict | None = None,
) -> dict[str, str]:
    """
    Forward-schedule all assets in one global cap pool, preserving existing
    product-asset assignments (PAW hierarchy untouched).

    Returns max_end_by_product {product_id: last_end_date_str} keyed by each
    asset's ORIGINAL product_id.  The caller uses this to derive cadence-adjusted
    sprint release dates (working backwards from the last sprint) and update
    scenario_products separately — no asset reassignment happens here.
    """
    today = date.today()
    caps  = craft_caps or {}
    deps  = dep_by_step_name or {}

    _PRIORITY_ORDER = {"high": 0, "medium": 1, "normal": 1, "low": 2}

    # Build a stable product-index so Sprint 1 assets enter the cap queue
    # before Sprint 2 assets, preserving the intended delivery order.
    product_order = {p["id"]: i for i, p in enumerate(inserted_products)}

    sorted_assets = sorted(
        asset_rows,
        key=lambda a: (
            product_order.get(a.get("product_id"), 999),
            _PRIORITY_ORDER.get((a.get("priority") or "").lower(), 1),
        ),
    )

    craft_starts: dict[str, list[date]] = {}
    craft_ends:   dict[str, list[date]] = {}
    payload: list = []
    max_end_by_product: dict[str, str] = {}

    # No-caps cadence: assets for different products cannot overlap, so track a
    # per-product cursor that advances after each product's assets finish.
    nocap_cursor: date = today
    nocap_current_pid: str | None = None

    # Cache for uncapped paths: same (combo_key, product) → identical dates.
    _uncapped_cache: dict[tuple, list] = {}

    for asset in sorted_assets:
        pid       = asset.get("product_id")
        vv        = asset.get("variable_values") or {}
        combo_key = _combo_key(vv, variable_fields)
        template  = _find_matching_template(vv, templates)
        if not template:
            continue

        step_name_list = template.get("step_names", [])
        ordered_names  = sort_step_names(step_name_list, step_order)
        steps = [
            {
                "step_name":     name,
                "craft":         craft_by_step_name.get(name),
                "estimate_days": max(int((matrix_by_step_name.get(name) or {}).get(combo_key) or 1), 1),
            }
            for name in ordered_names
        ]

        if caps:
            # Forward-only: start each asset from today, push capped steps out,
            # no backward pullback (steps land as early as possible — correct for
            # cadence mode where we derive release dates from actual completions).
            work_items = _schedule_steps_capped(
                steps, deps, today, today, craft_starts, craft_ends, caps, forward_only=True
            )
        else:
            # No craft caps: advance the cursor when we move to a new product
            # so each product's assets start after the previous product finishes.
            # Within a product, assets run in parallel (same cursor date).
            if pid != nocap_current_pid:
                if nocap_current_pid is not None and nocap_current_pid in max_end_by_product:
                    nocap_cursor = date.fromisoformat(max_end_by_product[nocap_current_pid]) + timedelta(days=1)
                nocap_current_pid = pid
            _key = (combo_key, pid)
            if _key in _uncapped_cache:
                work_items = _uncapped_cache[_key]
            else:
                work_items = schedule_steps_forward(steps, deps, nocap_cursor)
                _uncapped_cache[_key] = work_items

        for w in work_items:
            payload.append({
                "session_id":    session_id,
                "studio_id":     studio_id,
                "asset_id":      asset["id"],
                "step_name":     w["step_name"],
                "craft":         w.get("craft"),
                "estimate_days": w.get("estimate_days"),
                "start_date":    w["start_date"],
                "end_date":      w["end_date"],
            })
            if pid:
                try:
                    end = date.fromisoformat(w["end_date"])
                    if end > date.fromisoformat(max_end_by_product.get(pid, "1900-01-01")):
                        max_end_by_product[pid] = w["end_date"]
                except ValueError:
                    pass

    if not payload:
        raise ValueError("Work expansion produced no work items")

    for chunk in _chunk(payload, 500):
        r = await db_client.post(
            _url("/rest/v1/scenario_work"),
            json=chunk,
            headers=_headers({"Prefer": "return=minimal"}),
        )
        if not r.is_success:
            raise RuntimeError(f"Failed to insert scenario_work: {r.text}")

    return max_end_by_product


async def set_generation_status(session_id: str, msg: str) -> None:
    await db_client.patch(
        _url("/rest/v1/scenario_sessions"),
        params={"id": f"eq.{session_id}"},
        json={"generation_status": msg},
        headers=_headers({"Prefer": "return=minimal"}),
    )


async def rollback(session_id: str) -> None:
    log.warning("Scenario %s — rolling back", session_id)
    await db_client.delete(
        _url("/rest/v1/scenario_products"),
        params={"session_id": f"eq.{session_id}"},
        headers=_headers(),
    )


# ── Distribution ──────────────────────────────────────────────────────────────

def distribute_counts(total: int, n: int, shape: str) -> list[int]:
    """Distribute `total` assets across `n` products according to `shape`."""
    if n == 1:
        return [total]

    if shape == "even":
        base, rem = divmod(total, n)
        return [base + (1 if i < rem else 0) for i in range(n)]

    if shape == "front_loaded":
        weights = list(range(n, 0, -1))
    elif shape == "back_loaded":
        weights = list(range(1, n + 1))
    elif shape == "milestone_batched":
        milestones = {int(n * f) for f in (0.25, 0.5, 0.75, 1.0)}
        milestones = {min(m, n - 1) for m in milestones}
        weights = [10 if i in milestones else 1 for i in range(n)]
    else:
        base, rem = divmod(total, n)
        return [base + (1 if i < rem else 0) for i in range(n)]

    total_weight = sum(weights)
    counts = [int(total * w / total_weight) for w in weights]
    diff = total - sum(counts)
    order = sorted(range(n), key=lambda i: weights[i], reverse=True)
    for i in range(diff):
        counts[order[i % n]] += 1
    return counts


# ── Scheduling ────────────────────────────────────────────────────────────────

def sort_step_names(step_names: list[str], step_order: list[str]) -> list[str]:
    """Sort a flat list of step names by the studio's workflow step order."""
    order_index = {name: i for i, name in enumerate(step_order)}
    return sorted(step_names, key=lambda n: order_index.get(n, 999))


# ── DAG helpers ───────────────────────────────────────────────────────────────

def _topo_sort_subset(dep_by_name: dict, names: set) -> list[str]:
    """
    Topological sort of `names` using dep_by_name (name → [dep_names]).
    Dependencies not present in `names` are ignored.
    """
    visited: set = set()
    result: list = []

    def visit(n: str) -> None:
        if n in visited:
            return
        visited.add(n)
        for d in dep_by_name.get(n, []):
            if d in names:
                visit(d)
        result.append(n)

    for n in names:
        visit(n)
    return result


def _critical_path_days(sorted_names: list, local_deps: dict, name_to_step: dict) -> int:
    """
    Length in days of the longest (critical) path through the DAG.
    sorted_names must be in topological order (deps before dependents).
    """
    path_len: dict = {}
    for name in sorted_names:
        days = max(int(name_to_step[name].get("estimate_days") or 1), 1)
        dep_lens = [path_len[d] for d in local_deps.get(name, []) if d in path_len]
        path_len[name] = days + (max(dep_lens) if dep_lens else 0)
    return max(path_len.values(), default=1)


# ── Core schedulers (DAG-aware) ───────────────────────────────────────────────

def schedule_steps(steps: list, dep_by_name: dict, release: date, horizon_start: date) -> list:
    """
    Backward-schedule steps respecting the dependency DAG.

    Terminal steps (no successors within this asset's template) end on `release`.
    Each step's end date is constrained to be before all of its successors' start dates.
    Independent branches execute in parallel — their dates overlap.
    """
    if not steps:
        return []

    name_to_step = {s["step_name"]: s for s in steps}
    names = set(name_to_step)
    local_deps = {n: [d for d in dep_by_name.get(n, []) if d in names] for n in names}
    sorted_names = _topo_sort_subset(local_deps, names)

    # Build successor map (reverse of dependency map).
    rdeps: dict = {n: [] for n in names}
    for n, ds in local_deps.items():
        for d in ds:
            rdeps[d].append(n)

    # Backward pass: assign latest-possible start/end to each step.
    end_date: dict = {}
    start_date: dict = {}
    for name in reversed(sorted_names):
        s    = name_to_step[name]
        days = max(int(s.get("estimate_days") or 1), 1)
        successors = rdeps[name]
        if successors:
            latest_end = min(start_date.get(succ, release) - timedelta(days=1) for succ in successors)
        else:
            latest_end = release
        latest_start = max(latest_end - timedelta(days=days - 1), horizon_start)
        start_date[name] = latest_start
        end_date[name]   = latest_start + timedelta(days=days - 1)

    return [
        {
            "step_name":     name,
            "craft":         name_to_step[name].get("craft"),
            "estimate_days": max(int(name_to_step[name].get("estimate_days") or 1), 1),
            "start_date":    start_date[name].isoformat(),
            "end_date":      end_date[name].isoformat(),
        }
        for name in sorted_names
    ]


def schedule_steps_forward(steps: list, dep_by_name: dict, start: date) -> list:
    """
    Forward-schedule steps respecting the dependency DAG.

    Each step starts as soon as all its dependencies have finished.
    Independent branches execute in parallel — their dates overlap.
    """
    if not steps:
        return []

    name_to_step = {s["step_name"]: s for s in steps}
    names = set(name_to_step)
    local_deps = {n: [d for d in dep_by_name.get(n, []) if d in names] for n in names}
    sorted_names = _topo_sort_subset(local_deps, names)

    finish: dict = {}
    result = []
    for name in sorted_names:
        s    = name_to_step[name]
        days = max(int(s.get("estimate_days") or 1), 1)
        dep_names = local_deps[name]
        # finish.get(d, start) guards against cyclic deps: a dep not yet scheduled
        # (because of a cycle in workflow_step_dependencies) falls back to `start`
        # so we degrade to sequential order rather than raising a KeyError.
        earliest  = max((finish.get(d, start) + timedelta(days=1) for d in dep_names), default=start)
        end       = earliest + timedelta(days=days - 1)
        finish[name] = end
        result.append({
            "step_name":     name,
            "craft":         s.get("craft"),
            "estimate_days": days,
            "start_date":    earliest.isoformat(),
            "end_date":      end.isoformat(),
        })
    return result


def _schedule_steps_forward_capped(
    steps: list,
    dep_by_name: dict,
    start: date,
    craft_starts: dict[str, list[date]],
    craft_ends: dict[str, list[date]],
    caps: dict[str, int],
) -> list:
    """Forward DAG scheduling with per-craft concurrent-asset caps."""
    if not steps:
        return []

    name_to_step = {s["step_name"]: s for s in steps}
    names = set(name_to_step)
    local_deps = {n: [d for d in dep_by_name.get(n, []) if d in names] for n in names}
    sorted_names = _topo_sort_subset(local_deps, names)

    finish: dict = {}
    result = []
    for name in sorted_names:
        s     = name_to_step[name]
        days  = max(int(s.get("estimate_days") or 1), 1)
        craft = s.get("craft")
        dep_names = local_deps[name]
        earliest  = max((finish.get(d, start) + timedelta(days=1) for d in dep_names), default=start)
        cap = caps.get(craft) if craft else None
        if cap:
            earliest = _find_earliest_uncapped_start(earliest, days, craft, craft_starts, craft_ends, cap)
        end = earliest + timedelta(days=days - 1)
        finish[name] = end
        # Register immediately so parallel steps within this asset count against the cap.
        if craft and cap:
            bisect.insort(craft_starts.setdefault(craft, []), earliest)
            bisect.insort(craft_ends.setdefault(craft, []), end)
        result.append({
            "step_name":     name,
            "craft":         craft,
            "estimate_days": days,
            "start_date":    earliest.isoformat(),
            "end_date":      end.isoformat(),
        })
    return result


def _find_earliest_uncapped_start(
    proposed_start: date,
    duration_days: int,
    craft: str,
    craft_starts: dict[str, list[date]],
    craft_ends: dict[str, list[date]],
    cap: int,
) -> date:
    """
    Find the earliest start >= proposed_start where fewer than `cap` already-scheduled
    windows for `craft` overlap the span [start, start + duration - 1].

    Uses sorted start/end lists with bisect for O(log W) overlap counting.
    Candidates are proposed_start plus each (window_end + 1) >= proposed_start —
    the only dates where concurrency can drop, so day-by-day stepping is unnecessary.
    """
    starts = craft_starts.get(craft, [])
    ends   = craft_ends.get(craft, [])

    if not starts:
        return proposed_start

    def overlap_count(s: date) -> int:
        e = s + timedelta(days=duration_days - 1)
        # windows starting <= e  minus  windows ending < s
        return bisect.bisect_right(starts, e) - bisect.bisect_left(ends, s)

    if overlap_count(proposed_start) < cap:
        return proposed_start

    # Walk candidate starts: each (we + 1) that is strictly after proposed_start.
    # ends is sorted; bisect_right(ends, proposed_start - 1day) gives the first
    # index where ends[i] >= proposed_start, so ends[i] + 1 > proposed_start.
    idx = bisect.bisect_right(ends, proposed_start - timedelta(days=1))
    while idx < len(ends):
        s = ends[idx] + timedelta(days=1)
        if overlap_count(s) < cap:
            return s
        idx += 1

    # All existing windows exhausted — start the day after the last one ends.
    return ends[-1] + timedelta(days=1)


def _batch_chain_start(
    p_assets: list,
    templates: list,
    variable_fields: list,
    matrix_by_step_name: dict,
    craft_by_step_name: dict,
    step_order: list,
    dep_by_step_name: dict,
    release: date,
    horizon_start: date,
    caps: dict,
) -> date:
    """
    Compute the earliest chain_start that gives the batch of assets in p_assets
    enough runway to all complete by release, respecting craft caps.

    For each capped craft: minimum calendar span = ceil(sum_of_all_estimate_days / cap).
    chain_start = release - max(single_asset_cp, max_craft_span).

    Without this, every asset in the batch anchors to the same (release − single_cp),
    and the cap-push shoves assets forward past the release date.
    """
    craft_total_days: dict[str, int] = {}
    max_cp = 0

    for asset in p_assets:
        vv = asset.get("variable_values") or {}
        combo_key = _combo_key(vv, variable_fields)
        template = _find_matching_template(vv, templates)
        if not template:
            continue

        step_name_list = template.get("step_names", [])
        ordered_names = sort_step_names(step_name_list, step_order)
        steps_local = []
        for step_name in ordered_names:
            days = max(int((matrix_by_step_name.get(step_name) or {}).get(combo_key) or 1), 1)
            craft = craft_by_step_name.get(step_name)
            if craft and caps.get(craft):
                craft_total_days[craft] = craft_total_days.get(craft, 0) + days
            steps_local.append({"step_name": step_name, "estimate_days": days})

        names_local = {s["step_name"] for s in steps_local}
        name_to_step_local = {s["step_name"]: s for s in steps_local}
        local_deps_local = {
            n: [d for d in dep_by_step_name.get(n, []) if d in names_local]
            for n in names_local
        }
        sorted_local = _topo_sort_subset(local_deps_local, names_local)
        max_cp = max(max_cp, _critical_path_days(sorted_local, local_deps_local, name_to_step_local))

    if craft_total_days:
        max_craft_span = max(
            math.ceil(total / caps[craft])
            for craft, total in craft_total_days.items()
            if caps.get(craft, 0) > 0
        )
    else:
        max_craft_span = 0

    span = max(max_cp, max_craft_span)
    return max(release - timedelta(days=span - 1), horizon_start)


def _schedule_steps_capped(
    steps: list,
    dep_by_name: dict,
    release: date,
    horizon_start: date,
    craft_starts: dict[str, list[date]],
    craft_ends: dict[str, list[date]],
    caps: dict[str, int],
    *,
    forward_only: bool = False,
    chain_start_override: date | None = None,
) -> list:
    """
    DAG scheduling with per-craft concurrent-asset caps.

    Two-pass approach (default, backward mode):
    1. Forward cap-push pass: anchor at chain_start, schedule forward,
       pushing capped steps out until the cap has room.
    2. Backward pullback pass: pull uncapped steps (prep, polish, etc.) as late as
       possible — just before their successor's actual start — so each asset's work
       block stays compact instead of frontloading unconstrained steps.

    chain_start_override: pre-computed batch anchor from _batch_chain_start that
    accounts for the total cap-constrained workload across all assets in the batch.
    When provided, we use min(cp_chain_start, override) so the window is never
    narrower than a single asset's critical path needs.

    forward_only=True: anchor at horizon_start (today), skip the backward pullback.
    Used for cadence scheduling where work should begin as early as possible.
    """
    if not steps:
        return []

    name_to_step = {s["step_name"]: s for s in steps}
    names = set(name_to_step)
    local_deps = {n: [d for d in dep_by_name.get(n, []) if d in names] for n in names}
    sorted_names = _topo_sort_subset(local_deps, names)

    if forward_only:
        chain_start = horizon_start
    else:
        cp_days        = _critical_path_days(sorted_names, local_deps, name_to_step)
        cp_chain_start = max(release - timedelta(days=cp_days - 1), horizon_start)
        if chain_start_override is not None:
            # Take the earlier date: override accounts for total batch cap stretch;
            # cp_chain_start ensures we never clip a single asset's own critical path.
            chain_start = min(cp_chain_start, chain_start_override)
        else:
            chain_start = cp_chain_start

    # ── Pass 1: forward cap-push ──────────────────────────────────────────────
    actual_start: dict[str, date] = {}
    actual_end:   dict[str, date] = {}
    finish:       dict[str, date] = {}

    for name in sorted_names:
        s     = name_to_step[name]
        days  = max(int(s.get("estimate_days") or 1), 1)
        craft = s.get("craft")
        dep_names = local_deps[name]
        earliest  = max(
            (finish.get(d, chain_start) + timedelta(days=1) for d in dep_names),
            default=chain_start,
        )
        cap = caps.get(craft) if craft else None
        if cap:
            earliest = _find_earliest_uncapped_start(earliest, days, craft, craft_starts, craft_ends, cap)
        end = earliest + timedelta(days=days - 1)
        finish[name] = end
        actual_start[name] = earliest
        actual_end[name]   = end
        if craft and cap:
            bisect.insort(craft_starts.setdefault(craft, []), earliest)
            bisect.insort(craft_ends.setdefault(craft, []), end)

    if forward_only:
        return [
            {
                "step_name":     name,
                "craft":         name_to_step[name].get("craft"),
                "estimate_days": max(int(name_to_step[name].get("estimate_days") or 1), 1),
                "start_date":    actual_start[name].isoformat(),
                "end_date":      actual_end[name].isoformat(),
            }
            for name in sorted_names
        ]

    # ── Pass 2: backward pullback for uncapped steps ──────────────────────────
    # Pull each uncapped step to sit just before its successor starts, so
    # prep/polish chains don't frontload at chain_start while capped production
    # work sits months later.
    #
    # IMPORTANT: steps that are capped OR have any capped ancestor (transitively)
    # must keep their forward-computed positions.  Only "pure pre-production" chains
    # with zero capped ancestry get pulled back.  Without this guard, post-capped
    # steps (e.g. a review step after a capped 2D pass) get anchored to the product
    # release date, producing disconnected stubs far from the work block.
    rdeps: dict[str, list[str]] = {n: [] for n in names}
    for n, ds in local_deps.items():
        for d in ds:
            rdeps[d].append(n)

    # Compute capped ancestry in topo order (predecessors before successors).
    capped_ancestry: set[str] = set()
    for name in sorted_names:
        craft = name_to_step[name].get("craft")
        is_capped = bool(caps.get(craft) if craft else False)
        has_capped_ancestor = any(d in capped_ancestry for d in local_deps[name])
        if is_capped or has_capped_ancestor:
            capped_ancestry.add(name)

    # Orphan fallback anchor: when an uncapped step has no explicit successors
    # linking it to the capped work, fall back to "just before the first capped
    # step starts" rather than "release date".  This matters when the global cap
    # has pushed capped steps past the product release date — without this, orphan
    # prep steps anchor to the (earlier) release date and appear disconnected.
    directly_capped = {n for n in names if caps.get(name_to_step[n].get("craft") or "")}
    orphan_anchor = (
        min(actual_start[n] for n in directly_capped) - timedelta(days=1)
        if directly_capped else release
    )

    for name in reversed(sorted_names):
        if name in capped_ancestry:
            continue  # capped or downstream of capped — keep forward position

        successors = rdeps[name]
        latest_end = (
            min(actual_start[s] - timedelta(days=1) for s in successors)
            if successors else orphan_anchor
        )
        days = max(int(name_to_step[name].get("estimate_days") or 1), 1)

        # Floor: cannot start before all predecessors finish.
        deps_floor = max(
            (actual_end[d] + timedelta(days=1) for d in local_deps[name] if d in actual_end),
            default=horizon_start,
        )
        latest_start       = max(latest_end - timedelta(days=days - 1), horizon_start, deps_floor)
        actual_start[name] = latest_start
        actual_end[name]   = latest_start + timedelta(days=days - 1)

    return [
        {
            "step_name":     name,
            "craft":         name_to_step[name].get("craft"),
            "estimate_days": max(int(name_to_step[name].get("estimate_days") or 1), 1),
            "start_date":    actual_start[name].isoformat(),
            "end_date":      actual_end[name].isoformat(),
        }
        for name in sorted_names
    ]


def _find_matching_template(vv: dict, templates: list) -> dict | None:
    """Return the first template whose match_when is a subset of the asset's variable_values."""
    for t in templates:
        match_when = t.get("match_when") or {}
        if all(vv.get(k) == v for k, v in match_when.items()):
            return t
    return templates[0] if templates else None


# ── Utilities ─────────────────────────────────────────────────────────────────

def _chunk(lst: list, size: int):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]
