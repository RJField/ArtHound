"""
Rule-based scenario generation engine.
Entry point: run_rule_based_generation(session_id, studio_id, scope)

No AI calls. Every planning decision is a function of (scope, matrix, workflow_graph).
Both engines write to the same scenario_* tables; viewer/discussion work unchanged.
"""
import logging
from datetime import date, timedelta

from lib.db import db_client, _url, _headers
from lib.scenario.context import _combo_key
from lib.scenario.shared import (
    fetch_validation_data,
    insert_products,
    expand_and_insert_assets,
    expand_and_insert_work,
    rollback,
    normalize_scale_key,
    normalize_profile_counts,
    validate_profiles,
    _topo_sort_subset,
    _critical_path_days,
)

log = logging.getLogger(__name__)


async def run_rule_based_generation(session_id: str, studio_id: str, scope: dict) -> None:
    """
    Entry point called by _scenario_generation_loop when generation_mode == 'rule_based'.
    Raises on failure — caller sets generation_failed.

    scenario_category in scope:
      "target_date"   — backwards-schedule from given target dates; flag infeasibility.
      "earliest_ship" — forward-schedule from today; derive and update product dates.
    """
    await rollback(session_id)

    category = scope.get("scenario_category", "target_date")
    valid_steps, variable_fields, known_combo_keys, step_order, matrix_by_step_name, craft_by_step_name, dep_by_step_name = \
        await fetch_validation_data(studio_id)

    # ── Step 1: Products ──────────────────────────────────────────────────────
    log.info("Scenario %s (rule-based, %s) — generating products", session_id, category)
    products = _build_products(scope)
    inserted_products = await insert_products(session_id, studio_id, products)

    # ── Step 2: Asset profiles ────────────────────────────────────────────────
    log.info("Scenario %s (rule-based) — resolving asset profiles", session_id)
    profiles = _resolve_scale_to_profiles(scope, variable_fields, known_combo_keys)
    profiles = normalize_profile_counts(profiles, scope, session_id)

    # ── Step 2.5: Pre-flight checks ───────────────────────────────────────────
    warnings = _check_matrix_sparsity(profiles, matrix_by_step_name, variable_fields)

    if category == "target_date":
        target_date_str = scope.get("target_date")
        if target_date_str:
            try:
                target_date = date.fromisoformat(target_date_str)
                warnings += _check_target_date_feasibility(
                    profiles, matrix_by_step_name, variable_fields, step_order,
                    dep_by_step_name, target_date
                )
            except ValueError:
                pass

    if warnings:
        log.warning("Scenario %s (rule-based) — preflight warnings: %s", session_id, warnings)
        await _write_preflight_warnings(session_id, warnings)

    asset_rows = await expand_and_insert_assets(
        session_id, studio_id, profiles, inserted_products, variable_fields, scope
    )

    # ── Step 3: Work templates ────────────────────────────────────────────────
    log.info("Scenario %s (rule-based) — building work templates", session_id)
    templates = _build_deterministic_templates(
        variable_fields, known_combo_keys, matrix_by_step_name, step_order
    )

    craft_caps = scope.get("craft_caps") or {}
    max_end_by_product_id = await expand_and_insert_work(
        session_id, studio_id, asset_rows, templates, inserted_products,
        scope, step_order, variable_fields, matrix_by_step_name, craft_by_step_name,
        craft_caps=craft_caps or None,
        scenario_category=category,
        dep_by_step_name=dep_by_step_name,
    )

    # ── Step 4 (earliest_ship only): Derive + update product release dates ────
    if category == "earliest_ship":
        log.info("Scenario %s (rule-based) — computing derived product release dates", session_id)
        await _update_product_dates_from_work(session_id, inserted_products, max_end_by_product_id)

    log.info("Scenario %s (rule-based) — generation complete", session_id)


# ── Step 1 helpers ────────────────────────────────────────────────────────────

