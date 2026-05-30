from dotenv import load_dotenv
load_dotenv()

import asyncio
import logging

logging.basicConfig(level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, Request
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from fastapi.responses import FileResponse, JSONResponse

import httpx
from lib.crypto import decrypt_credentials
from lib.db import db_client, _url, _headers
from lib.auth import CurrentUser, get_current_user
from lib.sync.runner import run_sync
from routes.assets import router as assets_router
from routes.schedule import router as schedule_router
from routes.schema import router as schema_router
from routes.fields import router as fields_router
from routes.matrix import router as matrix_router
from routes.reviews import router as reviews_router
from routes.workflow_steps import router as workflow_steps_router
from routes.payload import router as payload_router
from routes.numbersbot import router as numbersbot_router
from routes.sync import router as sync_router, webhook_router as sync_webhook_router
from routes.user import router as user_router
from routes.init import router as init_router
from routes.auth import router as auth_router
from routes.work import router as work_router
from routes.synthetic import router as synthetic_router
from routes.connectors.jira_oauth import router as jira_oauth_router
from routes.attachments import router as attachments_router
from routes.lorebot import router as lorebot_router
from routes.handshake import router as handshake_router
from routes.members import router as members_router
from routes.admin import router as admin_router
from routes.scenario import router as scenario_router
from routes.estimate_share import router as estimate_share_router

log = logging.getLogger(__name__)


async def _poll_loop() -> None:
    """
    Background polling task. Disabled when SYNC_POLL_INTERVAL_SECONDS is unset or 0.
    When enabled, triggers a delta sync for every owner that has source credentials stored.

    Failure handling: exponential backoff up to 4× the base interval; escalates from
    warning → error after 3 consecutive failures so log aggregators can alert on it.
    """
    interval = int(os.environ.get("SYNC_POLL_INTERVAL_SECONDS", "3600"))
    if not interval:
        return
    log.info("Polling sync enabled — interval: %ds", interval)
    _MAX_BACKOFF = interval * 4
    _ERROR_THRESHOLD = 3
    consecutive_failures = 0
    while True:
        if consecutive_failures == 0:
            await asyncio.sleep(interval)
        else:
            backoff = min(interval * (2 ** (consecutive_failures - 1)), _MAX_BACKOFF)
            log.warning("Poll backoff: %ds after %d consecutive failure(s)", backoff, consecutive_failures)
            await asyncio.sleep(backoff)
        try:
            r = await db_client.get(
                _url("/rest/v1/source_credentials"),
                params={"select": "owner_type,owner_id,source_type", "owner_type": "eq.studio"},
                headers=_headers(),
            )
            if r.is_success:
                for row in r.json():
                    asyncio.create_task(
                        run_sync(
                            owner_type=row["owner_type"],
                            owner_id=row["owner_id"],
                            source_type=row["source_type"],
                            trigger="poll",
                            full=False,
                        )
                    )
            if consecutive_failures:
                log.info("Poll cycle recovered after %d consecutive failure(s)", consecutive_failures)
            consecutive_failures = 0
        except Exception as exc:
            consecutive_failures += 1
            if consecutive_failures >= _ERROR_THRESHOLD:
                log.error("Poll cycle error (%d consecutive): %s", consecutive_failures, exc)
            else:
                log.warning("Poll cycle error (%d consecutive): %s", consecutive_failures, exc)


async def _attachment_drain_loop() -> None:
    """
    Always-on loop that drains pending attachment copy jobs.
    Runs independently of sync polling so jobs process even when
    SYNC_POLL_INTERVAL_SECONDS is unset.
    """
    from lib.attachments import drain_attachment_jobs
    log.info("Attachment drain loop started — interval: 30s")
    while True:
        await asyncio.sleep(30)
        try:
            await drain_attachment_jobs()
        except Exception as exc:
            log.warning("Attachment drain error: %s", exc)


async def _attachment_purge_loop() -> None:
    """
    Nightly purge of storage blobs with no active dispatch reference.
    Disabled when PURGE_ATTACHMENTS_INTERVAL_HOURS is set to 0.
    """
    interval_hours = float(os.environ.get("PURGE_ATTACHMENTS_INTERVAL_HOURS", "24"))
    if not interval_hours:
        return
    interval_secs = interval_hours * 3600
    log.info("Attachment purge loop started — interval: %.1fh", interval_hours)
    await asyncio.sleep(interval_secs)
    while True:
        log.info("Attachment purge: starting")
        try:
            from lib.attachments import purge_orphaned_attachments
            result = await purge_orphaned_attachments()
            log.info("Attachment purge complete: %s", result)
        except Exception as exc:
            log.error("Attachment purge error: %s", exc)
        await asyncio.sleep(interval_secs)


async def _sync_log_trim_loop() -> None:
    """
    Nightly trim of sync_log rows. Keeps the N most recent rows per owner
    (default 100, configurable via SYNC_LOG_KEEP_ROWS). Disabled when
    SYNC_LOG_TRIM_INTERVAL_HOURS is set to 0.
    """
    interval_hours = float(os.environ.get("SYNC_LOG_TRIM_INTERVAL_HOURS", "24"))
    if not interval_hours:
        return
    keep_rows = int(os.environ.get("SYNC_LOG_KEEP_ROWS", "100"))
    interval_secs = interval_hours * 3600
    log.info("Sync log trim enabled — interval: %.1fh, keep: %d rows/owner", interval_hours, keep_rows)
    await asyncio.sleep(interval_secs)
    while True:
        log.info("Sync log trim: starting")
        try:
            r = await db_client.post(
                _url("/rest/v1/rpc/trim_sync_log"),
                headers=_headers(),
                json={"keep_rows": keep_rows},
            )
            if r.is_success:
                log.info("Sync log trim: deleted %d rows", r.json())
            else:
                log.error("Sync log trim failed: %s", r.text)
        except Exception as exc:
            log.error("Sync log trim error: %s", exc)
        await asyncio.sleep(interval_secs)


async def _scenario_generation_loop() -> None:
    """
    Picks up scenario sessions in pending_generation state and dispatches to the
    appropriate engine (AI or rule-based). Runs every 30s.
    Uses a durable DB status so generation survives worker restarts and proxy timeouts.
    """
    from lib.scenario.generator import run_generation
    from lib.scenario.deterministic import run_rule_based_generation
    log.info("Scenario generation loop started — interval: 30s")
    while True:
        await asyncio.sleep(30)
        try:
            r = await db_client.get(
                _url("/rest/v1/scenario_sessions"),
                params={
                    "ai_stage": "eq.pending_generation",
                    "status":   "eq.active",
                    "select":   "id,studio_id,scope_json,generation_mode",
                },
                headers=_headers(),
            )
            if not r.is_success:
                log.warning("Scenario generation loop — failed to fetch sessions: %s", r.text)
                continue
            sessions = r.json()
            for session in sessions:
                sid  = session["id"]
                mode = session.get("generation_mode", "ai")
                log.info("Scenario generation loop — picking up session %s (mode: %s)", sid, mode)
                await db_client.patch(
                    _url("/rest/v1/scenario_sessions"),
                    params={"id": f"eq.{sid}"},
                    json={"ai_stage": "generating"},
                    headers=_headers({"Prefer": "return=minimal"}),
                )
                fn = run_rule_based_generation if mode == "rule_based" else run_generation
                asyncio.create_task(_run_generation_task(
                    session_id=sid,
                    studio_id=session["studio_id"],
                    scope=session.get("scope_json") or {},
                    run_generation=fn,
                ))
        except Exception as exc:
            log.warning("Scenario generation loop error: %s", exc)


async def _run_generation_task(session_id: str, studio_id: str, scope: dict, run_generation) -> None:
    try:
        await run_generation(session_id, studio_id, scope)
        # Fetch counts to build the pivot message before transitioning stage.
        pivot_text = await _build_pivot_message(session_id, studio_id, scope)
        # Persist pivot then flip stage — order matters so the UI doesn't show
        # discussion state before the pivot message is readable.
        await db_client.post(
            _url("/rest/v1/scenario_messages"),
            json={"session_id": session_id, "studio_id": studio_id,
                  "role": "assistant", "content": pivot_text},
            headers=_headers({"Prefer": "return=minimal"}),
        )
        await db_client.patch(
            _url("/rest/v1/scenario_sessions"),
            params={"id": f"eq.{session_id}"},
            json={"ai_stage": "discussion"},
            headers=_headers({"Prefer": "return=minimal"}),
        )
        log.info("Scenario %s — generation complete, stage → discussion", session_id)
    except Exception as exc:
        log.error("Scenario %s — generation failed: %s", session_id, exc)
        await db_client.patch(
            _url("/rest/v1/scenario_sessions"),
            params={"id": f"eq.{session_id}"},
            json={"ai_stage": "generation_failed"},
            headers=_headers({"Prefer": "return=minimal"}),
        )


async def _build_pivot_message(session_id: str, studio_id: str, scope: dict) -> str:
    """
    Build the assistant pivot message shown after generation.
    Clearly states what was generated so the discussion model is not confused
    by prior scoping messages that said 'ready to build?'.
    """
    import asyncio as _asyncio
    # Request exact counts via Prefer: count=exact (PostgREST returns Content-Range header).
    count_headers = _headers({"Prefer": "count=exact", "Range-Unit": "items", "Range": "0-0"})
    products_r, assets_r, work_r = await _asyncio.gather(
        db_client.get(_url("/rest/v1/scenario_products"),
                      params={"session_id": f"eq.{session_id}", "select": "id,name,target_release_date",
                              "order": "created_at.asc"},
                      headers=_headers()),
        db_client.get(_url("/rest/v1/scenario_assets"),
                      params={"session_id": f"eq.{session_id}", "select": "id"},
                      headers=count_headers),
        db_client.get(_url("/rest/v1/scenario_work"),
                      params={"session_id": f"eq.{session_id}", "select": "id"},
                      headers=count_headers),
    )
    products = products_r.json() if products_r.is_success else []

    asset_count = _parse_count_header(assets_r)
    work_count  = _parse_count_header(work_r)

    # Derive actual horizon from work span rather than scope (earliest_ship has no pre-set horizon).
    from datetime import date as _date
    work_dates_r = await db_client.get(
        _url("/rest/v1/scenario_work"),
        params={"session_id": f"eq.{session_id}", "select": "end_date",
                "order": "end_date.desc", "limit": "1"},
        headers=_headers(),
    )
    horizon_str = "?"
    if work_dates_r.is_success and work_dates_r.json():
        try:
            last_end   = _date.fromisoformat(work_dates_r.json()[0]["end_date"])
            horizon_days = (last_end - _date.today()).days
            horizon_months = max(1, round(horizon_days / 30.44))
            horizon_str = str(horizon_months)
        except (ValueError, KeyError):
            pass

    product_names = ", ".join(p["name"] for p in products[:5])
    if len(products) > 5:
        product_names += f" … and {len(products) - 5} more"

    lines = [
        f"Scenario generated — {len(products)} product{'s' if len(products) != 1 else ''}, "
        f"{asset_count} asset{'s' if asset_count != 1 else ''}, "
        f"{work_count} work item{'s' if work_count != 1 else ''} "
        f"across a {horizon_str}-month horizon.",
    ]
    if product_names:
        lines.append(f"Products: {product_names}.")
    lines.append("What would you like to explore? I can analyze craft load, schedule overlaps, timeline risks, or anything else in the data.")
    return "\n".join(lines)


def _parse_count_header(response) -> int:
    """Extract total count from PostgREST Content-Range header, or fall back to len(body)."""
    cr = response.headers.get("content-range", "")
    # Format: "0-4/156"
    if "/" in cr:
        try:
            return int(cr.split("/")[1])
        except ValueError:
            pass
    try:
        return len(response.json())
    except Exception:
        return 0


async def _scenario_cleanup_loop() -> None:
    """
    Nightly deletion of expired scenario sessions. FKs cascade to all child tables.
    Disabled when SCENARIO_CLEANUP_INTERVAL_HOURS is set to 0.
    """
    interval_hours = float(os.environ.get("SCENARIO_CLEANUP_INTERVAL_HOURS", "24"))
    if not interval_hours:
        return
    interval_secs = interval_hours * 3600
    log.info("Scenario cleanup loop started — interval: %.1fh", interval_hours)
    await asyncio.sleep(interval_secs)
    while True:
        try:
            r = await db_client.delete(
                _url("/rest/v1/scenario_sessions"),
                params={"expires_at": "lt.now()"},
                headers=_headers({"Prefer": "return=minimal"}),
            )
            if r.is_success:
                log.info("Scenario cleanup: expired sessions deleted")
            else:
                log.warning("Scenario cleanup failed: %s", r.text)
        except Exception as exc:
            log.warning("Scenario cleanup error: %s", exc)
        await asyncio.sleep(interval_secs)


async def _schema_drift_loop() -> None:
    """
    Periodic schema drift detection. Compares live source schemas against stored
    field mappings and flags studios that need to review new/removed/changed fields.
    Configurable via SCHEMA_DRIFT_INTERVAL_HOURS (default 24, set 0 to disable).
    """
    interval_hours = float(os.environ.get("SCHEMA_DRIFT_INTERVAL_HOURS", "24"))
    if not interval_hours:
        return
    interval_secs = interval_hours * 3600
    log.info("Schema drift detection enabled — interval: %.1fh", interval_hours)
    # Stagger first run so it doesn't fire immediately on startup alongside sync.
    await asyncio.sleep(3600)
    while True:
        try:
            from lib.sync.schema_drift import run_schema_drift_check
            await run_schema_drift_check()
        except Exception as exc:
            log.warning("Schema drift check error: %s", exc)
        await asyncio.sleep(interval_secs)


async def _nightly_full_sync_loop() -> None:
    """
    Nightly full-reconciliation loop. Runs once per FULL_SYNC_INTERVAL_HOURS (default 24).
    Forces full=True so orphaned records are detected and removed even when webhooks miss events.
    Jira deletions are the primary beneficiary — Airtable also benefits from the extra safety net.
    Disabled when FULL_SYNC_INTERVAL_HOURS is set to 0.
    """
    interval_hours = float(os.environ.get("FULL_SYNC_INTERVAL_HOURS", "24"))
    if not interval_hours:
        return
    interval_secs = interval_hours * 3600
    log.info("Nightly full sync enabled — interval: %.1fh", interval_hours)
    # Stagger first run by half the interval so it doesn't coincide with startup
    await asyncio.sleep(interval_secs / 2)
    while True:
        log.info("Nightly full sync: starting reconciliation pass")
        try:
            r = await db_client.get(
                _url("/rest/v1/source_credentials"),
                params={"select": "owner_type,owner_id,source_type", "owner_type": "eq.studio"},
                headers=_headers(),
            )
            if r.is_success:
                for row in r.json():
                    asyncio.create_task(
                        run_sync(
                            owner_type=row["owner_type"],
                            owner_id=row["owner_id"],
                            source_type=row["source_type"],
                            trigger="scheduled_full",
                            full=True,
                        )
                    )
        except Exception as exc:
            log.error("Nightly full sync error: %s", exc)
        await asyncio.sleep(interval_secs)


_REQUIRED_VARS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_JWT_SECRET",
    "SUPABASE_ANON_KEY",
    "CREDENTIALS_ENCRYPTION_KEY",
]

