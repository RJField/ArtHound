"""
Three-pass Sonnet generation for scenario planning.
Called by _scenario_generation_loop in main.py — never from a request handler.

Pass 1a: products only (tiny output)
Pass 1b: asset distribution spec — counts per profile per product, not individual assets
Pass 2:  work template per asset profile — one set of steps per type, not per asset

Server-side expansion converts specs into individual rows and computes scheduled dates.
This approach scales to any reasonable scenario size without hitting token limits.
"""
import json
import logging
import math
import os
from datetime import date, timedelta

import anthropic

from lib.db import db_client, _url, _headers
from lib.scenario.context import _build_matrix_section, _combo_key, _topo_sort

log = logging.getLogger(__name__)

_MODEL = "claude-sonnet-4-6"


_PASS1A_SYSTEM = """\
You are a production schedule generator for a game studio. Generate the product \
(release) structure only — no assets, no work items.

RULES:
- Product names should reflect the release structure implied by the cadence.
- target_release_date must be a valid YYYY-MM-DD date within the planning horizon from today.
- Return ONLY valid JSON — no prose, no markdown fences.
"""

_PASS1B_SYSTEM = """\
You are a production schedule generator for a game studio. Given an asset scale and \
classification matrix, map each scale category to one or more asset classification \
profiles and assign total counts.

RULES:
- Use only profiles that appear in the matrix.
- variable_values keys and values must exactly match the matrix.
- The sum of total_count across all profiles must equal the scale totals.
- Return ONLY valid JSON — no prose, no markdown fences.
"""

_PASS2_SYSTEM = """\
You are a production schedule generator for a game studio. Given a list of asset \
types and workflow steps, determine which steps each asset type goes through and \
in what order.

RULES:
- Use ONLY the exact step names listed in the matrix.
- One template per distinct value of the PRIMARY variable field (first field listed).
- Only include steps that have a non-zero estimate for that asset type.
- List steps in production order (dependencies first).
- Return ONLY valid JSON — no prose, no markdown fences.
"""

_REPAIR_SYSTEM = """\
You are correcting step names in work templates. Replace each invalid step_name \
with the closest valid step name from the provided list. Return ONLY the corrected \
JSON — no prose, no markdown fences.
"""


