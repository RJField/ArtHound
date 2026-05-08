import hashlib
import json
import re
from typing import Any

from lib.connectors.adapters.airtable import AirtableFieldAdapter
from lib.connectors.field_types import LinkedRecord, SelectValue, to_json
from lib.sync.connector import RawRecord, SchemaField

_WORK_NAME_PRIORITY = ["task", "name", "title", "ticket", "item"]
_WORK_STATUS_ALIASES = ["status", "state", "phase"]
_WORK_ESTIMATE_ALIASES = ["estimate", "duration", "hours", "days", "frames", "time"]

ARTHOUND_SLOTS = {
    "name", "dev_name", "item_type", "priority",
    "product", "project_date", "status", "asset_number", "team",
}

# ── Field classification ──────────────────────────────────────────────────────

# Field types that are always source-native plumbing regardless of name.
_SOURCE_NATIVE_TYPES = frozenset({
    "formula", "rollup", "count", "autoNumber",
    "createdBy", "createdTime", "lastModifiedBy", "lastModifiedTime",
})

# Name fragments (whole-word, case-insensitive) that indicate source-native fields.
_SOURCE_NATIVE_NAME_PATTERNS = re.compile(
    r"\b(rank|ratio|workratio|watches|votes|progress|timespent|timeestimate|"
    r"timeoriginalestimate|lastviewed|statuscategory|sigma)\b",
    re.IGNORECASE,
)

# Scheduling fields (Work paw_level only).
_SCHEDULING_NAME_PATTERNS = re.compile(
    r"\b(date|due|deadline|sprint|eta|milestone|start|end|target|delivery)\b",
    re.IGNORECASE,
)
_SCHEDULING_TYPES = frozenset({"date", "dateTime"})

# Production, technical, business name fragments.
_PRODUCTION_PATTERNS = re.compile(
    r"\b(status|state|phase|stage|approval|review|qc|pass|fail)\b",
    re.IGNORECASE,
)
_TECHNICAL_PATTERNS = re.compile(
    r"\b(format|resolution|fps|poly|triangle|texture|uv\b|lod|dimension|spec|"
    r"pipeline|rig|shader|dpi|pixel|mesh)\b",
    re.IGNORECASE,
)
_BUSINESS_PATTERNS = re.compile(
    r"\b(contract|billing|rate|invoice|copyright|license|budget|cost|fee)\b"
    r"|\bip\b",
    re.IGNORECASE,
)


def classify_field(
    field_name: str,
    field_type: str,
    source_type: str = "airtable",
    paw_level: str = "asset",
) -> tuple[str, str, bool]:
    """
    Classify a source field into a meta bucket.

    Returns (meta_bucket, display_tier, ingest_suppressed).

    Priority order:
      1. source_native — plumbing fields; auto-suppressed
      2. scheduling    — date/timeline fields (Work only)
      3. production    — status, approval, QC
      4. technical     — specs, formats, pipeline
      5. business      — contracts, billing, IP
      6. custom        — safe default
    """
    name_lower = field_name.lower().strip()

    # 0. [IGNORE]-prefixed — studio-explicitly excluded fields; suppressed regardless of type
    if name_lower.startswith("[ignore]"):
        return "source_native", "hidden", True

    # 1. source_native — type-based (highest priority)
    if field_type in _SOURCE_NATIVE_TYPES:
        return "source_native", "hidden", True

    # 1b. source_native — name-based (Jira plumbing fields that arrive as plain strings)
    if name_lower.startswith("_jira_") or _SOURCE_NATIVE_NAME_PATTERNS.search(field_name):
        return "source_native", "hidden", True

    # 2. scheduling (Work paw_level only)
    if paw_level == "work":
        if field_type in _SCHEDULING_TYPES or _SCHEDULING_NAME_PATTERNS.search(field_name):
            return "scheduling", "primary", False

    # 3. production
    if _PRODUCTION_PATTERNS.search(field_name):
        return "production", "primary", False

    # 4. technical
    if _TECHNICAL_PATTERNS.search(field_name):
        return "technical", "secondary", False

    # 5. business
    if _BUSINESS_PATTERNS.search(field_name):
        return "business", "secondary", False

    # 6. custom — default
    return "custom", "secondary", False