_JIRA_VARS = [
    "JIRA_CLOUD_CLIENT_ID",
    "JIRA_CLOUD_CLIENT_SECRET",
    "JIRA_REDIRECT_URI",
]


def _validate_env() -> None:
    missing = [v for v in _REQUIRED_VARS if not os.environ.get(v)]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
    missing_jira = [v for v in _JIRA_VARS if not os.environ.get(v)]
    if missing_jira:
        log.warning("Jira OAuth not configured — missing: %s. Jira connector will be unavailable.", ", ".join(missing_jira))


@asynccontextmanager
async def lifespan(app: FastAPI):
    _validate_env()

    # Reset any scenario sessions that were stuck mid-generation when the
    # previous worker died. The generation loop will re-pick them up.
    try:
        await db_client.patch(
            _url("/rest/v1/scenario_sessions"),
            params={"ai_stage": "eq.generating"},
            json={"ai_stage": "pending_generation"},
            headers=_headers({"Prefer": "return=minimal"}),
        )
    except Exception as exc:
        log.warning("Startup: failed to reset stuck scenario sessions: %s", exc)

    poll_task        = asyncio.create_task(_poll_loop())
    nightly_task     = asyncio.create_task(_nightly_full_sync_loop())
    drain_task       = asyncio.create_task(_attachment_drain_loop())
    purge_task       = asyncio.create_task(_attachment_purge_loop())
    drift_task       = asyncio.create_task(_schema_drift_loop())
    trim_task        = asyncio.create_task(_sync_log_trim_loop())
    scenario_gen_task     = asyncio.create_task(_scenario_generation_loop())
    scenario_cleanup_task = asyncio.create_task(_scenario_cleanup_loop())
    yield
    poll_task.cancel()
    nightly_task.cancel()
    drain_task.cancel()
    purge_task.cancel()
    drift_task.cancel()
    trim_task.cancel()
    scenario_gen_task.cancel()
    scenario_cleanup_task.cancel()
    await db_client.aclose()


