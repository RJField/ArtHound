import base64
import os
import random
import string
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from lib.airtable import select_all, create_records, update_records
import config

router = APIRouter()

SCREENSHOTS_DIR = Path(__file__).parent.parent / "public" / "reviews"
SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)


def _server_url() -> str:
    return os.environ.get("SERVER_URL") or f"http://localhost:{os.environ.get('PORT', '3000')}"


class ReviewSubmitBody(BaseModel):
    assetName: Optional[str] = None
    sceneFile: Optional[str] = None
    artist: Optional[str] = None
    notes: Optional[str] = None
    screenshot: Optional[str] = None  # base64-encoded PNG


@router.post("/submit")
async def submit_review(body: ReviewSubmitBody):
    asset_link = []
    if body.assetName:
        escaped = body.assetName.replace('"', '\\"')
        matches = await select_all(
            config.tables["assets"],
            {"filterByFormula": f'{{Name}} = "{escaped}"', "maxRecords": 1, "fields": ["Name"]},
        )
        if matches:
            asset_link = [matches[0]["id"]]

    screenshot_file = None
    if body.screenshot:
        buf = base64.b64decode(body.screenshot)
        rand = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
        screenshot_file = f"{int(datetime.now().timestamp() * 1000)}_{rand}.png"
        (SCREENSHOTS_DIR / screenshot_file).write_bytes(buf)

    fields: dict = {
        "Scene File": body.sceneFile or "",
        "Artist": body.artist or "",
        "Notes": body.notes or "",
        "Status": "Pending",
        "Submitted At": datetime.now(timezone.utc).isoformat(),
    }
    if asset_link:
        fields["Assets"] = asset_link
    if screenshot_file:
        fields["Attachments"] = [{"url": f"{_server_url()}/reviews/{screenshot_file}"}]

    records = await create_records(config.tables["reviews"], [fields])
    return {"ok": True, "id": records[0]["id"]}


@router.get("/")
async def get_reviews():
    records = await select_all(
        config.tables["reviews"],
        {"sort": [{"field": "Submitted At", "direction": "desc"}]},
    )

    asset_ids = list({
        aid for r in records for aid in (r["fields"].get("Assets") or [])
    })

    asset_name_map: dict = {}
    if asset_ids:
        formula = ",".join(f'RECORD_ID()="{aid}"' for aid in asset_ids)
        asset_records = await select_all(
            config.tables["assets"],
            {"filterByFormula": f"OR({formula})", "fields": ["Name"]},
        )
        asset_name_map = {r["id"]: r["fields"].get("Name", "") for r in asset_records}

    result = []
    for r in records:
        linked_ids = r["fields"].get("Assets") or []
        asset_name = ", ".join(asset_name_map.get(aid, aid) for aid in linked_ids)
        attachments = r["fields"].get("Attachments") or []
        screenshot = attachments[0].get("url") if attachments else None
        result.append(
            {
                "id": r["id"],
                "assetName": asset_name,
                "assetIds": linked_ids,
                "sceneFile": r["fields"].get("Scene File", ""),
                "artist": r["fields"].get("Artist", ""),
                "notes": r["fields"].get("Notes", ""),
                "status": r["fields"].get("Status", "Pending"),
                "submittedAt": r["fields"].get("Submitted At", ""),
                "screenshot": screenshot,
            }
        )
    return result


class StatusUpdate(BaseModel):
    status: str


@router.patch("/{review_id}/status")
async def update_review_status(review_id: str, body: StatusUpdate):
    if not body.status:
        raise HTTPException(status_code=400, detail="status required")
    await update_records(
        config.tables["reviews"],
        [{"id": review_id, "fields": {"Status": body.status}}],
    )
    return {"ok": True}
