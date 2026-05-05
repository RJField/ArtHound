from dotenv import load_dotenv
load_dotenv()

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, Request
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from fastapi.responses import FileResponse, JSONResponse

from lib.airtable import http_client
from lib.crypto import decrypt_credentials
from lib.db import db_client, _url, _headers
from lib.auth import CurrentUser, get_current_user
from lib.sync.runner import run_sync
from routes.assets import router as assets_router
from routes.schedule import router as schedule_router
from routes.schema import router as schema_router
from routes.setup import router as setup_router
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

log = logging.getLogger(__name__)


async def _poll_loop() -> None:
    """
    Background polling task. Disabled when SYNC_POLL_INTERVAL_SECONDS is unset or 0.
    When enabled, triggers a delta sync for every owner that has source credentials stored.
    """
    interval = int(os.environ.get("SYNC_POLL_INTERVAL_SECONDS", "0"))
    if not interval:
        return
    log.info("Polling sync enabled — interval: %ds", interval)
    while True:
        await asyncio.sleep(interval)
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
        except Exception as exc:
            log.warning("Poll cycle error: %s", exc)


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
            log.warning("Nightly full sync error: %s", exc)
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
    poll_task        = asyncio.create_task(_poll_loop())
    nightly_task     = asyncio.create_task(_nightly_full_sync_loop())
    yield
    poll_task.cancel()
    nightly_task.cancel()
    await http_client.aclose()
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
app.include_router(setup_router,    prefix="/api/setup",    dependencies=_auth)
app.include_router(reviews_router,        prefix="/api/reviews",         dependencies=_auth)
app.include_router(workflow_steps_router, prefix="/api/workflow-steps",   dependencies=_auth)
# payload router manages its own auth per-route: /receive/{token} is public,
# all other endpoints carry explicit Depends(require_studio)
app.include_router(payload_router,        prefix="/api/payloads")
app.include_router(numbersbot_router,     prefix="/api/numbersbot",  dependencies=_auth)
app.include_router(sync_router,           prefix="/api/sync",        dependencies=_auth)
app.include_router(user_router,           prefix="/api/user",        dependencies=_auth)
app.include_router(init_router,           prefix="/api/init",        dependencies=_auth)
app.include_router(work_router,           prefix="/api/work",         dependencies=_auth)
app.include_router(synthetic_router,      prefix="/api/synthetic",    dependencies=_auth)
# Webhook routes are public — protected by WEBHOOK_SECRET, not JWT
app.include_router(sync_webhook_router,   prefix="/api/sync")
# Auth routes are public — no JWT required
app.include_router(auth_router,           prefix="/api/auth")
# Jira OAuth: /initiate requires JWT; /callback is public (state-validated)
app.include_router(jira_oauth_router,     prefix="/api/connectors/jira/oauth")


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

    r = await http_client.get(
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


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": str(exc)})



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