app = FastAPI(lifespan=lifespan)

_DEV_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:8000",
]
_cors_origins_env = os.environ.get("ALLOWED_ORIGINS", "")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()] or _DEV_ORIGINS

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Range", "Prefer"],
)

_auth = [Depends(get_current_user)]
app.include_router(assets_router,   prefix="/api/assets",   dependencies=_auth)
app.include_router(schedule_router, prefix="/api/schedule", dependencies=_auth)
app.include_router(schema_router,   prefix="/api/schema",   dependencies=_auth)
app.include_router(fields_router,   prefix="/api/setup",    dependencies=_auth)
app.include_router(matrix_router,   prefix="/api/setup",    dependencies=_auth)
app.include_router(reviews_router,        prefix="/api/reviews",         dependencies=_auth)
app.include_router(workflow_steps_router, prefix="/api/workflow-steps",   dependencies=_auth)
# payload router manages its own auth per-route: /receive/{token} is public,
# all other endpoints carry explicit Depends(require_studio)
app.include_router(payload_router,        prefix="/api/payloads")
app.include_router(numbersbot_router,     prefix="/api/numbersbot",  dependencies=_auth)
app.include_router(sync_router,           prefix="/api/sync",        dependencies=_auth)
app.include_router(user_router,           prefix="/api/user")
app.include_router(init_router,           prefix="/api/init",        dependencies=_auth)
app.include_router(work_router,           prefix="/api/work",         dependencies=_auth)
app.include_router(synthetic_router,      prefix="/api/synthetic",    dependencies=_auth)
# Webhook routes are public — protected by WEBHOOK_SECRET, not JWT
app.include_router(sync_webhook_router,   prefix="/api/sync")
# Auth routes are public — no JWT required
app.include_router(auth_router,           prefix="/api/auth")
# Jira OAuth: /initiate requires JWT; /callback is public (state-validated)
app.include_router(jira_oauth_router,     prefix="/api/connectors/jira/oauth")
# Attachment proxy: /asset/* requires studio JWT; /payload/* accepts studio or vendor JWT
app.include_router(attachments_router,    prefix="/api/attachments", dependencies=_auth)
app.include_router(lorebot_router,        prefix="/api/lorebot",     dependencies=_auth)
app.include_router(handshake_router,      prefix="/api/handshake",   dependencies=_auth)
# Members router manages its own auth per-route:
# GET /api/invite-code/{code}/resolve is public (rate-limited);
# all other /api/org/* routes carry explicit Depends(get_current_user).
app.include_router(members_router,        prefix="/api")
app.include_router(admin_router,          prefix="/api/admin")
app.include_router(scenario_router,       prefix="/api/scenario",    dependencies=_auth)
app.include_router(estimate_share_router, prefix="/api/estimate-shares", dependencies=_auth)


