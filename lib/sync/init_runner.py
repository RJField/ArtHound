"""
Init sync runner — full sync with per-batch progress writes to init_jobs.

Designed for the first-time init and reset flows. Runs as a FastAPI BackgroundTask
but maintains durable state in init_jobs so progress survives server restarts if
the process is eventually moved to a persistent queue.
"""

import logging
from datetime import datetime, timezone

import httpx

from lib.canonical import get_or_create_canonical_ids
from lib.crypto import decrypt_credentials
from lib.db import db_client, _url, _headers
from lib.sync.connectors.airtable import AirtableConnector, build_filter_formula
from lib.sync.normalizer import default_mappings_from_schema, normalize_asset, normalize_reference
from lib.sync.runner import (
    _get_entity_definitions,
    _get_mappings,
    _finish_log,
    _save_cursor,
    _start_log,
)
from lib.sync.writer import (
    delete_orphaned_records,
    save_default_mappings,
    upsert_assets,
    upsert_item_types,
    upsert_products,
)

log = logging.getLogger(__name__)

REQUIRED_SLOTS = {"name", "status", "item_type"}
_BATCH_SIZE = 50
_PAGE_DELAY_S = 0.25  # ~4 req/s — safely under Airtable's 5 req/s limit


async def _get_creds(owner_type: str, owner_id: str, source_type: str) -> dict | None:
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
    return decrypt_credentials(rows[0]["credentials"]) if rows else None


async def _update_job(job_id: str, **kwargs) -> None:
    await db_client.patch(
        _url(f"/rest/v1/init_jobs?id=eq.{job_id}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json=kwargs,
    )


async def _set_initialized_at(owner_type: str, owner_id: str) -> None:
    if owner_type != "studio":
        return
    await db_client.patch(
        _url(f"/rest/v1/studios?id=eq.{owner_id}"),
        headers=_headers({"Prefer": "return=minimal"}),
        json={"initialized_at": datetime.now(timezone.utc).isoformat()},
    )


async def run_init_sync(
    job_id: str,
    owner_type: str,
    owner_id: str,
    source_type: str = "airtable",
) -> None:
    """
    Full sync with progress written to init_jobs.progress_current after each batch.
    Sets studios.initialized_at on completion.
    """
    sync_started = datetime.now(timezone.utc).isoformat()
    log_id = None

    try:
        await _update_job(
            job_id,
            status="running",
            phase="sync",
            started_at=sync_started,
        )

        creds = await _get_creds(owner_type, owner_id, source_type)
        if not creds:
            raise ValueError(f"No credentials found for {owner_type}/{owner_id}/{source_type}")

        entity_defs   = await _get_entity_definitions(owner_type, owner_id, source_type)
        asset_def     = entity_defs.get("asset")
        product_def   = entity_defs.get("product")
        item_type_def = entity_defs.get("item_type")
        task_def      = entity_defs.get("task")

        async with httpx.AsyncClient(timeout=120.0) as client:
            if source_type == "airtable":
                connector = AirtableConnector(
                    api_token=creds["api_token"],
                    base_id=creds["base_id"],
                    client=client,
                    page_delay_s=_PAGE_DELAY_S,
                )
            else:
                raise ValueError(f"Unsupported source_type: {source_type}")

            schema_fields = await connector.fetch_asset_schema(
                table_id=asset_def["table_id"] if asset_def else None
            )
            field_type_map = {f.name: f.type for f in schema_fields}

            mappings = await _get_mappings(owner_type, owner_id, source_type)
            if mappings is None:
                mappings = default_mappings_from_schema(schema_fields)
                await save_default_mappings(owner_type, owner_id, source_type, mappings)

            if asset_def:
                formula = build_filter_formula(asset_def.get("filters") or [])
                raw_assets = await connector.fetch_entity(
                    table_id=asset_def["table_id"],
                    filter_formula=formula,
                )
            else:
                raw_assets = await connector.fetch_assets()

            if product_def:
                formula = build_filter_formula(product_def.get("filters") or [])
                raw_products = await connector.fetch_entity(
                    table_id=product_def["table_id"],
                    filter_formula=formula,
                )
            else:
                raw_products = []

            if item_type_def:
                formula = build_filter_formula(item_type_def.get("filters") or [])
                raw_item_types = await connector.fetch_entity(
                    table_id=item_type_def["table_id"],
                    filter_formula=formula,
                )
            else:
                raw_item_types = []

        norm_products = [normalize_reference(r, "Product") for r in raw_products]
        norm_item_types = [normalize_reference(r, "Item") for r in raw_item_types]

        reference_resolver = {
            **{r["source_record_id"]: r["name"] for r in norm_products if r["name"]},
            **{r["source_record_id"]: r["name"] for r in norm_item_types if r["name"]},
        }

        norm_assets = [
            normalize_asset(
                r, mappings,
                field_type_map=field_type_map,
                reference_resolver=reference_resolver,
            )
            for r in raw_assets
        ]

        total = len(norm_assets)
        await _update_job(job_id, progress_total=total)
        log_id = await _start_log(owner_type, owner_id, source_type, "init")
        canonical_map: dict[str, str] = {}

        for i in range(0, max(total, 1), _BATCH_SIZE):
            batch = norm_assets[i : i + _BATCH_SIZE]

            if owner_type == "studio" and source_type == "airtable":
                source_ids = [r["source_record_id"] for r in batch]
                if source_ids:
                    batch_canonical = await get_or_create_canonical_ids(source_ids, owner_id)
                    canonical_map.update(batch_canonical)

            await upsert_assets(owner_type, owner_id, source_type, batch, canonical_map)
            await _update_job(job_id, progress_current=min(i + _BATCH_SIZE, total))

        await upsert_products(owner_type, owner_id, source_type, norm_products)
        await upsert_item_types(owner_type, owner_id, source_type, norm_item_types)

        await delete_orphaned_records(
            owner_type, owner_id, source_type,
            fetched_asset_ids={r["source_record_id"] for r in norm_assets},
            fetched_product_ids={r["source_record_id"] for r in norm_products},
            fetched_item_type_ids={r["source_record_id"] for r in norm_item_types},
            full_sync=True,
        )

        await _save_cursor(owner_type, owner_id, source_type, sync_started)
        if log_id:
            await _finish_log(log_id, "success", total)

        await _set_initialized_at(owner_type, owner_id)
        await _update_job(
            job_id,
            status="completed",
            phase="done",
            progress_current=total,
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
        log.info("Init sync complete for %s/%s: %d assets", owner_type, owner_id, total)

    except Exception as exc:
        log.exception("Init sync failed for %s/%s", owner_type, owner_id)
        err = str(exc)
        if log_id:
            await _finish_log(log_id, "error", 0, err)
        await _update_job(
            job_id,
            status="error",
            error_log=[err],
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
