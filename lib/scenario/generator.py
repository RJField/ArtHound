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
import os
from datetime import date

import anthropic

from lib.scenario.context import _build_matrix_section, _combo_key
from lib.scenario.shared import (
    fetch_validation_data,
    insert_products,
    expand_and_insert_assets,
    expand_and_insert_work,
    rollback,
    set_generation_status,
    normalize_vv_keys,
    normalize_profile_counts,
    validate_profiles,
    sort_step_names,
    distribute_counts,
    schedule_steps,
    _find_matching_template,
    _chunk,
)

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


async def _json_call(client, *, system: str, prompt: str, max_tokens: int, prefill: str = "{") -> str:
    msg = await client.messages.create(
        model=_MODEL, max_tokens=max_tokens, system=system,
        messages=[{"role": "user", "content": prompt}],
    )
    text = msg.content[0].text if msg.content else ""
    log.debug("_json_call raw response (first 500): %s", text[:500])
    return text


async def run_generation(session_id: str, studio_id: str, scope: dict) -> None:
    """
    Entry point called by _scenario_generation_loop.
    Raises on failure — caller is responsible for setting generation_failed.
    """
    await rollback(session_id)

    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    matrix_section = await _build_matrix_section(studio_id)
    valid_steps, variable_fields, known_combo_keys, step_order, matrix_by_step_name, craft_by_step_name, dep_by_step_name = \
        await fetch_validation_data(studio_id)

    # ── Pass 1a: products ─────────────────────────────────────────────────────
    log.info("Scenario %s — pass 1a (products)", session_id)
    await set_generation_status(session_id, "Pass 1 of 3 — Generating products")
    p1a_text = await _json_call(client, system=_PASS1A_SYSTEM, prompt=_prompt_1a(scope), max_tokens=4096)
    p1a_data = _parse_json(p1a_text, "pass 1a")
    inserted_products = await insert_products(session_id, studio_id, p1a_data.get("products", []))

    # ── Pass 1b: profile totals (O(profiles), not O(products×profiles)) ──────
    log.info("Scenario %s — pass 1b (profile totals)", session_id)
    await set_generation_status(session_id, "Pass 2 of 3 — Building asset profiles")
    p1b_text = await _json_call(client, system=_PASS1B_SYSTEM, prompt=_prompt_1b(scope, matrix_section, variable_fields), max_tokens=2048)
    p1b_data = _parse_json(p1b_text, "pass 1b")
    profiles = p1b_data.get("profiles", [])
    for p in profiles:
        p["variable_values"] = normalize_vv_keys(p.get("variable_values") or {}, variable_fields)
    validate_profiles(profiles, variable_fields, known_combo_keys)
    profiles = normalize_profile_counts(profiles, scope, session_id)
    asset_rows = await expand_and_insert_assets(session_id, studio_id, profiles, inserted_products, variable_fields, scope)

    # ── Pass 2: work templates per profile ────────────────────────────────────
    log.info("Scenario %s — pass 2 (work templates)", session_id)
    await set_generation_status(session_id, "Pass 3 of 3 — Scheduling work")
    p2_text = await _json_call(client, system=_PASS2_SYSTEM, prompt=_prompt_2(scope, matrix_section, variable_fields), max_tokens=4096)
    p2_data = _parse_json(p2_text, "pass 2")
    templates = p2_data.get("templates", [])

    all_step_names = [n for t in templates for n in t.get("step_names", [])]
    bad_names = [n for n in all_step_names if n not in valid_steps]
    if bad_names:
        log.warning("Scenario %s — repairing %d invalid step names", session_id, len(bad_names))
        templates = await _repair_templates(client, templates, sorted(valid_steps))
        still_bad = [n for t in templates for n in t.get("step_names", []) if n not in valid_steps]
        if still_bad:
            await rollback(session_id)
            raise ValueError(f"Step name repair failed: {still_bad[:5]}")

    craft_caps = scope.get("craft_caps") or {}
    category   = scope.get("scenario_category", "target_date")
    max_end_by_product_id = await expand_and_insert_work(
        session_id, studio_id, asset_rows, templates, inserted_products,
        scope, step_order, variable_fields, matrix_by_step_name, craft_by_step_name,
        craft_caps=craft_caps or None,
        scenario_category=category,
        dep_by_step_name=dep_by_step_name,
    )

    if category == "earliest_ship":
        from lib.scenario.deterministic import _update_product_dates_from_work
        log.info("Scenario %s (AI, earliest_ship) — computing derived product release dates", session_id)
        await _update_product_dates_from_work(session_id, inserted_products, max_end_by_product_id)

    log.info("Scenario %s — generation complete", session_id)


