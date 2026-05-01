import hashlib
import json

from lib.sync.connector import RawRecord, SchemaField

ARTHOUND_SLOTS = {
    "name", "dev_name", "item_type", "priority",
    "product", "project_date", "status", "asset_number",
}

# Case-insensitive aliases that auto-map to standard slots on first sync.
# The first alias is the canonical name; extras are common variations.
_SLOT_ALIASES: dict[str, list[str]] = {
    "name":         ["asset name", "name", "asset"],
    "dev_name":     ["dev name", "devname", "internal name", "dev", "development name"],
    "item_type":    ["item type", "itemtype", "type", "asset type"],
    "priority":     ["priority"],
    "product":      ["product", "project", "game", "title"],
    "project_date": ["project date", "due date", "delivery date", "target date", "date"],
    "status":       ["status", "state", "phase", "production status"],
    "asset_number": ["asset number", "asset #", "asset no", "number", "asset id"],
}

_NAME_TO_SLOT: dict[str, str] = {
    alias.lower(): slot
    for slot, aliases in _SLOT_ALIASES.items()
    for alias in aliases
}


def default_mappings_from_schema(schema_fields: list[SchemaField]) -> list[dict]:
    """
    Generate default slot mappings by matching source field names to ArtHound
    slot aliases. Saved on first sync so the user sees sensible pre-fills in the UI.
    Fields that don't match any alias get arthound_slot=null and land in meta.
    """
    mappings = []
    seen_slots: set[str] = set()

    for field in schema_fields:
        slot = _NAME_TO_SLOT.get(field.name.lower())
        if slot and slot in seen_slots:
            slot = None  # don't map two source fields to the same slot
        if slot:
            seen_slots.add(slot)
        mappings.append({
            "source_field_id":   field.id,
            "source_field_name": field.name,
            "arthound_slot":     slot,
        })

    return mappings


def normalize_asset(record: RawRecord, mappings: list[dict]) -> dict:
    """
    Apply field mappings to a raw source record.
    Returns a dict ready for insertion into replicated_assets.
    """
    by_name = {m["source_field_name"]: m.get("arthound_slot") for m in mappings}

    slots: dict = {}
    meta: dict = {}

    for field_name, value in record.fields.items():
        slot = by_name.get(field_name)
        if slot and slot in ARTHOUND_SLOTS:
            coerced = _coerce_slot(slot, value)
            if coerced is not None:
                slots[slot] = coerced
            else:
                # Slot coercion failed (e.g. linked-record array) — preserve in meta
                # so linked IDs remain available for relationship resolution at read time.
                cleaned = _clean_meta(value)
                if cleaned is not None:
                    meta[field_name] = cleaned
        else:
            cleaned = _clean_meta(value)
            if cleaned is not None:
                meta[field_name] = cleaned

    source_hash = hashlib.sha256(
        json.dumps(record.fields, sort_keys=True, default=str).encode()
    ).hexdigest()

    return {
        **slots,
        "meta": meta,
        "source_hash": source_hash,
        "source_record_id": record.source_record_id,
        "source_last_modified_at": record.source_last_modified_at,
    }


def normalize_reference(record: RawRecord, name_field: str) -> dict:
    """Normalize a product or item-type record (simple name + meta)."""
    name = record.fields.get(name_field) or record.fields.get("Name") or ""
    meta = {k: v for k, v in record.fields.items() if k != name_field and v not in (None, "", [])}
    return {
        "source_record_id": record.source_record_id,
        "name": str(name) if name else "",
        "meta": meta,
    }


def _coerce_slot(slot: str, value) -> object:
    if value is None or value == "":
        return None

    if slot == "priority":
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str):
            try:
                return int(value.strip().upper().lstrip("P"))
            except ValueError:
                return None
        return None

    if slot == "project_date":
        if isinstance(value, str) and len(value) >= 10:
            return value[:10]
        return None

    # For all text slots: flatten arrays/dicts to a string
    if isinstance(value, list):
        if not value:
            return None
        if all(isinstance(v, str) and v.startswith("rec") for v in value):
            return None  # bare linked-record IDs — not useful
        if all(isinstance(v, str) for v in value):
            return ", ".join(v for v in value if v) or None
        if all(isinstance(v, dict) for v in value):
            names = [str(v.get("name") or v.get("text") or "") for v in value]
            return ", ".join(n for n in names if n) or None
        return None

    if isinstance(value, dict):
        return str(value.get("name") or value.get("text") or "") or None

    if isinstance(value, bool):
        return "Yes" if value else "No"

    return str(value) if value != "" else None


def _clean_meta(value) -> object:
    """Sanitise a source field value for JSONB storage."""
    if value is None or value == "" or value == []:
        return None
    if isinstance(value, list):
        if not value:
            return None
        first = value[0]
        if isinstance(first, dict) and "url" in first:
            return [{"url": a["url"], "filename": a.get("filename", "")} for a in value]
        if all(isinstance(v, str) and v.startswith("rec") for v in value):
            return value  # keep linked record IDs — used to resolve product/task relationships at read time
        if all(isinstance(v, str) for v in value):
            return value
        if all(isinstance(v, dict) for v in value):
            return [str(v.get("name") or v.get("text") or v.get("email") or "") for v in value]
        return None
    if isinstance(value, dict):
        name = value.get("name") or value.get("text") or value.get("email")
        return str(name) if name else None
    return value
