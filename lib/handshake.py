"""
Handshake utilities shared across routes and background tasks.

compare_payload_snapshots is the single source of truth for drift detection —
used at ingest time (Phase 4) and by the future passive notification loop (Phase 5).
"""
from __future__ import annotations

from typing import Optional
from fastapi import HTTPException

from lib.db import db_client, _url, _headers


def compare_payload_snapshots(
    link_snapshot: dict,
    template_mappings: dict,
) -> dict:
    """
    Compare a link's payload_format_snapshot against a vendor's saved template mappings.

    link_snapshot shape: {"field_schema": [{"key": ..., "label": ..., "type": ...}, ...]}
    template_mappings shape: {"payload_key": "source_field_id", ...}

    Returns:
        new_fields:     keys in the snapshot not present in the template
        removed_fields: keys in the template not present in the snapshot
        unchanged:      keys present in both
    """
    snapshot_keys = {f["key"] for f in (link_snapshot or {}).get("field_schema", [])}
    # Exclude reserved meta keys that are not real payload fields
    _RESERVED = {"_meta_summary_target", "_meta_summary_fields"}
    template_keys = {k for k in template_mappings if k not in _RESERVED}

    return {
        "new_fields":     sorted(snapshot_keys - template_keys),
        "removed_fields": sorted(template_keys - snapshot_keys),
        "unchanged":      sorted(snapshot_keys & template_keys),
    }


async def get_active_link(studio_id: str, vendor_id: str) -> Optional[dict]:
    """Return the active studio_vendor_links row for this pair, or None."""
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_links"),
        params={
            "studio_id": f"eq.{studio_id}",
            "vendor_id": f"eq.{vendor_id}",
            "status":    "eq.active",
            "select":    "id,payload_format_snapshot,review_collaboration_mode",
        },
        headers=_headers(),
    )
    rows = r.json()
    return rows[0] if rows else None


async def require_active_link(studio_id: str, vendor_id: str) -> dict:
    """Return the active link or raise 403."""
    link = await get_active_link(studio_id, vendor_id)
    if not link:
        raise HTTPException(
            status_code=403,
            detail="No active connection with this vendor. Send an invite first.",
        )
    return link


async def get_link_for_vendor(link_id: str, vendor_id: str) -> Optional[dict]:
    """Return the active studio_vendor_links row by id IF it belongs to this vendor, else None."""
    r = await db_client.get(
        _url("/rest/v1/studio_vendor_links"),
        params={
            "id":        f"eq.{link_id}",
            "vendor_id": f"eq.{vendor_id}",
            "status":    "eq.active",
            "select":    "id,studio_id,vendor_id",
        },
        headers=_headers(),
    )
    rows = r.json()
    return rows[0] if rows else None


async def require_vendor_link(link_id: str, vendor_id: str) -> dict:
    """Return the vendor's active link by id, or raise 403. Used to gate per-link override writes."""
    link = await get_link_for_vendor(link_id, vendor_id)
    if not link:
        raise HTTPException(
            status_code=403,
            detail="No active link for this vendor.",
        )
    return link


async def get_ingest_template(vendor_id: str, studio_id: str) -> Optional[dict]:
    """Return the vendor's saved ingest template for a studio, or None."""
    r = await db_client.get(
        _url("/rest/v1/vendor_studio_ingest_templates"),
        params={
            "vendor_id": f"eq.{vendor_id}",
            "studio_id": f"eq.{studio_id}",
            "select":    "*",
        },
        headers=_headers(),
    )
    rows = r.json()
    return rows[0] if rows else None