_REPLICATED_TABLE: dict[str, str] = {
    "assets":    "replicated_assets",
    "products":  "replicated_products",
    "itemTypes": "replicated_item_types",
}

_ENTITY_TYPE_MAP: dict[str, str] = {
    "assets":    "asset",
    "products":  "product",
    "itemTypes": "item_type",
}


@app.get("/api/records/{table_key}/{record_id}")
async def get_record_by_id(
    table_key: str, record_id: str, current_user: CurrentUser = Depends(get_current_user)
):
    replicated = _REPLICATED_TABLE.get(table_key)
    if not replicated:
        raise HTTPException(status_code=404, detail=f"Unknown table: {table_key}")
    entity_type = _ENTITY_TYPE_MAP[table_key]
    owner_type = current_user.role
    owner_id   = current_user.studio_id if current_user.role == "studio" else current_user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")

    ownership = await db_client.get(
        _url(f"/rest/v1/{replicated}"),
        params={
            "owner_type":       f"eq.{owner_type}",
            "owner_id":         f"eq.{owner_id}",
            "source_record_id": f"eq.{record_id}",
            "select":           "source_record_id",
        },
        headers=_headers(),
    )
    ownership.raise_for_status()
    if not ownership.json():
        raise HTTPException(status_code=404, detail="Record not found")

    creds_r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.airtable",
            "select":      "credentials",
        },
        headers=_headers(),
    )
    creds_rows = creds_r.json()
    if not creds_rows:
        raise HTTPException(status_code=403, detail="No source credentials found")
    creds = decrypt_credentials(creds_rows[0]["credentials"])

    entity_r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.airtable",
            "entity_type": f"eq.{entity_type}",
            "select":      "table_id",
        },
        headers=_headers(),
    )
    entity_rows = entity_r.json()
    if not entity_rows or not entity_rows[0].get("table_id"):
        raise HTTPException(status_code=404, detail="Entity definition not found")
    table_id = entity_rows[0]["table_id"]

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(
            f"https://api.airtable.com/v0/{creds['base_id']}/{table_id}/{record_id}",
            headers={"Authorization": f"Bearer {creds['api_token']}"},
        )
    if not r.is_success:
        raise HTTPException(status_code=404, detail="Record not found")
    rec = r.json()
    return {"id": rec["id"], "fields": rec.get("fields", {})}