async def run_generation(session_id: str, studio_id: str, scope: dict) -> None:
    """
    Entry point called by _scenario_generation_loop.
    Raises on failure — caller is responsible for setting generation_failed.
    """
    # Clear any data from previous (failed) attempts before generating fresh.
    await _rollback(session_id)

    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    matrix_section = await _build_matrix_section(studio_id)
    valid_steps, variable_fields, known_combo_keys, step_order, matrix_by_step_name, craft_by_step_name = await _fetch_validation_data(studio_id)

    # ── Pass 1a: products ─────────────────────────────────────────────────────
    log.info("Scenario %s — pass 1a (products)", session_id)
    p1a = await client.messages.create(
        model=_MODEL, max_tokens=4096, system=_PASS1A_SYSTEM,
        messages=[{"role": "user", "content": _prompt_1a(scope)}],
    )
    p1a_data = _parse_json(p1a.content[0].text.strip(), "pass 1a")
    inserted_products = await _insert_products(session_id, studio_id, p1a_data.get("products", []))

    # ── Pass 1b: profile totals (O(profiles), not O(products×profiles)) ──────
    log.info("Scenario %s — pass 1b (profile totals)", session_id)
    p1b = await client.messages.create(
        model=_MODEL, max_tokens=2048, system=_PASS1B_SYSTEM,
        messages=[{"role": "user", "content": _prompt_1b(scope, matrix_section, variable_fields)}],
    )
    p1b_data = _parse_json(p1b.content[0].text.strip(), "pass 1b")
    profiles = p1b_data.get("profiles", [])
    # Normalize keys (AI may abbreviate field names like "Team (from Product)" → "Team").
    for p in profiles:
        p["variable_values"] = _normalize_vv_keys(p.get("variable_values") or {}, variable_fields)
    _validate_profiles(profiles, variable_fields, known_combo_keys)
    asset_rows = await _expand_and_insert_assets(session_id, studio_id, profiles, inserted_products, variable_fields, scope)

    # ── Pass 2: work templates per profile ────────────────────────────────────
    log.info("Scenario %s — pass 2 (work templates)", session_id)
    p2_prompt = _prompt_2(scope, matrix_section, variable_fields)
    p2 = await client.messages.create(
        model=_MODEL, max_tokens=4096, system=_PASS2_SYSTEM,
        messages=[{"role": "user", "content": p2_prompt}],
    )
    log.info("Scenario %s — pass 2 stop_reason=%s content_blocks=%d input_tokens=%s output_tokens=%s",
             session_id, p2.stop_reason, len(p2.content),
             getattr(p2.usage, "input_tokens", "?"), getattr(p2.usage, "output_tokens", "?"))
    p2_block = p2.content[0] if p2.content else None
    p2_block_type = type(p2_block).__name__ if p2_block else "none"
    p2_raw = getattr(p2_block, "text", None)
    log.info("Scenario %s — pass 2 block_type=%s raw_len=%s raw_preview=%r",
             session_id, p2_block_type, len(p2_raw) if p2_raw else 0, (p2_raw or "")[:120])
    p2_text = (p2_raw or "").strip()
    if not p2_text or p2.stop_reason == "max_tokens":
        log.warning("Scenario %s — pass 2 empty/truncated (stop_reason=%s output_tokens=%s), retrying",
                    session_id, p2.stop_reason, getattr(p2.usage, "output_tokens", "?"))
        p2 = await client.messages.create(
            model=_MODEL, max_tokens=4096, system=_PASS2_SYSTEM,
            messages=[{"role": "user", "content": p2_prompt}],
        )
        p2_block = p2.content[0] if p2.content else None
        p2_raw = getattr(p2_block, "text", None)
        p2_text = (p2_raw or "").strip()
        log.info("Scenario %s — pass 2 retry stop_reason=%s raw_len=%s raw_preview=%r",
                 session_id, p2.stop_reason, len(p2_raw) if p2_raw else 0, (p2_raw or "")[:120])
    p2_data = _parse_json(p2_text, "pass 2")
    templates = p2_data.get("templates", [])

    # Validate and repair step names (step_names is now a flat list of strings).
    all_step_names = [n for t in templates for n in t.get("step_names", [])]
    bad_names = [n for n in all_step_names if n not in valid_steps]
    if bad_names:
        log.warning("Scenario %s — repairing %d invalid step names", session_id, len(bad_names))
        templates = await _repair_templates(client, templates, sorted(valid_steps))
        still_bad = [n for t in templates for n in t.get("step_names", []) if n not in valid_steps]
        if still_bad:
            await _rollback(session_id)
            raise ValueError(f"Step name repair failed: {still_bad[:5]}")

    await _expand_and_insert_work(
        session_id, studio_id, asset_rows, templates, inserted_products,
        scope, step_order, variable_fields, matrix_by_step_name, craft_by_step_name,
    )
    log.info("Scenario %s — generation complete", session_id)


# ── Prompt builders ───────────────────────────────────────────────────────────

def _prompt_1a(scope: dict) -> str:
    horizon     = scope.get("horizon_months", 6)
    cadence     = scope.get("release_cadence", "regular_releases")
    constraints = scope.get("constraints") or []
    c_str = ("\nConstraints:\n" + "\n".join(f"- {c}" for c in constraints)) if constraints else ""
    today = date.today().isoformat()
    return f"""Today: {today}
Planning horizon: {horizon} months
Release cadence: {cadence}{c_str}

Generate the product/release list as JSON:
{{"products": [{{"name": "...", "target_release_date": "YYYY-MM-DD"}}]}}

RULES:
- Product names must be ≤20 characters (e.g. "Patch 1.0", "v2.3 Launch").
- Space releases evenly across the horizon.
- Return ONLY the JSON object — no prose, no markdown."""


def _prompt_1b(scope: dict, matrix_section: str, variable_fields: list) -> str:
    scale        = scope.get("scale") or {}
    constraints  = scope.get("constraints") or []
    c_str = ("\nConstraints:\n" + "\n".join(f"- {c}" for c in constraints)) if constraints else ""
    scale_str = ", ".join(f"{k}: {v} total" for k, v in scale.items()) or "unspecified"
    fields_json = json.dumps(variable_fields)

    return f"""{matrix_section}

SCALE REQUIRED: {scale_str}{c_str}

Map the scale categories to classification profiles and assign total counts for the \
full planning horizon. Do NOT distribute per-product — only give totals.

Return JSON:
{{
  "profiles": [
    {{"variable_values": {{}}, "total_count": 65, "priority": "High"}}
  ]
}}

CRITICAL RULES:
- variable_values keys must be EXACTLY these strings (copy verbatim): {fields_json}
- variable_values values must exactly match a profile in the matrix.
- total_count is the total number of assets of this profile across the entire horizon.
- The totals must match the scale numbers above.
- priority is a label for within-product scheduling priority."""


