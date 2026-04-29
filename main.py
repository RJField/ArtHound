from dotenv import load_dotenv
load_dotenv()

import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from lib.airtable import http_client
from routes.assets import router as assets_router
from routes.schedule import router as schedule_router
from routes.schema import router as schema_router
from routes.setup import router as setup_router
from routes.reviews import router as reviews_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await http_client.aclose()


app = FastAPI(lifespan=lifespan)

app.include_router(assets_router, prefix="/api/assets")
app.include_router(schedule_router, prefix="/api/schedule")
app.include_router(schema_router, prefix="/api/schema")
app.include_router(setup_router, prefix="/api/setup")
app.include_router(reviews_router, prefix="/api/reviews")


@app.get("/api/config")
async def get_config():
    base_id = os.environ.get("AIRTABLE_BASE_ID", "")
    return {"airtableUrl": f"https://airtable.com/{base_id}" if base_id else None}


@app.get("/api/debug")
async def debug():
    token = os.environ.get("AIRTABLE_TOKEN", "")
    base_id = os.environ.get("AIRTABLE_BASE_ID", "")
    headers = {"Authorization": f"Bearer {token}"}
    results = {}

    try:
        r = await http_client.get("https://api.airtable.com/v0/meta/whoami", headers=headers)
        results["whoami"] = {"status": r.status_code, "body": r.json()}
    except Exception as e:
        results["whoami"] = {"error": str(e)}

    try:
        r = await http_client.get("https://api.airtable.com/v0/meta/bases", headers=headers)
        results["bases"] = {"status": r.status_code, "body": r.json()}
    except Exception as e:
        results["bases"] = {"error": str(e)}

    try:
        r = await http_client.get(
            f"https://api.airtable.com/v0/meta/bases/{base_id}/tables", headers=headers
        )
        body = r.json()
        results["tables"] = {
            "status": r.status_code,
            "names": [t["name"] for t in body.get("tables", [])] if "tables" in body else body,
        }
    except Exception as e:
        results["tables"] = {"error": str(e)}

    try:
        table = os.environ.get("TABLE_ASSETS", "[Robin] Assets")
        r = await http_client.get(
            f"https://api.airtable.com/v0/{base_id}/{table}",
            headers=headers,
            params={"maxRecords": "1"},
        )
        results["records"] = {"status": r.status_code, "body": r.json()}
    except Exception as e:
        results["records"] = {"error": str(e)}

    return {
        "token_prefix": token[:20] + "…" if token else "",
        "base_id": base_id,
        "results": results,
    }


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(status_code=500, content={"error": str(exc)})


# Static files last so API routes take precedence
app.mount("/", StaticFiles(directory="public", html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
