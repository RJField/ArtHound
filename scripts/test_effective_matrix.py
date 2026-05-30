"""
Unit test for lib/estimate/effective.resolve_effective_matrix (base ⊕ override overlay).

Stubs the DB fetch so the overlay logic is tested as a pure function — no DB needed.

Usage:
    python scripts/test_effective_matrix.py

Exit 0 = all assertions pass. Exit 1 = a failure.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import lib.estimate.effective as eff

BASE = [
    {"workflow_step_id": "s1", "variable_values": {"Type": "Axe"},   "estimate_days": 5},
    {"workflow_step_id": "s1", "variable_values": {"Type": "Sword"}, "estimate_days": 7},
    {"workflow_step_id": "s2", "variable_values": {},                "estimate_days": 3},
]
OVR = [
    {"workflow_step_id": "s1", "variable_values": {"Type": "Axe"}, "estimate_days": 9},  # overrides a base cell
    {"workflow_step_id": "s3", "variable_values": {"Type": "Bow"}, "estimate_days": 2},  # override with no base
]


async def _fake_fetch(owner_col, owner_id, link_filter):
    # resolver passes "is.null" for base rows, "eq.<link>" for overrides
    return list(OVR) if link_filter.startswith("eq.") else list(BASE)


def _cell(rows, step, vv):
    for r in rows:
        if r["workflow_step_id"] == step and eff.vv_key(r["variable_values"]) == eff.vv_key(vv):
            return r
    return None


def main():
    eff._fetch_cells = _fake_fetch
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # 1. No link → base only, every cell source 'base', values untouched.
    base = asyncio.run(eff.resolve_effective_matrix("vendor_id", "v1", None))
    check(len(base) == 3, f"base: expected 3 rows, got {len(base)}")
    check(all(r["source"] == "base" for r in base), "base: every cell should be source=base")
    check(_cell(base, "s1", {"Type": "Axe"})["estimate_days"] == 5, "base: s1/Axe should be 5")

    # 2. With link → override wins on its cell; non-overridden cells stay base; orphan override included.
    eff_rows = asyncio.run(eff.resolve_effective_matrix("vendor_id", "v1", "L1"))
    check(len(eff_rows) == 4, f"effective: expected 4 rows (3 base + 1 orphan override), got {len(eff_rows)}")

    axe = _cell(eff_rows, "s1", {"Type": "Axe"})
    check(axe["estimate_days"] == 9 and axe["source"] == "override",
          f"effective: s1/Axe should be 9/override, got {axe['estimate_days']}/{axe['source']}")

    sword = _cell(eff_rows, "s1", {"Type": "Sword"})
    check(sword["estimate_days"] == 7 and sword["source"] == "base",
          "effective: s1/Sword should stay 7/base")

    default = _cell(eff_rows, "s2", {})
    check(default["estimate_days"] == 3 and default["source"] == "base",
          "effective: s2/default should stay 3/base")

    bow = _cell(eff_rows, "s3", {"Type": "Bow"})
    check(bow is not None and bow["estimate_days"] == 2 and bow["source"] == "override",
          "effective: orphan override s3/Bow should be present as 2/override")

    if failures:
        print("FAIL:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("OK: resolve_effective_matrix overlay logic (6 assertions across base + per-link cases)")


if __name__ == "__main__":
    main()
