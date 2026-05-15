"""
Scale-key fidelity gate — run BEFORE building the deterministic engine.

Tests that 10 varied phrasings of the same planning intent each produce
scope.scale keys that exactly match known matrix combo keys (after
_normalize_vv_keys normalisation).

Usage:
    STUDIO_ID=<uuid> python scripts/test_scoping_fidelity.py

Exit 0 = all 10 passed. Exit 1 = one or more mismatches (do not build yet).
"""

import asyncio
import json
import os
import sys

# Ensure the repo root is on the path so lib/ imports work.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import anthropic
from lib.db import db_client, _url, _headers
from lib.scenario.context import _build_matrix_section, _combo_key
from lib.scenario.generator import _normalize_vv_keys

_MODEL = "claude-haiku-4-5-20251001"

# ---------------------------------------------------------------------------
# 10 phrasings — varied ways to express the same intent using this studio's
# actual asset vocabulary: Banana (Should, Vendor 1), Spaceship (Should, Internal),
# Tank (Must, Vendor 2). Each is a standalone user turn answered with submit_scope.
# ---------------------------------------------------------------------------
_TEST_PHRASINGS = [
    "We need 30 Bananas done by Vendor 1, 20 Spaceships handled internally, and 10 Tanks for Vendor 2 over 6 months.",
    "Plan: 30 banana assets (vendor 1), 20 spaceship assets (internal team), 10 tank assets (vendor 2), 6-month horizon.",
    "Thirty Banana assets from Vendor 1, twenty Spaceships internal, ten Tanks via Vendor 2. Six months.",
    "Asset split: Banana x30 (Should, Vendor 1), Spaceship x20 (Should, Internal), Tank x10 (Must, Vendor 2).",
    "I have ~30 bananas for vendor 1, ~20 spaceships internal, and ~10 tanks for vendor 2. Timeline: half a year.",
    "Vendor 1 handles 30 banana assets; internal team does 20 spaceships; vendor 2 builds 10 tanks. 6 months.",
    "Production: 30 Banana (Vendor 1 / should), 20 Spaceship (internal / should), 10 Tank (Vendor 2 / must). 6-month plan.",
    "We're shipping: banana assets — 30, spaceships — 20, tanks — 10. Bananas go to V1, spaceships are internal, tanks to V2.",
    "Total: 30 banana (V1 vendor, should-priority), 20 spaceship (in-house, should-priority), 10 tank (V2 vendor, must-priority), 6mo.",
    "30 bananas outsourced to Vendor 1, 20 spaceships kept internal, 10 high-priority tanks for Vendor 2. Half-year plan.",
]

_SUBMIT_SCOPE_TOOL = {
    "name": "submit_scope",
    "description": "Call when you have enough info to generate the scenario.",
    "input_schema": {
        "type": "object",
        "required": ["horizon_months", "release_cadence", "num_products", "distribution", "scale"],
        "properties": {
            "horizon_months": {"type": "integer"},
            "release_cadence": {
                "type": "string",
                "enum": ["single_launch", "regular_releases", "milestone_batched", "continuous"],
            },
            "num_products": {"type": "integer"},
            "distribution": {
                "type": "string",
                "enum": ["even", "front_loaded", "back_loaded", "milestone_batched"],
            },
            "scale": {
                "type": "object",
                "description": (
                    "Exact asset count per classification profile. "
                    "Keys must use the exact profile labels shown in the matrix."
                ),
            },
            "constraints": {"type": "array", "items": {"type": "string"}},
        },
    },
}


async def _fetch_known_combo_keys(studio_id: str):
    cfg_r, matrix_r = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/estimate_config"),
            params={"studio_id": f"eq.{studio_id}", "select": "variable_fields"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/estimate_matrix"),
            params={
                "studio_id": f"eq.{studio_id}",
                "select": "variable_values",
                "limit": "10000",
            },
            headers=_headers(),
        ),
    )
    cfg_rows = cfg_r.json() if cfg_r.is_success else []
    variable_fields: list[str] = cfg_rows[0]["variable_fields"] if cfg_rows else []

    matrix_rows = matrix_r.json() if matrix_r.is_success else []
    known = {_combo_key(r.get("variable_values") or {}, variable_fields) for r in matrix_rows}
    return variable_fields, known


def _normalize_scale_key(k: str) -> str:
    """
    Normalise a scope.scale key to the bare-pipe combo key format used internally.
    The matrix section displays profiles as "Hero | High" (space-pipe-space) so the
    scoping agent returns keys in that format; combo keys use "Hero|High" (no spaces).
    This same normalization must be applied in the deterministic engine.
    """
    return k.replace(" | ", "|")


async def _run_one(client, system: str, phrasing: str, variable_fields: list[str]) -> dict:
    response = await client.messages.create(
        model=_MODEL,
        max_tokens=512,
        system=system,
        tools=[_SUBMIT_SCOPE_TOOL],
        tool_choice={"type": "tool", "name": "submit_scope"},
        messages=[{"role": "user", "content": phrasing}],
    )
    tool_block = next((b for b in response.content if b.type == "tool_use"), None)
    if not tool_block:
        return {}
    scope = tool_block.input
    raw_scale = scope.get("scale") or {}
    # Normalise display-format keys ("A | B" → "A|B") to internal combo key format.
    return {_normalize_scale_key(k): v for k, v in raw_scale.items()}


async def main():
    studio_id = os.environ.get("STUDIO_ID")
    if not studio_id:
        print("ERROR: set STUDIO_ID env var to your studio UUID")
        sys.exit(1)

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY not set")
        sys.exit(1)

    print(f"Studio: {studio_id}")
    variable_fields, known_keys = await _fetch_known_combo_keys(studio_id)
    print(f"Variable fields: {variable_fields}")
    print(f"Known combo keys: {sorted(known_keys)}")
    print()

    if not known_keys:
        print("ERROR: no matrix rows found — has the estimate matrix been set up for this studio?")
        sys.exit(1)

    matrix_section = await _build_matrix_section(studio_id)
    system = (
        "You are a production planning assistant. Call submit_scope immediately "
        "using the information provided.\n\n"
        + matrix_section
    )

    client = anthropic.AsyncAnthropic(api_key=api_key)

    passed = 0
    failed = 0
    for i, phrasing in enumerate(_TEST_PHRASINGS, 1):
        scale = await _run_one(client, system, phrasing, variable_fields)
        bad = [k for k in scale if k not in known_keys]
        if not scale:
            status = "FAIL (no scope returned)"
            failed += 1
        elif bad:
            status = f"FAIL — bad keys: {bad}  |  available: {sorted(known_keys)}"
            failed += 1
        else:
            status = f"PASS — {dict(scale)}"
            passed += 1
        print(f"[{i:02d}] {status}")
        print(f"      phrasing: {phrasing[:80]}")
        print()

    print(f"Result: {passed}/10 passed, {failed} failed")
    if failed:
        print("GATE FAILED — fix normalisation before building the deterministic engine.")
        sys.exit(1)
    else:
        print("GATE PASSED — safe to build the deterministic engine.")
        sys.exit(0)


if __name__ == "__main__":
    asyncio.run(main())
