"""
Jira field adapter + connector manifest.

Translates raw Jira API field values (from /search?fields=*all) into
ArtHound canonical types (SelectValue, UserValue, LinkedRecord, etc.).
"""

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

# Jira schema.type → ArtHound field category
JIRA_FIELD_CATEGORY: dict[str, str] = {
    "string":      "text",
    "number":      "number",
    "datetime":    "date",
    "date":        "date",
    "boolean":     "bool",
    "option":      "select",
    "priority":    "select",
    "status":      "select",
    "issuetype":   "select",
    "resolution":  "select",
    "user":        "user",
    "issuelinks":  "link",
    "attachment":  "file",
    "project":     "link",
    "progress":    "computed",
    "timetracking": "computed",
    "votes":       "computed",
    "watches":     "computed",
    "doc":         "text",   # ADF description
    "any":         "other",
}

# array items type → category (when schema.type == "array")
JIRA_ARRAY_ITEM_CATEGORY: dict[str, str] = {
    "string":     "text",
    "option":     "select",
    "user":       "user",
    "attachment": "file",
    "version":    "select",
    "component":  "select",
    "issuelinks": "link",
}

# System fields whose raw value is a name-bearing object → SelectValue
_NAME_OBJECT_TYPES = {"status", "priority", "issuetype", "resolution"}


def _extract_adf_text(node: Any) -> str:
    """Recursively extract plain text from an Atlassian Document Format node."""
    if not isinstance(node, dict):
        return ""
    if node.get("type") == "text":
        return node.get("text", "")
    parts = [_extract_adf_text(child) for child in node.get("content", [])]
    return " ".join(p for p in parts if p)


