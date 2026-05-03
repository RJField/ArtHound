import hashlib
import json
from typing import Any

from lib.connectors.adapters.airtable import AirtableFieldAdapter
from lib.connectors.field_types import LinkedRecord, SelectValue, to_json
from lib.sync.connector import RawRecord, SchemaField

ARTHOUND_SLOTS = {
    "name", "dev_name", "item_type", "priority",
    "product", "project_date", "status", "asset_number",
}

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

_adapter = AirtableFieldAdapter()


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
            slot = None
        if slot:
            seen_slots.add(slot)
        mappings.append({
            "source_field_id":      field.id,
            "source_field_name":    field.name,
            "source_field_type":    field.type,
            "source_field_options": field.options,
            "arthound_slot":        slot,
        })

    return mappings


def normalize_asset(
    record: RawRecord,
    mappings: list[dict],
    field_type_map: dict[str, str] | None = None,
    reference_resolver: dict[str, str] | None = None,
) -> dict:
    """
    Apply field mappings to a raw source record using the connector field adapter.

    field_type_map: {field_name: airtable_field_type} — used for type-aware
        deserialization. When provided, all field types are resolved correctly.
        Without it, the adapter falls back to raw-value pass-through.

    reference_resolver: {source_record_id: display_name} — built from already-synced
        reference tables (products, item types) so linked record fields resolve to
        display names without extra API calls.

    Returns a dict ready for insertion into replicated_assets.
    """
    by_name = {m["source_field_name"]: m.get("arthound_slot") for m in mappings}
    resolved_type_map = field_type_map or {}

    slots: dict = {}
    meta: dict = {}

    for field_name, raw_value in record.fields.items():
        field_type = resolved_type_map.get(field_name, "unknown")
        canonical = _adapter.deserialize(field_type, raw_value, reference_resolver)

        if canonical is None:
            continue

        slot = by_name.get(field_name)
        if slot and slot in ARTHOUND_SLOTS:
            coerced = _coerce_slot(slot, canonical)
            if coerced is not None:
                slots[slot] = coerced

        # Store canonical JSON in meta for all fields — slot columns are a
        # denormalized convenience; meta is the full structured record.
        meta[field_name] = to_json(canonical)

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
    name = (
        record.fields.get(name_field)
        or record.fields.get("Name")
        or next((v for v in record.fields.values() if isinstance(v, str) and v.strip()), "")
    )
    meta = {k: v for k, v in record.fields.items() if k != name_field and v not in (None, "", [])}
    return {
        "source_record_id": record.source_record_id,
        "name": str(name).strip() if name else "",
        "meta": meta,
    }


def _coerce_slot(slot: str, canonical: Any) -> object:
    """
    Extract a slot-appropriate scalar from a canonical value.
    Text slots use the adapter's display_string; numeric/date slots parse accordingly.
    """
    if canonical is None:
        return None

    if slot == "product":
        # Prefer the display name; fall back to source_id so the slot is never
        # null for a linked asset (critical for DB-level product filtering).
        if isinstance(canonical, list) and canonical:
            item = canonical[0]
            if hasattr(item, "display_name") and hasattr(item, "source_id"):
                return item.display_name or item.source_id
        display = _adapter.display_string(canonical)
        return display if display else None

    if slot == "priority":
        if isinstance(canonical, (int, float)):
            return int(canonical)
        if isinstance(canonical, str):
            try:
                return int(canonical.strip().upper().lstrip("P"))
            except ValueError:
                return None
        # Lookup arrays may contain numbers
        if isinstance(canonical, list) and canonical:
            first = canonical[0]
            if isinstance(first, (int, float)):
                return int(first)
            if isinstance(first, str):
                try:
                    return int(first.strip().upper().lstrip("P"))
                except ValueError:
                    return None
        return None

    if slot == "project_date":
        val = canonical if isinstance(canonical, str) else _adapter.display_string(canonical)
        return val[:10] if isinstance(val, str) and len(val) >= 10 else None

    # All remaining slots are text — resolve via adapter display_string
    display = _adapter.display_string(canonical)
    return display if display else None