def _prompt_2(scope: dict, matrix_section: str, variable_fields: list) -> str:
    primary_field = variable_fields[0] if variable_fields else "type"
    return f"""{matrix_section}

For each distinct value of "{primary_field}", list which workflow steps apply to it \
and in what production order.

Return JSON:
{{
  "templates": [
    {{
      "match_when": {{"{primary_field}": "<asset type value>"}},
      "step_names": ["Step A", "Step B", "Step C"]
    }}
  ]
}}

CRITICAL RULES:
- One template per distinct value of "{primary_field}".
- match_when key must be EXACTLY "{primary_field}" (copy verbatim including any parentheses).
- step_names must use EXACT step names from the matrix — copy character-for-character.
- Only include steps that have a non-zero estimate for that asset type.
- Order step_names by production dependency (earlier steps first)."""


# ── Key normalization ─────────────────────────────────────────────────────────

def _normalize_vv_keys(vv: dict, variable_fields: list[str]) -> dict:
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
    used = set()
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


# ── Validation ────────────────────────────────────────────────────────────────

def _validate_profiles(profiles: list, variable_fields: list, known_combo_keys: set) -> None:
    for p in profiles:
        vv = p.get("variable_values") or {}
        if variable_fields and set(vv.keys()) != set(variable_fields):
            raise ValueError(f"Profile variable_values keys {list(vv.keys())} don't match {variable_fields}")
        key = _combo_key(vv, variable_fields)
        if key not in known_combo_keys:
            raise ValueError(f"Profile '{key}' not in estimate matrix")


# ── Insert helpers ────────────────────────────────────────────────────────────

async def _insert_products(session_id: str, studio_id: str, products: list) -> list:
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


