"""
Schema drift detection.

Runs on a configurable cadence (default: daily) for every studio that has
source credentials. Compares the live source schema against the stored
source_field_mappings and writes signal rows to schema_drift_events when
fields are added, removed, or change type.

Sets pending_schema_review=true on source_field_mappings so the login
banner can surface the notification without a separate query.
"""

import asyncio
import logging
import os
from datetime import datetime, timezone

import httpx

from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)


async def _get_all_studios_with_credentials() -> list[dict]:
    r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={"select": "owner_type,owner_id,source_type", "owner_type": "eq.studio"},
        headers=_headers(),
    )
    if not r.is_success:
        return []
    return r.json()


async def _get_stored_mappings(owner_type: str, owner_id: str, source_type: str) -> list[dict]:
    r = await db_client.get(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "mappings",
        },
        headers=_headers(),
    )
    if not r.is_success or not r.json():
        return []
    return r.json()[0].get("mappings") or []


async def _fetch_live_schema(
    owner_type: str,
    owner_id: str,
    source_type: str,
    client: httpx.AsyncClient,
) -> list[dict] | None:
    """
    Return a list of {id, name, type} for the asset table's live fields.
    Returns None if credentials or entity definitions are missing/invalid.
    """
    from lib.crypto import decrypt_credentials

    creds_r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "credentials",
        },
        headers=_headers(),
    )
    if not creds_r.is_success or not creds_r.json():
        return None
    creds = decrypt_credentials(creds_r.json()[0]["credentials"])

    entity_r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "entity_type": "eq.asset",
            "select":      "table_id",
        },
        headers=_headers(),
    )
    entity_rows = entity_r.json() if entity_r.is_success else []
    table_id = entity_rows[0]["table_id"] if entity_rows else None

    try:
        if source_type == "airtable":
            from lib.sync.connectors.airtable import AirtableConnector
            connector = AirtableConnector(
                api_token=creds["api_token"],
                base_id=creds["base_id"],
                client=client,
            )
        elif source_type == "jira":
            from lib.sync.connectors.jira import JiraConnector
            from lib.token_refresh import get_jira_token
            jira_creds = await get_jira_token(owner_type, owner_id, client)
            connector = JiraConnector(
                access_token=jira_creds["access_token"],
                client=client,
                cloud_id=jira_creds.get("cloud_id"),
                deployment=jira_creds.get("deployment", "cloud"),
                instance_url=jira_creds.get("instance_url"),
            )
        else:
            return None

        schema_fields = await connector.fetch_asset_schema(table_id=table_id)
        return [{"id": f.id, "name": f.name, "type": f.type} for f in schema_fields]

    except Exception as exc:
        log.warning("schema_drift: could not fetch live schema for %s/%s: %s", owner_type, owner_id, exc)
        return None


async def _write_drift_events(events: list[dict]) -> None:
    if not events:
        return
    r = await db_client.post(
        _url("/rest/v1/schema_drift_events"),
        headers=_headers({"Prefer": "return=minimal"}),
        json=events,
    )
    if not r.is_success:
        log.warning("schema_drift: failed to write %d events: %s", len(events), r.text)


async def _mark_pending_review(owner_type: str, owner_id: str, source_type: str) -> None:
    await db_client.patch(
        _url("/rest/v1/source_field_mappings"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
        },
        headers=_headers({"Prefer": "return=minimal"}),
        json={"pending_schema_review": True},
    )


async def check_schema_drift_for_owner(
    owner_type: str,
    owner_id: str,
    source_type: str,
) -> int:
    """
    Compare live schema against stored mappings for one owner.
    Returns count of drift events written.
    """
    stored = await _get_stored_mappings(owner_type, owner_id, source_type)
    if not stored:
        return 0

    async with httpx.AsyncClient(timeout=30.0) as client:
        live_fields = await _fetch_live_schema(owner_type, owner_id, source_type, client)

    if live_fields is None:
        return 0

    stored_by_id: dict[str, dict] = {}
    for m in stored:
        fid = m.get("source_field_id")
        if fid:
            stored_by_id[fid] = m

    live_by_id: dict[str, dict] = {f["id"]: f for f in live_fields}
    detected_at = datetime.now(timezone.utc).isoformat()
    events: list[dict] = []

    for fid, live in live_by_id.items():
        if fid not in stored_by_id:
            events.append({
                "owner_id":        owner_id,
                "source_type":     source_type,
                "paw_level":       "asset",
                "signal":          "field_added",
                "source_field_id": fid,
                "field_name":      live["name"],
                "new_type":        live["type"],
                "detected_at":     detected_at,
            })
        elif stored_by_id[fid].get("source_field_type") != live["type"]:
            events.append({
                "owner_id":        owner_id,
                "source_type":     source_type,
                "paw_level":       "asset",
                "signal":          "field_type_changed",
                "source_field_id": fid,
                "field_name":      live["name"],
                "old_type":        stored_by_id[fid].get("source_field_type"),
                "new_type":        live["type"],
                "detected_at":     detected_at,
            })

    for fid, stored_m in stored_by_id.items():
        if fid not in live_by_id:
            events.append({
                "owner_id":        owner_id,
                "source_type":     source_type,
                "paw_level":       "asset",
                "signal":          "field_removed",
                "source_field_id": fid,
                "field_name":      stored_m.get("source_field_name", fid),
                "old_type":        stored_m.get("source_field_type"),
                "detected_at":     detected_at,
            })

    if events:
        await _write_drift_events(events)
        await _mark_pending_review(owner_type, owner_id, source_type)
        log.info(
            "schema_drift: %d event(s) for %s/%s/%s",
            len(events), owner_type, owner_id, source_type,
        )

    return len(events)


async def run_schema_drift_check() -> None:
    """Check all studios with source credentials for schema drift."""
    owners = await _get_all_studios_with_credentials()
    if not owners:
        return

    total = 0
    for row in owners:
        try:
            n = await check_schema_drift_for_owner(
                row["owner_type"], row["owner_id"], row["source_type"]
            )
            total += n
        except Exception as exc:
            log.warning(
                "schema_drift: error checking %s/%s: %s",
                row["owner_type"], row["owner_id"], exc,
            )

    if total:
        log.info("schema_drift: run complete — %d total event(s) across all studios", total)
