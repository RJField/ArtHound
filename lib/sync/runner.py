"""
Sync runner — trigger-agnostic orchestrator.
Call run_sync() from login, manual refresh, webhook, or polling scheduler.
"""

import logging
import os
from datetime import datetime, timezone

import httpx

from lib.canonical import get_or_create_canonical_ids
from lib.crypto import decrypt_credentials
from lib.db import db_client, _url, _headers
from lib.sync.connector import BaseConnector
from lib.sync.connectors.airtable import AirtableConnector
from lib.sync.differ import find_changes
from lib.sync.normalizer import (
    default_mappings_from_schema,
    normalize_asset,
    normalize_reference,
    normalize_work,
)
from lib.sync.writer import (
    delete_orphaned_records,
    load_existing_hashes,
    save_default_mappings,
    upsert_assets,
    upsert_item_types,
    upsert_products,
    upsert_work,
)

log = logging.getLogger(__name__)


# ── connector factory ─────────────────────────────────────────────────────────

def _build_connector(source_type: str, creds: dict, client: httpx.AsyncClient) -> BaseConnector:
    if source_type == "airtable":
        return AirtableConnector(
            api_token=creds["api_token"],
            base_id=creds["base_id"],
            client=client,
        )
    if source_type == "jira":
        from lib.sync.connectors.jira import JiraConnector
        return JiraConnector(
            access_token=creds["access_token"],
            client=client,
            cloud_id=creds.get("cloud_id"),
            deployment=creds.get("deployment", "cloud"),
            instance_url=creds.get("instance_url"),
        )
    raise ValueError(f"Unsupported source_type: {source_type}")


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
        return decrypt_credentials(rows[0]["credentials"])

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


async def _get_entity_definitions(owner_type: str, owner_id: str, source_type: str) -> dict:
    """
    Return {entity_type: definition} for all configured entity definitions.
    Empty dict if none configured — callers fall back to config.tables.
    """
    r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": f"eq.{source_type}",
            "select":      "entity_type,table_id,table_name,filters,jql_filter,parent_entity_type,rel_field_id,rel_field_name,rel_direction,item_type_source,item_type_field_id,item_type_field_name",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    data = r.json()
    if not isinstance(data, list):
        log.error("_get_entity_definitions unexpected response: %s", data)
        return {}
    return {row["entity_type"]: row for row in data}


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