# Public endpoint — supplies Supabase bootstrap config to the frontend.
# Anon key is intentionally public; JWT secret never leaves the server.
@app.get("/api/config")
async def get_config():
    base_id = os.environ.get("AIRTABLE_BASE_ID", "")
    return {
        "airtableUrl":     f"https://airtable.com/{base_id}" if base_id else None,
        "supabaseUrl":     os.environ.get("SUPABASE_URL", ""),
        "supabaseAnonKey": os.environ.get("SUPABASE_ANON_KEY", ""),
    }


@app.get("/health")
async def health_check():
    try:
        r = await db_client.get(
            _url("/rest/v1/studios"),
            params={"select": "id", "limit": "1"},
            headers=_headers(),
        )
        r.raise_for_status()
        return JSONResponse(status_code=200, content={"status": "ok"})
    except Exception as exc:
        log.error("Health check failed: %s", exc)
        return JSONResponse(status_code=503, content={"status": "unavailable"})



@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.error("Unhandled exception on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(status_code=500, content={"error": "Internal server error"})



# SPA fallback — serve React build for all non-API paths.
# File requests (JS/CSS/images) are served from dist; everything else gets index.html
# so React Router handles client-side navigation.
_DIST = Path("frontend/dist")

@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    file = _DIST / full_path
    if file.is_file():
        return FileResponse(file)
    return FileResponse(_DIST / "index.html")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