def _build_products(scope: dict) -> list[dict]:
    """
    Generate product list without AI using cadence-aware naming.

    For earliest_ship: target_release_date is set to None (placeholder) —
    the engine computes real dates after forward scheduling.
    For target_date: the final product gets scope["target_date"]; earlier
    products are spaced evenly backwards from it.
    """
    category    = scope.get("scenario_category", "target_date")
    cadence     = scope.get("release_cadence", "regular_releases")
    horizon     = scope.get("horizon_months") or 12
    n           = scope.get("num_products") or _infer_num_products(cadence, horizon)
    today       = date.today()
    placeholder = None  # earliest_ship: dates are derived post-scheduling

    # Prefer explicit interval from wizard; fall back to deriving from target_date or horizon.
    interval_days: int = scope.get("release_interval_days") or 0
    if not interval_days:
        if category == "target_date" and scope.get("target_date"):
            try:
                final_date    = date.fromisoformat(scope["target_date"])
                total_days    = (final_date - today).days
                horizon       = max(1, round(total_days / 30.44))
                interval_days = max(1, total_days // n)
            except ValueError:
                interval_days = int(horizon * 30.44 / max(n, 1))
        else:
            interval_days = int(horizon * 30.44 / max(n, 1))

    def _target(i: int) -> str | None:
        if category == "earliest_ship":
            return placeholder
        return (today + timedelta(days=interval_days * i)).isoformat()

    if n == 1 or cadence == "single_launch":
        t = scope.get("target_date") if category == "target_date" else placeholder
        return [{"name": "Launch", "target_release_date": t}]

    products = []

    if cadence == "milestone_batched":
        if n == 3:
            names = ["Alpha", "Beta", "Gold"]
        elif n == 4:
            names = ["Alpha", "Beta", "Gold", "Live"]
        else:
            names = [f"Milestone {i}" for i in range(1, n + 1)]
        for i, name in enumerate(names, 1):
            products.append({"name": name, "target_release_date": _target(i)})

    elif cadence == "regular_releases":
        if interval_days >= 80:
            # Roughly quarterly or slower → quarter labels.
            names = _quarter_labels(today, n)
            for i, name in enumerate(names, 1):
                products.append({"name": name, "target_release_date": _target(i)})
        elif interval_days >= 25:
            # Monthly-ish → "Jun '26" style labels.
            names = _month_labels(today, n, interval_days)
            for i, name in enumerate(names, 1):
                products.append({"name": name, "target_release_date": _target(i)})
        else:
            # Biweekly / weekly → "Sprint N".
            for i in range(1, n + 1):
                products.append({"name": f"Sprint {i}", "target_release_date": _target(i)})

    else:
        for i in range(1, n + 1):
            products.append({"name": f"Release {i}", "target_release_date": _target(i)})

    return products


def _infer_num_products(cadence: str, horizon: int) -> int:
    if cadence == "single_launch":
        return 1
    if cadence == "regular_releases":
        return max(1, round(horizon / 3))
    if cadence == "milestone_batched":
        return 3
    return max(1, horizon)


def _quarter_labels(today: date, n: int) -> list[str]:
    """Generate up to n quarterly labels starting from today's quarter."""
    quarter = (today.month - 1) // 3 + 1
    year    = today.year
    labels  = []
    for _ in range(n):
        labels.append(f"Q{quarter} {year}")
        quarter += 1
        if quarter > 4:
            quarter = 1
            year += 1
    return labels


def _month_labels(today: date, n: int, interval_days: int) -> list[str]:
    """Generate n month labels spaced by interval_days, e.g. "Jun '26"."""
    labels  = []
    current = today
    for _ in range(n):
        current += timedelta(days=interval_days)
        labels.append(current.strftime("%b '%y"))
    return labels


# ── Step 2 helpers ────────────────────────────────────────────────────────────

def _resolve_scale_to_profiles(
    scope: dict,
    variable_fields: list[str],
    known_combo_keys: set,
) -> list[dict]:
    """
    Convert scope["scale"] {display_label: count} into profile dicts with variable_values.

    scope.scale keys may use display format "Hero | High" (space-pipe-space);
    normalize_scale_key converts them to the bare-pipe combo key "Hero|High".
    """
    scale = scope.get("scale") or {}
    if not scale:
        if "__default__" in known_combo_keys:
            total = 1
            return [{"variable_values": {}, "total_count": total, "priority": "Normal"}]
        raise ValueError("scope.scale is empty and no default profile exists")

    profiles = []
    for raw_label, count in scale.items():
        combo_key = normalize_scale_key(raw_label)
        if combo_key not in known_combo_keys:
            available = sorted(known_combo_keys)
            raise ValueError(
                f"Scale key '{raw_label}' (normalized: '{combo_key}') not in estimate matrix. "
                f"Available: {available}"
            )
        # Reconstruct variable_values from the combo key and variable_fields.
        vv = _combo_key_to_vv(combo_key, variable_fields)
        profiles.append({
            "variable_values": vv,
            "total_count": max(int(count or 1), 1),
            "priority": _priority_from_vv(vv),
        })

    return profiles


def _combo_key_to_vv(combo_key: str, variable_fields: list[str]) -> dict:
    """Inverse of _combo_key: split a bare-pipe key back into a variable_values dict."""
    if combo_key == "__default__" or not variable_fields:
        return {}
    parts = combo_key.split("|")
    return {f: (parts[i] if i < len(parts) else "") for i, f in enumerate(variable_fields)}


def _priority_from_vv(vv: dict) -> str:
    """Infer scheduling priority from variable_values (looks for a priority-ish field)."""
    for k, v in vv.items():
        kl = k.lower()
        if "priority" in kl or "must" in kl or "should" in kl:
            return str(v)
    return "Normal"


# ── Step 2.5 helpers ──────────────────────────────────────────────────────────

def _check_matrix_sparsity(
    profiles: list,
    matrix_by_step_name: dict,
    variable_fields: list[str],
) -> list[dict]:
    """
    Return warning objects for any profile that has zero steps with estimate_days > 0.
    """
    warnings = []
    for prof in profiles:
        vv = prof.get("variable_values") or {}
        combo_key = _combo_key(vv, variable_fields)
        has_steps = any(
            (estimates.get(combo_key) or 0) > 0
            for estimates in matrix_by_step_name.values()
        )
        if not has_steps:
            label = " | ".join(str(v) for v in vv.values()) or combo_key
            warnings.append({"profile": label, "issue": "no_steps"})
    return warnings


def _check_target_date_feasibility(
    profiles: list,
    matrix_by_step_name: dict,
    variable_fields: list[str],
    step_order: list[str],
    dep_by_step_name: dict,
    target_date: date,
) -> list[dict]:
    """
    Return infeasibility warnings for profiles whose critical-path duration
    exceeds the available days between today and target_date.

    Uses the DAG dependency structure so parallel branches don't inflate the
    estimate — only the longest sequential chain (critical path) is checked.
    """
    available_days = (target_date - date.today()).days
    if available_days <= 0:
        return []

    warnings = []
    for prof in profiles:
        vv = prof.get("variable_values") or {}
        combo_key = _combo_key(vv, variable_fields)

        # Build step objects for steps that have a non-zero estimate for this profile.
        active_steps = [
            {"step_name": name, "estimate_days": (matrix_by_step_name.get(name) or {}).get(combo_key, 0)}
            for name in step_order
            if (matrix_by_step_name.get(name) or {}).get(combo_key, 0) > 0
        ]
        if not active_steps:
            continue

        names = {s["step_name"] for s in active_steps}
        name_to_step = {s["step_name"]: s for s in active_steps}
        local_deps = {n: [d for d in dep_by_step_name.get(n, []) if d in names] for n in names}
        sorted_names = _topo_sort_subset(local_deps, names)
        cp_days = _critical_path_days(sorted_names, local_deps, name_to_step)

        if cp_days > available_days:
            label = " | ".join(str(v) for v in vv.values()) or combo_key
            warnings.append({
                "profile": label,
                "issue": "infeasible_timeline",
                "critical_path_days": cp_days,
                "available_days": available_days,
                "shortfall_days": cp_days - available_days,
            })
    return warnings


async def _write_preflight_warnings(session_id: str, warnings: list) -> None:
    await db_client.patch(
        _url("/rest/v1/scenario_sessions"),
        params={"id": f"eq.{session_id}"},
        json={"preflight_warnings": warnings},
        headers=_headers({"Prefer": "return=minimal"}),
    )


# ── Step 3 helpers ────────────────────────────────────────────────────────────

def _build_deterministic_templates(
    variable_fields: list[str],
    known_combo_keys: set,
    matrix_by_step_name: dict,
    step_order: list[str],
) -> list[dict]:
    """
    Build one work template per distinct primary-variable value.
    Includes only steps with estimate_days > 0 for that profile, in topo order.
    """
    if not variable_fields:
        # Single default profile.
        steps = [
            name for name in step_order
            if (matrix_by_step_name.get(name) or {}).get("__default__", 0) > 0
        ]
        return [{"match_when": {}, "step_names": steps}]

    primary_field = variable_fields[0]

    # Collect distinct values of the primary field across known combo keys.
    primary_values: dict[str, str] = {}  # primary_value → first matching combo_key
    for ck in known_combo_keys:
        if ck == "__default__":
            continue
        parts = ck.split("|")
        if parts:
            pv = parts[0]
            if pv not in primary_values:
                primary_values[pv] = ck

    templates = []
    for pv, representative_key in primary_values.items():
        step_names = [
            name for name in step_order
            if (matrix_by_step_name.get(name) or {}).get(representative_key, 0) > 0
        ]
        templates.append({
            "match_when": {primary_field: pv},
            "step_names": step_names,
        })

    return templates


# ── Step 4 helpers ────────────────────────────────────────────────────────────

async def _update_product_dates_from_work(
    session_id: str,
    inserted_products: list,
    max_end_by_product_id: dict[str, str] | None = None,
) -> None:
    """
    For earliest_ship: set target_release_date on each product to the last work
    end date for that product's assets.

    max_end_by_product_id: pre-computed {product_id: end_date_str} from
    expand_and_insert_work — avoids a DB round-trip that would be capped by
    PostgREST's row limit on large scenarios.
    """
    if max_end_by_product_id is None:
        # Legacy fallback: derive from DB (subject to PostgREST row-limit cap).
        import asyncio as _aio
        assets_r, work_r = await _aio.gather(
            db_client.get(
                _url("/rest/v1/scenario_assets"),
                params={"session_id": f"eq.{session_id}", "select": "id,product_id", "limit": "100000"},
                headers=_headers(),
            ),
            db_client.get(
                _url("/rest/v1/scenario_work"),
                params={"session_id": f"eq.{session_id}", "select": "asset_id,end_date", "limit": "100000"},
                headers=_headers(),
            ),
        )
        product_by_asset: dict[str, str] = {}
        for a in (assets_r.json() if assets_r.is_success else []):
            product_by_asset[a["id"]] = a["product_id"]

        max_end_by_product_id = {}
        for w in (work_r.json() if work_r.is_success else []):
            pid = product_by_asset.get(w.get("asset_id"))
            ed  = w.get("end_date")
            if pid and ed:
                if pid not in max_end_by_product_id or ed > max_end_by_product_id[pid]:
                    max_end_by_product_id[pid] = ed

    for p in inserted_products:
        pid = p["id"]
        release_date = max_end_by_product_id.get(pid)
        if not release_date:
            continue
        await db_client.patch(
            _url("/rest/v1/scenario_products"),
            params={"id": f"eq.{pid}"},
            json={"target_release_date": release_date},
            headers=_headers({"Prefer": "return=minimal"}),
        )
