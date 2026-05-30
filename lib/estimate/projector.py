"""
Estimate-share projection (vendor-estimate-share plan §3.5, §4.4, §6.5).

Collapses a vendor's effective matrix (per workflow_step × profile) into a frozen, self-describing
snapshot at the chosen granularity. The granularity is the IP-exposure boundary — this function is
the *only* thing that decides how much vendor process detail reaches the studio, so it must emit
strictly what the granularity permits:

    asset_total   → per-profile total only; NO breakdown (no step or craft detail).
    craft_bucket  → breakdown grouped by craft (step estimates summed within each craft); no names.
    workflow_step → breakdown per step, labelled with the step name (explicit detail disclosure).

Pure function (aside from generated_at) so the exposure rule is unit-testable without a DB.
"""
import datetime

from lib.estimate.effective import vv_key

GRANULARITIES = ("asset_total", "craft_bucket", "workflow_step")
_NO_CRAFT = "Other"


def project(
    effective_matrix: list[dict],
    step_by_id: dict[str, dict],
    variable_fields: list[str],
    granularity: str,
    vendor: dict,
    link_id: str,
) -> dict:
    if granularity not in GRANULARITIES:
        raise ValueError(f"Unknown granularity: {granularity!r}")

    # Group effective cells by profile (variable_values).
    profiles: dict[str, dict] = {}
    for cell in effective_matrix:
        k = vv_key(cell.get("variable_values"))
        p = profiles.setdefault(k, {"variable_values": cell.get("variable_values") or {}, "cells": []})
        p["cells"].append((cell["workflow_step_id"], cell.get("estimate_days") or 0))

    out_profiles: list[dict] = []
    for p in profiles.values():
        total = sum(days for _, days in p["cells"])
        entry: dict = {"variable_values": p["variable_values"], "total_days": total}

        if granularity == "craft_bucket":
            buckets: dict[str, float] = {}
            for step_id, days in p["cells"]:
                craft = (step_by_id.get(step_id) or {}).get("craft") or _NO_CRAFT
                buckets[craft] = buckets.get(craft, 0) + days
            entry["breakdown"] = [{"label": c, "days": d} for c, d in sorted(buckets.items())]

        elif granularity == "workflow_step":
            entry["breakdown"] = [
                {"label": (step_by_id.get(step_id) or {}).get("name") or step_id, "days": days}
                for step_id, days in p["cells"]
            ]
        # asset_total: no breakdown key at all.

        out_profiles.append(entry)

    return {
        "schema_version": 1,
        "vendor": {"id": vendor.get("id"), "handle": vendor.get("handle"), "name": vendor.get("name")},
        "link_id": link_id,
        "granularity": granularity,
        "variable_fields": variable_fields,
        "unit": "days",
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "profiles": out_profiles,
    }