async def _save_cursor(owner_type: str, owner_id: str, source_type: str, ts: str, full: bool = False) -> None:
    row: dict = {"owner_type": owner_type, "owner_id": owner_id,
                 "source_type": source_type, "last_synced_at": ts}
    if full:
        row["last_full_sync_at"] = ts
    await db_client.post(
        _url("/rest/v1/sync_cursors?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json=row,
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


# ── field-derived item types ──────────────────────────────────────────────────

from lib.sync.connector import RawRecord as _RawRecord

def _extract_field_item_types(raw_assets: list, field_id: str) -> list:
    """
    Derive item types from the distinct values of a single field across all asset records.
    Handles string values, {id,name} objects, and arrays of either.
    source_record_id is the field value's own ID (or the string itself).
    """
    seen: dict[str, str] = {}  # source_record_id → name

    for asset in raw_assets:
        val = asset.fields.get(field_id)
        if val is None:
            continue
        items = val if isinstance(val, list) else [val]
        for item in items:
            if isinstance(item, dict):
                iid  = str(item.get("id") or item.get("key") or item.get("value") or "").strip()
                name = (item.get("name") or item.get("value") or iid).strip()
            elif isinstance(item, str):
                iid  = item.strip()
                name = item.strip()
            else:
                continue
            if iid and iid not in seen:
                seen[iid] = name

    return [
        _RawRecord(source_record_id=iid, fields={"name": name})
        for iid, name in seen.items()
    ]


# ── public entry points ───────────────────────────────────────────────────────

async def sync_single_asset(
    owner_type: str,
    owner_id: str,
    source_record_id: str,
    source_type: str = "airtable",
) -> dict:
    """
    Re-sync one asset record without triggering a full sync.
    Pulls fresh data from the source tool, normalizes it, and upserts into replicated_assets.
    Used for targeted refresh (e.g. 410 attachment URL expiry recovery).
    """
    try:
        creds = await _get_credentials(owner_type, owner_id, source_type)
        if not creds:
            raise ValueError(f"No credentials found for {owner_type}/{owner_id}/{source_type}")

        entity_defs = await _get_entity_definitions(owner_type, owner_id, source_type)
        asset_def = entity_defs.get("asset")
        table_id = asset_def["table_id"] if asset_def else None

        async with httpx.AsyncClient(timeout=60.0) as client:
            if source_type == "jira":
                from lib.token_refresh import get_jira_token
                creds = await get_jira_token(owner_type, owner_id, client)

            connector = _build_connector(source_type, creds, client)

            raw = await connector.fetch_single_asset(source_record_id, table_id=table_id)
            if raw is None:
                log.warning("sync_single_asset: record %s not found in source", source_record_id)
                return {"status": "not_found"}

            schema_fields = await connector.fetch_asset_schema(table_id=table_id)
            field_type_map: dict[str, str] = {}
            for _f in schema_fields:
                field_type_map[_f.name] = _f.type
                if _f.id != _f.name:
                    field_type_map[_f.id] = _f.type

            mappings = await _get_mappings(owner_type, owner_id, source_type)
            if mappings is None:
                mappings = default_mappings_from_schema(
                    schema_fields, source_type=source_type, paw_level="asset"
                )

        # Build reference resolver from already-replicated reference data — no extra source API calls.
        r_prods = await db_client.get(
            _url("/rest/v1/replicated_products"),
            params={
                "owner_type":  f"eq.{owner_type}",
                "owner_id":    f"eq.{owner_id}",
                "source_type": f"eq.{source_type}",
                "select":      "source_record_id,name",
            },
            headers=_headers(),
        )
        r_types = await db_client.get(
            _url("/rest/v1/replicated_item_types"),
            params={
                "owner_type":  f"eq.{owner_type}",
                "owner_id":    f"eq.{owner_id}",
                "source_type": f"eq.{source_type}",
                "select":      "source_record_id,name",
            },
            headers=_headers(),
        )
        reference_resolver = {
            **{row["source_record_id"]: row["name"] for row in (r_prods.json() or []) if row.get("name")},
            **{row["source_record_id"]: row["name"] for row in (r_types.json() or []) if row.get("name")},
        }

        if source_type == "jira":
            from lib.connectors.adapters.jira import JiraFieldAdapter
            field_adapter = JiraFieldAdapter()
        else:
            field_adapter = None

        product_rel_field_id: str | None = None
        if asset_def and asset_def.get("rel_direction") == "child_holds_link":
            if source_type == "airtable":
                product_rel_field_id = asset_def.get("rel_field_name") or asset_def.get("rel_field_id") or None
            else:
                product_rel_field_id = asset_def.get("rel_field_id") or None
        elif source_type == "jira" and entity_defs.get("product"):
            product_rel_field_id = (asset_def.get("rel_field_id") or "parent") if asset_def else "parent"

        _excluded: set[str] = {
            key
            for m in mappings if m.get("ingest_suppressed")
            for key in (m.get("source_field_id"), m.get("source_field_name"))
            if key
        }

        norm = normalize_asset(
            raw, mappings,
            field_type_map=field_type_map,
            reference_resolver=reference_resolver,
            adapter=field_adapter,
            product_rel_field_id=product_rel_field_id,
            suppressed_names=_excluded or None,
        )

        canonical_map: dict[str, str] = {}
        if owner_type == "studio" and source_type in ("airtable", "jira"):
            canonical_map = await get_or_create_canonical_ids([source_record_id], owner_id)

        await upsert_assets(owner_type, owner_id, source_type, [norm], canonical_map)

        log.info("sync_single_asset: refreshed %s for %s/%s", source_record_id, owner_type, owner_id)
        return {"status": "success"}

    except Exception as exc:
        log.exception("sync_single_asset failed for %s/%s record %s", owner_type, owner_id, source_record_id)
        return {"status": "error", "error": str(exc)}


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

        entity_defs   = await _get_entity_definitions(owner_type, owner_id, source_type)
        asset_def     = entity_defs.get("asset")
        product_def   = entity_defs.get("product")
        item_type_def = entity_defs.get("item_type")
        work_def      = entity_defs.get("work")

        # Jira requires entity definitions to build a valid JQL query — skip if not yet configured.
        if source_type == "jira" and not asset_def:
            log.info("Skipping sync for %s/%s — Jira entity definitions not configured yet", owner_type, owner_id)
            await _finish_log(log_id, "success", 0)
            return {"status": "skipped", "reason": "entity_definitions_not_configured"}

        async with httpx.AsyncClient(timeout=60.0) as client:
            # Refresh OAuth tokens before building connector (Jira only for now)
            if source_type == "jira":
                from lib.token_refresh import get_jira_token
                creds = await get_jira_token(owner_type, owner_id, client)

            connector = _build_connector(source_type, creds, client)

            # ── Field schema + mappings ───────────────────────────────────────
            schema_fields = await connector.fetch_asset_schema(
                table_id=asset_def["table_id"] if asset_def else None
            )
            field_type_map: dict[str, str] = {}
            for _f in schema_fields:
                field_type_map[_f.name] = _f.type  # display name (Airtable)
                if _f.id != _f.name:
                    field_type_map[_f.id] = _f.type  # API field ID (Jira)

            mappings = await _get_mappings(owner_type, owner_id, source_type)
            if mappings is None:
                mappings = default_mappings_from_schema(
                    schema_fields, source_type=source_type, paw_level="asset"
                )
                await save_default_mappings(owner_type, owner_id, source_type, mappings)
                log.info("Generated default field mappings for %s/%s", owner_type, owner_id)

            # Build excluded field set from suppressed mappings so connectors can
            # strip them at record construction time (v1 client-side; v2 API-level).
            excluded_field_ids: set[str] = {
                key
                for m in mappings if m.get("ingest_suppressed")
                for key in (m.get("source_field_id"), m.get("source_field_name"))
                if key
            }

            # ── Fetch — use entity definitions when available, else config.tables
            if asset_def:
                raw_assets = await connector.fetch_entity(
                    table_id=asset_def["table_id"],
                    filter_formula=connector.build_entity_filter(asset_def),
                    since=cursor if is_delta else None,
                    excluded_field_ids=excluded_field_ids or None,
                )
            else:
                raw_assets = await connector.fetch_assets(since=cursor if is_delta else None)

            if product_def:
                raw_products = await connector.fetch_entity(
                    table_id=product_def["table_id"],
                    filter_formula=connector.build_entity_filter(product_def),
                )
            else:
                raw_products = await connector.fetch_products()

            if item_type_def and item_type_def.get("item_type_source") == "field_values":
                # Derive item types from a field on asset records — no separate API call.
                # Must run after raw_assets is populated.
                raw_item_types = _extract_field_item_types(
                    raw_assets, item_type_def["item_type_field_id"]
                )
            elif item_type_def:
                raw_item_types = await connector.fetch_entity(
                    table_id=item_type_def["table_id"],
                    filter_formula=connector.build_entity_filter(item_type_def),
                )
            else:
                raw_item_types = []

            # Work: always fetch in full — no delta support yet; work counts are
            # typically small and full resolution is simpler than partial resolvers.
            if work_def:
                raw_work = await connector.fetch_entity(
                    table_id=work_def["table_id"],
                    filter_formula=connector.build_entity_filter(work_def),
                    excluded_field_ids=excluded_field_ids or None,
                )
            else:
                raw_work = []

            # ── Normalize reference entities first ────────────────────────────
            # Reference tables are always fetched in full and normalized before
            # assets so their IDs are available for linked record resolution.
            norm_products = [normalize_reference(r, "Product") for r in raw_products]
            norm_item_types = [normalize_reference(r, "Item") for r in raw_item_types]

            # Build resolver from synced reference data so the asset normalizer
            # can resolve linked record IDs to display names without extra API calls.
            reference_resolver = {
                **{r["source_record_id"]: r["name"] for r in norm_products if r["name"]},
                **{r["source_record_id"]: r["name"] for r in norm_item_types if r["name"]},
            }

            # Extend resolver with records from any other linked tables in the asset
            # schema (e.g. Team, Vendor, Department). Airtable only — Jira linked
            # records carry display names inline and don't need this path.
            if source_type == "airtable":
                covered_table_ids: set[str] = {
                    d["table_id"] for d in (asset_def, product_def) if d and d.get("table_id")
                }
                if item_type_def and item_type_def.get("item_type_source") != "field_values":
                    if item_type_def.get("table_id"):
                        covered_table_ids.add(item_type_def["table_id"])

                extra_linked_table_ids: set[str] = {
                    sf.options.get("linkedTableId")
                    for sf in schema_fields
                    if sf.type == "multipleRecordLinks" and sf.options.get("linkedTableId")
                } - covered_table_ids

                for _tid in extra_linked_table_ids:
                    try:
                        extra_recs = await connector.fetch_entity(table_id=_tid)
                        for r in extra_recs:
                            name = next(
                                (v for v in r.fields.values() if isinstance(v, str) and v.strip()),
                                None,
                            )
                            if name:
                                reference_resolver[r.source_record_id] = name
                        log.debug("Reference resolver: +%d records from linked table %s", len(extra_recs), _tid)
                    except Exception:
                        log.warning("Could not fetch linked table %s for reference resolver", _tid)

            # ── Normalize assets ──────────────────────────────────────────────
            # Resolve the field adapter for this connector so the normalizer
            # can deserialize source-specific field value shapes correctly.
            if source_type == "jira":
                from lib.connectors.adapters.jira import JiraFieldAdapter
                field_adapter = JiraFieldAdapter()
            else:
                field_adapter = None  # normalizer defaults to AirtableFieldAdapter

            # If the asset entity definition specifies a rel_field that links each
            # asset to its parent product (child_holds_link direction), use that field
            # to drive the product slot instead of alias-based detection.
            product_rel_field_id: str | None = None
            if asset_def and asset_def.get("rel_direction") == "child_holds_link":
                if source_type == "airtable":
                    # Airtable record field keys are display names, not field IDs.
                    # rel_field_id stores the Airtable fldXXX ID which never matches
                    # field_name in the normalizer guard — use rel_field_name instead.
                    product_rel_field_id = asset_def.get("rel_field_name") or asset_def.get("rel_field_id") or None
                else:
                    product_rel_field_id = asset_def.get("rel_field_id") or None
            elif source_type == "jira" and product_def:
                # Jira: asset issues always reference their Epic/parent via the "parent"
                # field. Fall back to it when no explicit rel is stored in the entity def.
                product_rel_field_id = asset_def.get("rel_field_id") or "parent"

            norm_assets = [
                normalize_asset(
                    r, mappings,
                    field_type_map=field_type_map,
                    reference_resolver=reference_resolver,
                    adapter=field_adapter,
                    product_rel_field_id=product_rel_field_id,
                    suppressed_names=excluded_field_ids or None,
                )
                for r in raw_assets
            ]

            # ── Diff (delta only — full sync always writes everything) ──────────
            if is_delta:
                existing = await load_existing_hashes(owner_type, owner_id, source_type)
                assets_to_write, unchanged = find_changes(norm_assets, existing)
                log.info("Delta sync: %d changed, %d unchanged", len(assets_to_write), unchanged)
            else:
                assets_to_write = norm_assets
                log.info("Full sync: writing all %d records", len(assets_to_write))

            # ── Canonical ID linking (all studio source types) ───────────────
            canonical_map: dict[str, str] = {}
            if owner_type == "studio" and source_type in ("airtable", "jira"):
                source_ids = [r["source_record_id"] for r in assets_to_write]
                if source_ids:
                    canonical_map = await get_or_create_canonical_ids(source_ids, owner_id)

            # ── Write ─────────────────────────────────────────────────────────
            await upsert_assets(owner_type, owner_id, source_type, assets_to_write, canonical_map)
            await upsert_products(owner_type, owner_id, source_type, norm_products)
            await upsert_item_types(owner_type, owner_id, source_type, norm_item_types)

            work_rel_field = work_def.get("rel_field_name") if work_def else None
            norm_work = [
                normalize_work(r, rel_field_name=work_rel_field, asset_canonical_map=canonical_map)
                for r in raw_work
            ]
            await upsert_work(owner_type, owner_id, source_type, norm_work)

            # ── Deletion detection ────────────────────────────────────────────
            # Assets: only on full sync (delta fetch is incomplete by design).
            # Products + item_types: always — they are always fetched in full.
            orphaned = await delete_orphaned_records(
                owner_type, owner_id, source_type,
                fetched_asset_ids={r["source_record_id"] for r in norm_assets},
                fetched_product_ids={r["source_record_id"] for r in norm_products},
                fetched_item_type_ids={r["source_record_id"] for r in norm_item_types},
                fetched_work_ids={r["source_record_id"] for r in norm_work} if not is_delta else None,
                full_sync=not is_delta,
            )
            if orphaned:
                log.info("Orphan cleanup: %d rows deleted for %s/%s", orphaned, owner_type, owner_id)

        # ── Update cursor ─────────────────────────────────────────────────────
        await _save_cursor(owner_type, owner_id, source_type, sync_started, full=not is_delta)

        records_synced = len(assets_to_write)
        await _finish_log(log_id, "success", records_synced)
        log.info("Sync complete for %s/%s: %d assets written", owner_type, owner_id, records_synced)
        return {"status": "success", "records_synced": records_synced}

    except Exception as exc:
        log.exception("Sync failed for %s/%s", owner_type, owner_id)
        await _finish_log(log_id, "error", 0, str(exc))
        return {"status": "error", "error": str(exc)}