_SLOT_ALIASES: dict[str, list[str]] = {
    "name":         ["asset name", "name", "asset", "summary"],  # "summary" = Jira title field
    "dev_name":     ["dev name", "devname", "internal name", "dev", "development name"],
    "item_type":    ["item type", "itemtype", "type", "asset type", "issue type"],  # Jira
    "priority":     ["priority"],
    "product":      ["product", "project", "game", "title"],
    "project_date": ["project date", "due date", "delivery date", "target date", "date"],
    "status":       ["status", "state", "phase", "production status"],
    "asset_number": ["asset number", "asset #", "asset no", "number", "asset id"],
    "team":         ["team", "team (from product)", "art team", "production team", "assigned team"],
}

_NAME_TO_SLOT: dict[str, str] = {
    alias.lower(): slot
    for slot, aliases in _SLOT_ALIASES.items()
    for alias in aliases
}

_airtable_adapter = AirtableFieldAdapter()


def default_mappings_from_schema(
    schema_fields: list[SchemaField],
    source_type: str = "airtable",
    paw_level: str = "asset",
) -> list[dict]:
    """
    Generate default slot mappings by matching source field names to ArtHound
    slot aliases. Saved on first sync so the user sees sensible pre-fills in the UI.
    Fields that don't match any alias get arthound_slot=null and land in meta.

    Each entry is stamped with meta_bucket, display_tier, and ingest_suppressed
    via classify_field() so downstream layers can immediately filter/group fields
    without requiring a separate configuration step.
    """
    mappings = []
    seen_slots: set[str] = set()

    for field in schema_fields:
        slot = _NAME_TO_SLOT.get(field.name.lower())
        if slot and slot in seen_slots:
            slot = None
        if slot:
            seen_slots.add(slot)

        bucket, tier, suppressed = classify_field(
            field.name, field.type, source_type=source_type, paw_level=paw_level
        )

        mappings.append({
            "source_field_id":      field.id,
            "source_field_name":    field.name,
            "source_field_type":    field.type,
            "source_field_options": field.options,
            "arthound_slot":        slot,
            "meta_bucket":          bucket,
            "display_tier":         tier,
            "ingest_suppressed":    suppressed,
        })

    # TECH DEBT: Products and item types have no dedicated field mapping — only assets
    # get a full source_field_mappings entry. Until proper PAW product field mapping is
    # built (see "Decide core product field schema" TODO), we fall back to promoting the
    # primary field (first in Airtable schema) to the name slot when no alias matches.
    # This handles arbitrary primary field names (e.g. "Record" in flat-table setups)
    # without relying on studios naming their fields predictably.
    if "name" not in seen_slots and mappings:
        mappings[0]["arthound_slot"] = "name"

    return mappings