# ── Prompt builders ───────────────────────────────────────────────────────────

def _prompt_1a(scope: dict) -> str:
    category     = scope.get("scenario_category", "target_date")
    horizon      = scope.get("horizon_months", 6)
    cadence      = scope.get("release_cadence", "regular_releases")
    num_products = scope.get("num_products")
    constraints  = scope.get("constraints") or []
    c_str = ("\nConstraints:\n" + "\n".join(f"- {c}" for c in constraints)) if constraints else ""
    today = date.today().isoformat()
    count_rule = (
        f"- You MUST generate EXACTLY {num_products} product(s) — no more, no fewer."
        if num_products else
        "- Infer the number of products from the cadence and horizon."
    )

    if category == "earliest_ship":
        return f"""Today: {today}
Release cadence: {cadence}
Number of products: {num_products if num_products else "infer from cadence"}{c_str}

SCENARIO MODE: earliest_ship — release dates will be computed by the scheduler after work is placed.
Set target_release_date to null for every product.

Generate the product/release list as JSON:
{{"products": [{{"name": "...", "target_release_date": null}}]}}

RULES:
{count_rule}
- Product names must be ≤20 characters (e.g. "Alpha", "Beta", "Gold").
- target_release_date MUST be null — do not invent a date.
- Return ONLY the JSON object — no prose, no markdown."""

    return f"""Today: {today}
Planning horizon: {horizon} months
Release cadence: {cadence}
Number of products: {num_products if num_products else "infer from cadence/horizon"}{c_str}

Generate the product/release list as JSON:
{{"products": [{{"name": "...", "target_release_date": "YYYY-MM-DD"}}]}}

RULES:
{count_rule}
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


# ── Repair ────────────────────────────────────────────────────────────────────

async def _repair_templates(client, templates: list, valid_steps: list[str]) -> list:
    prompt = (
        f"Valid step names: {json.dumps(valid_steps)}\n\n"
        f"Templates to correct: {json.dumps(templates)}\n\n"
        "Return the corrected templates JSON array. Each template has a step_names array. "
        "Replace every invalid string in step_names with the closest valid step name from the list."
    )
    text = await _json_call(client, system=_REPAIR_SYSTEM, prompt=prompt, max_tokens=4096, prefill="[")
    return _parse_json(text, "repair")


# ── JSON parsing ──────────────────────────────────────────────────────────────

def _parse_json(text: str, label: str):
    if not text:
        raise ValueError(f"Scenario {label} returned an empty response")

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    import re
    fence_match = re.search(r"```(?:json)?\s*\n([\s\S]*?)\n```", text)
    if fence_match:
        try:
            return json.loads(fence_match.group(1).strip())
        except json.JSONDecodeError:
            pass

    decoder = json.JSONDecoder()
    for ch in ('{', '['):
        idx = text.find(ch)
        if idx != -1:
            try:
                obj, _ = decoder.raw_decode(text, idx)
                return obj
            except json.JSONDecodeError:
                pass

    log.error("Scenario %s — unparseable response: %s", label, text[:800])
    raise ValueError(f"Scenario {label} returned no parseable JSON")


# Private aliases for any code that still imports these by underscore name.
_normalize_vv_keys        = normalize_vv_keys
_normalize_profile_counts = normalize_profile_counts
_validate_profiles        = validate_profiles
_fetch_validation_data    = fetch_validation_data
_insert_products          = insert_products
_expand_and_insert_assets = expand_and_insert_assets
_expand_and_insert_work   = expand_and_insert_work
_rollback                 = rollback
_sort_step_names          = sort_step_names
_distribute_counts        = distribute_counts
_schedule_steps           = schedule_steps