async def _expand_and_insert_assets(
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

        counts = _distribute_counts(total, n_products, distribution_shape)
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


async def _expand_and_insert_work(
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
) -> None:
    # Build product release date lookup.
    product_release: dict[str, date] = {}
    for p in inserted_products:
        rd = p.get("target_release_date")
        if rd:
            try:
                product_release[p["id"]] = date.fromisoformat(rd)
            except ValueError:
                product_release[p["id"]] = date.today() + timedelta(days=30)

    horizon_start = date.today()

    # Group assets by product for scheduling.
    assets_by_product: dict[str, list] = {}
    for a in asset_rows:
        assets_by_product.setdefault(a["product_id"], []).append(a)

    payload = []
    for pid, p_assets in assets_by_product.items():
        release = product_release.get(pid, date.today() + timedelta(days=30))

        for asset in p_assets:
            vv = asset.get("variable_values") or {}
            combo_key = _combo_key(vv, variable_fields)
            template = _find_matching_template(vv, templates)
            if not template:
                continue

            # Resolve step names to ordered dicts with estimates from the matrix.
            step_name_list = template.get("step_names", [])
            ordered_names = _sort_step_names(step_name_list, step_order)
            steps = []
            for name in ordered_names:
                days = (matrix_by_step_name.get(name) or {}).get(combo_key) or 1
                steps.append({
                    "step_name":    name,
                    "craft":        craft_by_step_name.get(name),
                    "estimate_days": days,
                })

            work_items = _schedule_steps(steps, release, horizon_start)
            for w in work_items:
                payload.append({
                    "session_id":   session_id,
                    "studio_id":    studio_id,
                    "asset_id":     asset["id"],
                    "step_name":    w["step_name"],
                    "craft":        w.get("craft"),
                    "estimate_days": w.get("estimate_days"),
                    "start_date":   w["start_date"],
                    "end_date":     w["end_date"],
                })

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


# ── Distribution ─────────────────────────────────────────────────────────────

def _distribute_counts(total: int, n: int, shape: str) -> list[int]:
    """Distribute `total` assets across `n` products according to `shape`."""
    if n == 1:
        return [total]

    if shape == "even":
        base, rem = divmod(total, n)
        return [base + (1 if i < rem else 0) for i in range(n)]

    if shape == "front_loaded":
        # Linear weights: product 0 gets n shares, product n-1 gets 1 share.
        weights = list(range(n, 0, -1))

    elif shape == "back_loaded":
        weights = list(range(1, n + 1))

    elif shape == "milestone_batched":
        # Spike every ~quarter of the timeline; rest get minimal.
        milestones = {int(n * f) for f in (0.25, 0.5, 0.75, 1.0)}
        milestones = {min(m, n - 1) for m in milestones}
        weights = [10 if i in milestones else 1 for i in range(n)]

    else:
        base, rem = divmod(total, n)
        return [base + (1 if i < rem else 0) for i in range(n)]

    total_weight = sum(weights)
    counts = [int(total * w / total_weight) for w in weights]
    # Distribute rounding remainder to the largest-weighted buckets.
    diff = total - sum(counts)
    order = sorted(range(n), key=lambda i: weights[i], reverse=True)
    for i in range(diff):
        counts[order[i % n]] += 1
    return counts


# ── Scheduling ────────────────────────────────────────────────────────────────

def _sort_step_names(step_names: list[str], step_order: list[str]) -> list[str]:
    """Sort a flat list of step name strings by the studio's workflow step order."""
    order_index = {name: i for i, name in enumerate(step_order)}
    return sorted(step_names, key=lambda n: order_index.get(n, 999))


def _find_matching_template(vv: dict, templates: list) -> dict | None:
    """Return the first template whose match_when is a subset of the asset's variable_values."""
    for t in templates:
        match_when = t.get("match_when") or {}
        if all(vv.get(k) == v for k, v in match_when.items()):
            return t
    return templates[0] if templates else None


def _schedule_steps(steps: list, release: date, horizon_start: date) -> list:
    """
    Schedule steps so the last one ends on or before release.
    Simple linear chain: each step follows the previous one.
    """
    total_days = sum(max(int(s.get("estimate_days") or 0), 1) for s in steps)
    chain_start = release - timedelta(days=total_days)
    # Don't schedule before the horizon starts.
    chain_start = max(chain_start, horizon_start)

    result = []
    cursor = chain_start
    for s in steps:
        days = max(int(s.get("estimate_days") or 1), 1)
        end = cursor + timedelta(days=days - 1)
        result.append({
            "step_name":    s["step_name"],
            "craft":        s.get("craft"),
            "estimate_days": days,
            "start_date":   cursor.isoformat(),
            "end_date":     end.isoformat(),
        })
        cursor = end + timedelta(days=1)
    return result



# ── Repair ────────────────────────────────────────────────────────────────────

async def _repair_templates(client, templates: list, valid_steps: list[str]) -> list:
    prompt = (
        f"Valid step names: {json.dumps(valid_steps)}\n\n"
        f"Templates to correct: {json.dumps(templates)}\n\n"
        "Return the corrected templates JSON array. Each template has a step_names array. "
        "Replace every invalid string in step_names with the closest valid step name from the list."
    )
    r = await client.messages.create(
        model=_MODEL, max_tokens=4096, system=_REPAIR_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse_json(r.content[0].text.strip(), "repair")


# ── DB / validation helpers ───────────────────────────────────────────────────

async def _fetch_validation_data(studio_id: str):
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

    # Build step_name → combo_key → estimate_days lookup for server-side expansion.
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

    return valid_steps, variable_fields, known_combo_keys, step_order, matrix_by_step_name, craft_by_step_name


async def _rollback(session_id: str) -> None:
    log.warning("Scenario %s — rolling back", session_id)
    await db_client.delete(
        _url("/rest/v1/scenario_products"),
        params={"session_id": f"eq.{session_id}"},
        headers=_headers(),
    )


def _parse_json(text: str, label: str):
    if not text:
        raise ValueError(f"Scenario {label} returned an empty response")
    if text.startswith("```"):
        lines = text.splitlines()
        inner = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:]).strip()
        text = inner if inner else text
    if not text:
        raise ValueError(f"Scenario {label} returned an empty response")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"Scenario {label} returned invalid JSON: {e}") from e


def _chunk(lst: list, size: int):
    for i in range(0, len(lst), size):
        yield lst[i:i + size]
