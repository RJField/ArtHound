import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query

from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()

_STANDARD_SLOTS = frozenset({
    "name", "dev_name", "item_type", "priority", "product",
    "project_date", "status", "asset_number",
})

_DISPLAY_KEYS = ("name", "label", "displayName", "value", "title")


def _extract_str(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, dict):
        for key in _DISPLAY_KEYS:
            if v.get(key):
                return str(v[key])
        return None
    if isinstance(v, list):
        if not v:
            return None
        first = v[0]
        if isinstance(first, dict):
            for key in _DISPLAY_KEYS:
                if first.get(key):
                    return str(first[key])
            return None
        return str(first) if first is not None else None
    return str(v)


async def _get_mapping_data(studio_id: str) -> tuple[dict, dict, dict]:
    """
    Return (slot_to_field, field_to_bucket, field_to_tier) from source_field_mappings.

    slot_to_field:   {arthound_slot: source_field_name}
    field_to_bucket: {source_field_name: meta_bucket}
    field_to_tier:   {source_field_name: display_tier}
    """
    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={"owner_type": "eq.studio", "owner_id": f"eq.{studio_id}", "select": "mappings"},
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        return {}, {}, {}
    mappings = r.json()[0].get("mappings") or []
    slot_to_field = {
        m["arthound_slot"]: m["source_field_name"]
        for m in mappings
        if m.get("arthound_slot") and m.get("source_field_name")
    }
    field_to_bucket = {
        m["source_field_name"]: m.get("meta_bucket", "custom")
        for m in mappings if m.get("source_field_name")
    }
    field_to_tier = {
        m["source_field_name"]: m.get("display_tier", "secondary")
        for m in mappings if m.get("source_field_name")
    }
    return slot_to_field, field_to_bucket, field_to_tier


async def _get_slot_field_names(studio_id: str) -> dict[str, str]:
    slot_to_field, _, _ = await _get_mapping_data(studio_id)
    return slot_to_field


@router.get("/fields")
async def get_fields(
    bucket: str | None = Query(None, description="Filter by meta_bucket (e.g. production, technical)"),
    include_native: bool = Query(False, description="Include source_native fields (hidden by default)"),
    current_user: CurrentUser = Depends(require_studio),
):
    """Return source field names available on replicated_assets for this studio.

    source_native fields are excluded by default. Use include_native=true to see them.
    Use bucket= to filter to a specific category.
    """
    studio_id = current_user.studio_id
    slot_to_field, field_to_bucket, field_to_tier = await _get_mapping_data(studio_id)

    r_assets = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={"owner_type": "eq.studio", "owner_id": f"eq.{studio_id}", "select": "meta", "limit": "500"},
        headers=_headers(),
    )
    meta_keys: set = set()
    for row in (r_assets.json() if r_assets.is_success else []):
        meta_keys.update((row.get("meta") or {}).keys())

    all_names = set(slot_to_field.values()) | meta_keys

    fields = []
    for name in sorted(all_names):
        field_bucket = field_to_bucket.get(name, "custom")
        field_tier   = field_to_tier.get(name, "secondary")
        if not include_native and field_bucket == "source_native":
            continue
        if not include_native and field_tier == "hidden":
            continue
        if bucket and field_bucket != bucket:
            continue
        fields.append({
            "id":     name,
            "name":   name,
            "type":   "text",
            "bucket": field_bucket,
            "tier":   field_tier,
        })
    return {"fields": fields}


@router.get("/field-values")
async def get_field_values(field: str = Query(...), current_user: CurrentUser = Depends(require_studio)):
    """Return distinct values for a source field name from replicated_assets."""
    studio_id = current_user.studio_id
    slot_fields = await _get_slot_field_names(studio_id)
    fn_to_slot = {v: k for k, v in slot_fields.items()}
    slot = fn_to_slot.get(field)

    seen: dict = {}

    if slot in _STANDARD_SLOTS:
        r = await db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={
                "owner_type": "eq.studio",
                "owner_id":   f"eq.{studio_id}",
                "select":     slot,
                slot:         "not.is.null",
                "limit":      "10000",
            },
            headers=_headers(),
        )
        for row in (r.json() if r.is_success else []):
            v = row.get(slot)
            if v is not None:
                seen[str(v)] = str(v)
    else:
        r = await db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={
                "owner_type": "eq.studio",
                "owner_id":   f"eq.{studio_id}",
                "select":     "meta",
                "limit":      "10000",
            },
            headers=_headers(),
        )
        for row in (r.json() if r.is_success else []):
            raw = (row.get("meta") or {}).get(field)
            if raw is None:
                continue
            items = raw if isinstance(raw, list) else [raw]
            for item in items:
                s = _extract_str(item)
                if s:
                    seen[s] = s

    values = [{"id": k, "name": k} for k in sorted(seen.keys())]
    return {"field": field, "type": "text", "values": values}


@router.get("/asset-combinations")
async def get_asset_combinations(field: List[str] = Query(default=[]), current_user: CurrentUser = Depends(require_studio)):
    """Return combination counts across assets for the given source field names."""
    field_names = [f.strip() for f in field if f.strip()]
    if not field_names:
        raise HTTPException(status_code=400, detail="at least one field param required")

    studio_id = current_user.studio_id
    slot_fields = await _get_slot_field_names(studio_id)
    fn_to_slot = {v: k for k, v in slot_fields.items()}

    std_cols = {fn_to_slot[f] for f in field_names if fn_to_slot.get(f) in _STANDARD_SLOTS}
    select_cols = ",".join({"meta"} | std_cols)

    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "owner_type": "eq.studio",
            "owner_id":   f"eq.{studio_id}",
            "select":     select_cols,
            "limit":      "10000",
        },
        headers=_headers(),
    )

    def _val(row, fname):
        slot = fn_to_slot.get(fname)
        v = row.get(slot) if slot in _STANDARD_SLOTS else (row.get("meta") or {}).get(fname)
        return _extract_str(v)

    combo_counts: dict = {}
    for row in (r.json() if r.is_success else []):
        combo: dict = {}
        complete = True
        for fname in field_names:
            val = _val(row, fname)
            if val is None:
                complete = False
                break
            combo[fname] = val
        if not complete:
            continue
        key = "\x00".join(combo[f] for f in field_names)
        if key in combo_counts:
            combo_counts[key]["count"] += 1
        else:
            combo_counts[key] = {"values": combo, "count": 1}

    combinations = sorted(
        combo_counts.values(),
        key=lambda x: tuple(x["values"].get(f, "") for f in field_names),
    )
    return {"combinations": combinations}
