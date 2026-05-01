"""
Sync runner — trigger-agnostic orchestrator.
Call run_sync() from login, manual refresh, webhook, or polling scheduler.
"""

import logging
import os
from datetime import datetime, timezone

import httpx

from lib.canonical import get_or_create_canonical_ids
from lib.db import db_client, _url, _headers
from lib.sync.connectors.airtable import AirtableConnector
from lib.sync.differ import find_changes
from lib.sync.normalizer import (
    default_mappings_from_schema,
    normalize_asset,
    normalize_reference,
)
from lib.sync.writer import (
    delete_orphaned_records,
    load_existing_hashes,
    save_default_mappings,
    upsert_assets,
    upsert_item_types,
    upsert_products,
)

log = logging.getLogger(__name__)


# ── credential helpers ────────────────────────────────────────────────────────

async def _get_credentials(owner_type: str, owner_id: str, source_type: str) -> dict | None:
    """
    Look up source credentials from the DB. Falls back to env vars for the
    single-studio transition period (AIRTABLE_TOKEN + AIRTABLE_BASE_ID).
    Returns dict with keys specific to source_type, or None if unavailable.
    """
    r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "credentials",
        },
        headers=_headers(),
    )
    rows = r.json()
    if rows:
        return rows[0]["credentials"]

    # Env-var fallback (single-studio setup)
    if source_type == "airtable":
        token = os.environ.get("AIRTABLE_TOKEN")
        base_id = os.environ.get("AIRTABLE_BASE_ID")
        if token and base_id:
            return {"api_token": token, "base_id": base_id}

    return None


async def _get_mappings(owner_type: str, owner_id: str, source_type: str) -> list[dict] | None:
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
    rows = r.json()
    return rows[0]["mappings"] if rows else None


async def _get_cursor(owner_type: str, owner_id: str, source_type: str) -> str | None:
    r = await db_client.get(
        _url("/rest/v1/sync_cursors"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "last_synced_at",
        },
        headers=_headers(),
    )
    rows = r.json()
    return rows[0]["last_synced_at"] if rows else None


async def _save_cursor(owner_type: str, owner_id: str, source_type: str, ts: str) -> None:
    await db_client.post(
        _url("/rest/v1/sync_cursors?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={"owner_type": owner_type, "owner_id": owner_id,
              "source_type": source_type, "last_synced_at": ts},
    )


async def _start_log(owner_type, owner_id, source_type, trigger) -> str:
    r = await db_client.post(
        _url("/rest/v1/sync_log"),
        headers=_headers({"Prefer": "return=representation"}),
        json={"owner_type": owner_type, "owner_id": owner_id,
              "source_type": source_type, "trigger": trigger, "status": "running"},
    )
    return r.json()[0]["id"]


async def _finish_log(log_id: str, status: str, records_synced: int, error: str | None = None) -> None:
    await db_client.patch(
        _url(f"/rest/v1/sync_log?id=eq.{log_id}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json={
            "status":         status,
            "records_synced": records_synced,
            "completed_at":   datetime.now(timezone.utc).isoformat(),
            "error_detail":   error,
        },
    )


# ── public entry point ────────────────────────────────────────────────────────

async def run_sync(
    owner_type: str,
    owner_id: str,
    source_type: str = "airtable",
    trigger: str = "manual",
    full: bool = False,
) -> dict:
    """
    Run a sync for one owner. Safe to call from any trigger — login, manual,
    webhook, or polling. Returns a summary dict.

    full=True forces a complete re-fetch regardless of cursor.
    """
    log_id = await _start_log(owner_type, owner_id, source_type, trigger)
    sync_started = datetime.now(timezone.utc).isoformat()

    try:
        creds = await _get_credentials(owner_type, owner_id, source_type)
        if not creds:
            raise ValueError(f"No credentials found for {owner_type}/{owner_id}/{source_type}")

        cursor = None if full else await _get_cursor(owner_type, owner_id, source_type)
        is_delta = cursor is not None

        async with httpx.AsyncClient(timeout=60.0) as client:
            if source_type == "airtable":
                connector = AirtableConnector(
                    api_token=creds["api_token"],
                    base_id=creds["base_id"],
                    client=client,
                )
            else:
                raise ValueError(f"Unsupported source_type: {source_type}")

            # ── Field mappings ────────────────────────────────────────────────
            mappings = await _get_mappings(owner_type, owner_id, source_type)
            if mappings is None:
                # First sync — auto-generate defaults from source schema
                schema_fields = await connector.fetch_asset_schema()
                mappings = default_mappings_from_schema(schema_fields)
                await save_default_mappings(owner_type, owner_id, source_type, mappings)
                log.info("Generated default field mappings for %s/%s", owner_type, owner_id)

            # ── Fetch ─────────────────────────────────────────────────────────
            raw_assets = await connector.fetch_assets(since=cursor if is_delta else None)
            raw_products = await connector.fetch_products()
            raw_item_types = await connector.fetch_item_types()

            # ── Normalize ─────────────────────────────────────────────────────
            norm_assets = [normalize_asset(r, mappings) for r in raw_assets]
            norm_products = [normalize_reference(r, "Product") for r in raw_products]
            norm_item_types = [normalize_reference(r, "Item") for r in raw_item_types]

            # ── Diff (delta only — full sync always writes everything) ──────────
            if is_delta:
                existing = await load_existing_hashes(owner_type, owner_id, source_type)
                assets_to_write, unchanged = find_changes(norm_assets, existing)
                log.info("Delta sync: %d changed, %d unchanged", len(assets_to_write), unchanged)
            else:
                assets_to_write = norm_assets
                log.info("Full sync: writing all %d records", len(assets_to_write))

            # ── Canonical ID linking (studio Airtable only) ───────────────────
            canonical_map: dict[str, str] = {}
            if owner_type == "studio" and source_type == "airtable":
                source_ids = [r["source_record_id"] for r in assets_to_write]
                if source_ids:
                    canonical_map = await get_or_create_canonical_ids(source_ids, owner_id)

            # ── Write ─────────────────────────────────────────────────────────
            await upsert_assets(owner_type, owner_id, source_type, assets_to_write, canonical_map)
            await upsert_products(owner_type, owner_id, source_type, norm_products)
            await upsert_item_types(owner_type, owner_id, source_type, norm_item_types)

            # ── Deletion detection ────────────────────────────────────────────
            # Assets: only on full sync (delta fetch is incomplete by design).
            # Products + item_types: always — they are always fetched in full.
            orphaned = await delete_orphaned_records(
                owner_type, owner_id, source_type,
                fetched_asset_ids={r["source_record_id"] for r in norm_assets},
                fetched_product_ids={r["source_record_id"] for r in norm_products},
                fetched_item_type_ids={r["source_record_id"] for r in norm_item_types},
                full_sync=not is_delta,
            )
            if orphaned:
                log.info("Orphan cleanup: %d rows deleted for %s/%s", orphaned, owner_type, owner_id)

        # ── Update cursor ─────────────────────────────────────────────────────
        await _save_cursor(owner_type, owner_id, source_type, sync_started)

        records_synced = len(assets_to_write)
        await _finish_log(log_id, "success", records_synced)
        log.info("Sync complete for %s/%s: %d assets written", owner_type, owner_id, records_synced)
        return {"status": "success", "records_synced": records_synced}

    except Exception as exc:
        log.exception("Sync failed for %s/%s", owner_type, owner_id)
        await _finish_log(log_id, "error", 0, str(exc))
        return {"status": "error", "error": str(exc)}