def normalize_asset(
    record: RawRecord,
    mappings: list[dict],
    field_type_map: dict[str, str] | None = None,
    reference_resolver: dict[str, str] | None = None,
    adapter=None,
    product_rel_field_id: str | None = None,
    suppressed_names: set[str] | None = None,
) -> dict:
    """
    Apply field mappings to a raw source record using the connector field adapter.

    field_type_map: {field_name: airtable_field_type} — used for type-aware
        deserialization. When provided, all field types are resolved correctly.
        Without it, the adapter falls back to raw-value pass-through.

    reference_resolver: {source_record_id: display_name} — built from already-synced
        reference tables (products, item types) so linked record fields resolve to
        display names without extra API calls.

    product_rel_field_id: when set, this field on the asset record drives the product
        slot instead of alias-based detection. Allows Epic→Feature hierarchies in Jira
        where the parent field (not the project field) identifies the product.

    suppressed_names: set of field display names (and/or source field IDs) that must
        never be written to meta, even if they arrive in the raw record. Safety net for
        the bootstrapping window (first sync before mappings exist) and connectors that
        cannot exclude fields at the API level.

    Returns a dict ready for insertion into replicated_assets.
    """
    _adp = adapter or _airtable_adapter
    _suppressed = suppressed_names or set()

    # Build lookup tables from mappings.
    # by_id: field ID → slot (covers connectors like Jira where record keys are API IDs)
    # by_name: display name → slot (covers Airtable where record keys are display names)
    # id_to_display: field ID → display name (for human-readable meta keys)
    # suppressed_ids: field IDs whose ingest_suppressed=True in mappings
    by_id: dict[str, str | None] = {}
    by_name: dict[str, str | None] = {}
    id_to_display: dict[str, str] = {}
    suppressed_ids: set[str] = set()
    for m in mappings:
        slot = m.get("arthound_slot")
        fid  = m.get("source_field_id")
        fname = m.get("source_field_name", "")
        by_name[fname] = slot
        if fid:
            by_id[fid] = slot
            if fname and fid != fname:
                id_to_display[fid] = fname
            if m.get("ingest_suppressed"):
                suppressed_ids.add(fid)
        if m.get("ingest_suppressed") and fname:
            _suppressed = _suppressed | {fname}

    resolved_type_map = field_type_map or {}

    slots: dict = {}
    meta: dict = {}

    for field_name, raw_value in record.fields.items():
        # Skip fields that are suppressed at the mapping level (safety net — the
        # connector should already have excluded these at the fetch layer).
        display_name = id_to_display.get(field_name, field_name)
        if field_name in suppressed_ids or display_name in _suppressed:
            continue

        field_type = resolved_type_map.get(field_name, "unknown")
        canonical = _adp.deserialize(field_type, raw_value, reference_resolver)

        if canonical is None:
            continue

        # Slot lookup priority:
        # 1. Explicit mapping by field ID or display name
        # 2. product_rel_field_id — this specific field is forced to the product slot
        # 3. Alias fallback on display name (but suppressed for product when rel_field drives it)
        slot = by_id.get(field_name) or by_name.get(field_name) or by_name.get(display_name)

        # When product_rel_field_id is configured, it is the sole authority for the
        # product slot. Block both explicit stored mappings and alias matches on every
        # other field — even if the stored mapping says "project → product".
        if slot == "product" and product_rel_field_id and field_name != product_rel_field_id:
            slot = None

        if slot is None:
            if product_rel_field_id and field_name == product_rel_field_id:
                slot = "product"
            else:
                alias = _NAME_TO_SLOT.get(display_name.lower())
                if alias == "product" and product_rel_field_id:
                    alias = None
                slot = alias

        if slot and slot in ARTHOUND_SLOTS:
            coerced = _coerce_slot(slot, canonical, _adp)
            if coerced is not None:
                slots[slot] = coerced
            if slot == "product":
                src_id = _extract_product_source_id(canonical)
                if src_id:
                    slots["product_source_record_id"] = src_id

        # Store canonical JSON in meta using the human-readable display name so
        # the detail panel shows "Issue Type" instead of "issuetype", etc.
        meta[display_name] = to_json(canonical)

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


def normalize_work(
    record: RawRecord,
    rel_field_name: str | None = None,
    asset_canonical_map: dict[str, str] | None = None,
) -> dict:
    """
    Normalize a raw work record into a replicated_work row.

    rel_field_name: name of the linked-record field on the work item pointing to
        the parent asset (from source_entity_definitions.rel_field_name).
    asset_canonical_map: {source_asset_record_id: canonical_asset_id} — built
        from canonical_map after asset upsert so work items resolve to ArtHound IDs.
    Only child_holds_link direction is supported (work item has the link to asset).
    """
    # Resolve parent asset
    source_asset_record_id: str | None = None
    canonical_asset_id: str | None = None
    if rel_field_name:
        link_val = record.fields.get(rel_field_name)
        if isinstance(link_val, list) and link_val:
            source_asset_record_id = link_val[0]
        elif isinstance(link_val, str) and link_val:
            source_asset_record_id = link_val
    if source_asset_record_id and asset_canonical_map:
        canonical_asset_id = asset_canonical_map.get(source_asset_record_id)

    # Index fields by lowercased name for alias matching
    fields_by_lower: dict[str, tuple[str, Any]] = {
        k.lower(): (k, v)
        for k, v in record.fields.items()
        if k != rel_field_name
    }

    name: str | None = None
    for alias in _WORK_NAME_PRIORITY:
        if alias in fields_by_lower:
            _, val = fields_by_lower[alias]
            if isinstance(val, str) and val.strip():
                name = val.strip()
                break
    if not name:
        for k, v in record.fields.items():
            if k != rel_field_name and isinstance(v, str) and v.strip():
                name = v.strip()
                break

    status: str | None = None
    for alias in _WORK_STATUS_ALIASES:
        if alias in fields_by_lower:
            _, val = fields_by_lower[alias]
            if isinstance(val, str) and val.strip():
                status = val.strip()
                break

    estimate: float | None = None
    for alias in _WORK_ESTIMATE_ALIASES:
        if alias in fields_by_lower:
            _, val = fields_by_lower[alias]
            if val is not None:
                try:
                    estimate = float(val)
                    break
                except (TypeError, ValueError):
                    pass

    meta = {k: v for k, v in record.fields.items() if k != rel_field_name}

    source_hash = hashlib.sha256(
        json.dumps(record.fields, sort_keys=True, default=str).encode()
    ).hexdigest()

    return {
        "source_record_id":        record.source_record_id,
        "source_last_modified_at": record.source_last_modified_at,
        "source_hash":             source_hash,
        "source_asset_record_id":  source_asset_record_id,
        "canonical_asset_id":      canonical_asset_id,
        "name":                    name,
        "status":                  status,
        "estimate":                estimate,
        "meta":                    meta,
    }


