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
                params={"select": "owner_type,owner_id,source_type"},
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    poll_task = asyncio.create_task(_poll_loop())
    yield
    poll_task.cancel()
    await http_client.aclose()
    await db_client.aclose()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:8000",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
# Webhook routes are public — protected by WEBHOOK_SECRET, not JWT
app.include_router(sync_webhook_router,   prefix="/api/sync")
# Auth routes are public — no JWT required
app.include_router(auth_router,           prefix="/api/auth")


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


# User-uploaded screenshots — stored outside dist so they survive rebuilds.
# URL pattern /reviews/{filename} kept intentionally so existing Airtable
# attachment URLs remain valid.
_MEDIA = Path("media")

@app.get("/reviews/{filename}")
async def serve_screenshot(filename: str):
    file = _MEDIA / "reviews" / filename
    if not file.is_file():
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(file)


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
