"""
Unit test for lib/estimate/projector.project — the granularity IP-exposure boundary
(vendor-estimate-share plan §3.5, §6.5).

Asserts that each granularity emits strictly what it is allowed to:
  asset_total   → total only, no breakdown (no step or craft detail)
  craft_bucket  → breakdown by craft, summed; step NAMES must not leak
  workflow_step → breakdown by step name

Pure function — no DB.  Usage: python scripts/test_projector.py  (exit 0 = pass, 1 = fail)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lib.estimate.projector import project

EFF = [
    {"workflow_step_id": "s1", "variable_values": {"Type": "Axe"},   "estimate_days": 5, "source": "base"},
    {"workflow_step_id": "s2", "variable_values": {"Type": "Axe"},   "estimate_days": 3, "source": "base"},
    {"workflow_step_id": "s1", "variable_values": {"Type": "Sword"}, "estimate_days": 8, "source": "override"},
]
STEPS = {
    "s1": {"id": "s1", "name": "Model",   "craft": "Modeling"},
    "s2": {"id": "s2", "name": "Texture", "craft": "Texturing"},
}
VF = ["Type"]
VENDOR = {"id": "v1", "handle": "acme", "name": "Acme"}


def _profile(snap, type_val):
    for p in snap["profiles"]:
        if p["variable_values"].get("Type") == type_val:
            return p
    return None


def main():
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # asset_total: totals only, no breakdown anywhere.
    at = project(EFF, STEPS, VF, "asset_total", VENDOR, "L1")
    axe = _profile(at, "Axe")
    check(axe["total_days"] == 8, f"asset_total: Axe total should be 8, got {axe['total_days']}")
    check(all("breakdown" not in p for p in at["profiles"]), "asset_total: no profile may carry a breakdown")
    check(at["granularity"] == "asset_total" and at["unit"] == "days", "asset_total: header fields")

    # craft_bucket: labels are crafts, summed; step names must NOT appear.
    cb = project(EFF, STEPS, VF, "craft_bucket", VENDOR, "L1")
    axe = _profile(cb, "Axe")
    labels = {b["label"] for b in axe["breakdown"]}
    check(labels == {"Modeling", "Texturing"}, f"craft_bucket: Axe labels should be crafts, got {labels}")
    days_by = {b["label"]: b["days"] for b in axe["breakdown"]}
    check(days_by.get("Modeling") == 5 and days_by.get("Texturing") == 3, "craft_bucket: craft sums")
    all_labels = {b["label"] for p in cb["profiles"] for b in p["breakdown"]}
    check(not ({"Model", "Texture"} & all_labels), "craft_bucket: step NAMES must not leak as labels")

    # workflow_step: labels are step names.
    ws = project(EFF, STEPS, VF, "workflow_step", VENDOR, "L1")
    axe = _profile(ws, "Axe")
    labels = {b["label"] for b in axe["breakdown"]}
    check(labels == {"Model", "Texture"}, f"workflow_step: Axe labels should be step names, got {labels}")

    if failures:
        print("FAIL:")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("OK: projector exposure boundary (asset_total / craft_bucket / workflow_step)")


if __name__ == "__main__":
    main()