def _extract_product_source_id(canonical: Any) -> str | None:
    """Extract the source record ID from a product canonical value, if present."""
    if isinstance(canonical, list) and canonical:
        item = canonical[0]
        if hasattr(item, "source_id") and item.source_id:
            return str(item.source_id)
    if isinstance(canonical, dict):
        return canonical.get("id") or canonical.get("key") or None
    return None


def _coerce_slot(slot: str, canonical: Any, adapter=None) -> object:
    """
    Extract a slot-appropriate scalar from a canonical value.
    Text slots use the adapter's display_string; numeric/date slots parse accordingly.
    """
    if canonical is None:
        return None

    _adp = adapter or _airtable_adapter

    if slot == "product":
        # Bare integers/floats are never valid product names — they indicate a
        # numeric field (autoNumber, formula, priority, etc.) is wrongly resolving
        # to this slot. Reject them so a correctly-mapped linked-record field
        # (which may have iterated first) is not overwritten.
        if isinstance(canonical, (int, float)):
            return None
        # Return only the display name. The source_id is written to the separate
        # product_source_record_id column in normalize_asset — never stored here.
        if isinstance(canonical, list) and canonical:
            item = canonical[0]
            if hasattr(item, "display_name") and hasattr(item, "source_id"):
                return item.display_name or None
        # Raw Jira issue-link dicts (parent/epic fields that survive as "unknown" type):
        # {id, key, fields: {summary, ...}}
        if isinstance(canonical, dict):
            display = (
                (canonical.get("fields", {}).get("summary")
                 if isinstance(canonical.get("fields"), dict) else None)
                or canonical.get("name")
            )
            return display if display else None
        display = _adp.display_string(canonical)
        return display if display else None

    if slot == "priority":
        if isinstance(canonical, (int, float)):
            return str(int(canonical))
        if isinstance(canonical, str):
            s = canonical.strip()
            try:
                return str(int(s.upper().lstrip("P")))
            except ValueError:
                return s or None
        # SelectValue — Jira priority objects (Highest/High/Medium/Low/Lowest)
        if hasattr(canonical, "label"):
            _pmap = {"highest": 1, "critical": 1, "high": 2, "medium": 3, "low": 4, "lowest": 5}
            label = (canonical.label or "").lower().strip()
            try:
                return int(label)
            except ValueError:
                return _pmap.get(label)
        # Lookup arrays may contain numbers
        if isinstance(canonical, list) and canonical:
            first = canonical[0]
            if isinstance(first, (int, float)):
                return str(int(first))
            if isinstance(first, str):
                s = first.strip()
                try:
                    return str(int(s.upper().lstrip("P")))
                except ValueError:
                    return s or None
        return None

    if slot == "project_date":
        val = canonical if isinstance(canonical, str) else _adp.display_string(canonical)
        return val[:10] if isinstance(val, str) and len(val) >= 10 else None

    # All remaining slots are text — resolve via adapter display_string
    display = _adp.display_string(canonical)
    return display if display else None