class JiraFieldAdapter:
    """
    Translates raw Jira API field values to ArtHound canonical types.

    deserialize() — raw Jira value → canonical type
    display_string() — any canonical value → plain display string
    """

    def deserialize(
        self,
        field_type: str,
        raw_value: Any,
        reference_resolver: dict[str, str] | None = None,
    ) -> Any:
        if raw_value is None or raw_value == "" or raw_value == []:
            return None

        # Plain scalars
        if field_type in ("string", "number", "boolean", "datetime", "date"):
            return raw_value

        # ADF description (API v3 returns description as ADF doc object)
        if field_type == "doc":
            if isinstance(raw_value, dict) and raw_value.get("type") == "doc":
                return _extract_adf_text(raw_value) or None
            if isinstance(raw_value, str):
                return raw_value
            return None

        # Name-bearing objects: status, priority, issuetype, resolution
        if field_type in _NAME_OBJECT_TYPES:
            if isinstance(raw_value, dict):
                name = raw_value.get("name") or raw_value.get("value")
                if name:
                    return SelectValue(label=str(name), id=raw_value.get("id"))
            return None

        # Custom single select (option)
        if field_type == "option":
            if isinstance(raw_value, dict):
                label = raw_value.get("value") or raw_value.get("name")
                if label:
                    return SelectValue(label=str(label), id=raw_value.get("id"))
            if isinstance(raw_value, str):
                return SelectValue(label=raw_value)
            return None

        # User fields
        if field_type == "user":
            return self._deserialize_user(raw_value)

        # Jira project → linked record
        if field_type == "project":
            if isinstance(raw_value, dict):
                return LinkedRecord(
                    source_id=raw_value.get("key") or raw_value.get("id", ""),
                    display_name=raw_value.get("name"),
                )
            return None

        # Issue links (parent, epic, etc.)
        if field_type in ("issuelinks", "parent"):
            if isinstance(raw_value, dict):
                key = raw_value.get("key") or raw_value.get("id", "")
                name = raw_value.get("name") or (
                    raw_value.get("fields", {}).get("summary")
                    if isinstance(raw_value.get("fields"), dict) else None
                )
                return LinkedRecord(source_id=str(key), display_name=name)
            return None

        # Arrays — resolve item type from options or infer from content
        if field_type == "array":
            if not isinstance(raw_value, list):
                return None
            return self._deserialize_array(raw_value, reference_resolver) or None

        # Attachments
        if field_type == "attachment":
            if isinstance(raw_value, list):
                return [self._deserialize_attachment(a) for a in raw_value] or None
            return self._deserialize_attachment(raw_value) if isinstance(raw_value, dict) else None

        # Unknown — pass through raw
        return raw_value

    def display_string(self, canonical: Any) -> str:
        if canonical is None:
            return ""
        if isinstance(canonical, list):
            parts = [self.display_string(v) for v in canonical]
            return ", ".join(p for p in parts if p)
        if isinstance(canonical, SelectValue):
            return canonical.label
        if isinstance(canonical, LinkedRecord):
            return canonical.display_name or canonical.source_id
        if isinstance(canonical, UserValue):
            return canonical.display_name
        if isinstance(canonical, AttachmentValue):
            return canonical.filename
        if isinstance(canonical, bool):
            return "Yes" if canonical else "No"
        return str(canonical) if canonical != "" else ""

    # ── private helpers ────────────────────────────────────────────────────────

    def _deserialize_user(self, raw: Any) -> UserValue | None:
        if not isinstance(raw, dict):
            return None
        uid = raw.get("accountId") or raw.get("id")
        if not uid:
            return None
        return UserValue(
            source_id=uid,
            display_name=raw.get("displayName") or raw.get("name") or "",
            email=raw.get("emailAddress"),
            avatar_url=raw.get("avatarUrls", {}).get("48x48") if isinstance(raw.get("avatarUrls"), dict) else None,
        )

    def _deserialize_attachment(self, raw: Any) -> AttachmentValue:
        if isinstance(raw, dict):
            return AttachmentValue(
                url=raw.get("content") or raw.get("url", ""),
                filename=raw.get("filename", ""),
                mimetype=raw.get("mimeType"),
                size_bytes=raw.get("size"),
            )
        return AttachmentValue(url=str(raw), filename="")

    def _deserialize_array(
        self,
        items: list,
        reference_resolver: dict[str, str] | None,
    ) -> list | None:
        if not items:
            return None
        first = items[0]

        # list of option objects
        if isinstance(first, dict) and ("value" in first or ("name" in first and "accountId" not in first)):
            if "accountId" not in first:
                result = []
                for v in items:
                    label = v.get("value") or v.get("name")
                    if label:
                        result.append(SelectValue(label=str(label), id=v.get("id")))
                return result or None

        # list of user objects
        if isinstance(first, dict) and "accountId" in first:
            return [u for v in items if (u := self._deserialize_user(v))] or None

        # list of attachment objects
        if isinstance(first, dict) and "filename" in first:
            return [self._deserialize_attachment(a) for a in items]

        # list of strings (labels, components, versions, etc.)
        if isinstance(first, str):
            return items

        # list of issue link objects
        if isinstance(first, dict) and ("inwardIssue" in first or "outwardIssue" in first):
            result = []
            for link in items:
                linked = link.get("inwardIssue") or link.get("outwardIssue")
                if linked:
                    result.append(LinkedRecord(
                        source_id=linked.get("key", ""),
                        display_name=linked.get("fields", {}).get("summary") if isinstance(linked.get("fields"), dict) else None,
                    ))
            return result or None

        return items


# ── Jira connector manifest ────────────────────────────────────────────────────

JIRA_MANIFEST = ConnectorManifest(
    connector_type="jira",
    primary_entities=[
        EntitySpec(
            arthound_concept="asset",
            delta_field="updated",
            supabase_table="replicated_assets",
            depends_on=["product", "item_type"],
        ),
    ],
    reference_entities=[
        EntitySpec(
            arthound_concept="product",
            delta_field="updated",
            supabase_table="replicated_products",
        ),
        EntitySpec(
            arthound_concept="item_type",
            delta_field="updated",
            supabase_table="replicated_item_types",
        ),
    ],
    write_support=False,
)
