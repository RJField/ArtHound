from __future__ import annotations
from typing import Any

from lib.connectors.field_types import (
    AttachmentValue,
    LinkedRecord,
    SelectValue,
    UserValue,
    to_json,
)
from lib.connectors.manifest import ConnectorManifest, EntitySpec

# Airtable field types that map directly to plain Python scalars
_SCALAR_TYPES = {
    "singleLineText", "multilineText", "email", "url", "phoneNumber", "richText",
    "number", "percent", "currency", "duration", "autoNumber",
    "date", "dateTime", "createdTime", "lastModifiedTime",
    "checkbox",
}


class AirtableFieldAdapter:
    """
    Translates between raw Airtable API field values and ArtHound canonical types.

    deserialize() — raw Airtable value → canonical type (for sync ingestion)
    serialize()   — canonical type → Airtable API write format (for write-back)
    display_string() — any canonical value → plain display string
    """

    def deserialize(
        self,
        field_type: str,
        raw_value: Any,
        reference_resolver: dict[str, str] | None = None,
    ) -> Any:
        """
        Convert a raw Airtable field value to the canonical representation.
        reference_resolver maps {source_record_id: display_name} for linked record
        resolution using already-synced reference data (products, item types, etc.).
        """
        if raw_value is None or raw_value == "" or raw_value == []:
            return None

        if field_type in _SCALAR_TYPES:
            return raw_value

        if field_type == "singleSelect":
            return SelectValue(label=str(raw_value))

        if field_type == "multipleSelects":
            if isinstance(raw_value, list):
                return [SelectValue(label=str(v)) for v in raw_value if v] or None
            return None

        if field_type == "multipleRecordLinks":
            if isinstance(raw_value, list):
                result = [
                    LinkedRecord(
                        source_id=rec_id,
                        display_name=(reference_resolver or {}).get(rec_id),
                    )
                    for rec_id in raw_value
                    if isinstance(rec_id, str)
                ]
                return result or None
            return None

        if field_type in ("multipleLookupValues", "lookup", "rollup", "formula"):
            return self._deserialize_lookup(raw_value, reference_resolver)

        if field_type == "collaborator":
            return self._deserialize_user(raw_value)

        if field_type == "multipleCollaborators":
            if isinstance(raw_value, list):
                users = [u for v in raw_value if (u := self._deserialize_user(v))]
                return users or None
            return None

        if field_type == "attachments":
            if isinstance(raw_value, list):
                return [self._deserialize_attachment(a) for a in raw_value] or None
            return None

        if field_type == "rating":
            return int(raw_value) if isinstance(raw_value, (int, float)) else None

        # Unknown field type — pass raw value through unchanged
        return raw_value

    def serialize(self, canonical_value: Any, target_field_type: str) -> Any:
        """Convert a canonical value back to the format Airtable's API expects for writes."""
        if canonical_value is None:
            return None

        if target_field_type == "singleSelect":
            if isinstance(canonical_value, SelectValue):
                return {"name": canonical_value.label}
            return {"name": str(canonical_value)}

        if target_field_type == "multipleSelects":
            if isinstance(canonical_value, list):
                return [
                    {"name": v.label if isinstance(v, SelectValue) else str(v)}
                    for v in canonical_value
                ]
            return None

        if target_field_type == "multipleRecordLinks":
            if isinstance(canonical_value, list):
                return [
                    {"id": r.source_id}
                    for r in canonical_value
                    if isinstance(r, LinkedRecord)
                ]
            return None

        if target_field_type == "collaborator":
            if isinstance(canonical_value, UserValue):
                return {"id": canonical_value.source_id}
            return None

        if target_field_type == "multipleCollaborators":
            if isinstance(canonical_value, list):
                return [
                    {"id": u.source_id}
                    for u in canonical_value
                    if isinstance(u, UserValue)
                ]
            return None

        # Scalars and unknown types pass through unchanged
        return canonical_value

    def display_string(self, canonical_value: Any) -> str:
        """Flatten any canonical or raw value to a plain string suitable for display."""
        if canonical_value is None:
            return ""
        if isinstance(canonical_value, list):
            parts = [self.display_string(v) for v in canonical_value]
            return ", ".join(p for p in parts if p)
        if isinstance(canonical_value, SelectValue):
            return canonical_value.label
        if isinstance(canonical_value, LinkedRecord):
            return canonical_value.display_name or ""
        if isinstance(canonical_value, UserValue):
            return canonical_value.display_name
        if isinstance(canonical_value, AttachmentValue):
            return canonical_value.filename
        if isinstance(canonical_value, bool):
            return "Yes" if canonical_value else "No"
        return str(canonical_value) if canonical_value != "" else ""

    # ── private helpers ────────────────────────────────────────────────────────

    def _deserialize_lookup(
        self, raw_value: Any, reference_resolver: dict[str, str] | None
    ) -> Any:
        """
        Lookup/rollup/formula values can be scalars or mixed arrays.
        Dicts that look like linked record stubs get promoted to LinkedRecord.
        """
        if not isinstance(raw_value, list):
            return raw_value
        result = []
        for v in raw_value:
            if isinstance(v, dict):
                rec_id = v.get("id", "")
                if isinstance(rec_id, str) and rec_id.startswith("rec"):
                    display = v.get("name") or (reference_resolver or {}).get(rec_id)
                    result.append(LinkedRecord(source_id=rec_id, display_name=display))
                else:
                    name = v.get("name") or v.get("text") or v.get("email")
                    result.append(str(name) if name else str(v))
            else:
                result.append(v)
        return result if result else None

    def _deserialize_user(self, raw_value: Any) -> UserValue | None:
        if not isinstance(raw_value, dict):
            return None
        uid = raw_value.get("id") or raw_value.get("uid")
        if not uid:
            return None
        return UserValue(
            source_id=uid,
            display_name=raw_value.get("name") or raw_value.get("email") or "",
            email=raw_value.get("email"),
        )

    def _deserialize_attachment(self, raw_value: Any) -> AttachmentValue:
        if isinstance(raw_value, dict):
            return AttachmentValue(
                url=raw_value.get("url", ""),
                filename=raw_value.get("filename", ""),
                mimetype=raw_value.get("type"),
                size_bytes=raw_value.get("size"),
            )
        return AttachmentValue(url=str(raw_value), filename="")


# ── Airtable connector manifest ────────────────────────────────────────────────

AIRTABLE_MANIFEST = ConnectorManifest(
    connector_type="airtable",
    primary_entities=[
        EntitySpec(
            arthound_concept="asset",
            delta_field="modifiedTime",
            supabase_table="replicated_assets",
            depends_on=["product", "item_type"],
        ),
    ],
    reference_entities=[
        EntitySpec(
            arthound_concept="product",
            delta_field="modifiedTime",
            supabase_table="replicated_products",
        ),
        EntitySpec(
            arthound_concept="item_type",
            delta_field="modifiedTime",
            supabase_table="replicated_item_types",
        ),
    ],
    write_support=True,
)
