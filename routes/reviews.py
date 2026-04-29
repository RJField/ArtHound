import asyncio
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


@router.get("")
@router.get("/")
async def get_reviews():
    # Two parallel calls: main (JSON) preserves types for linked-record IDs and
    # ISO dates; display (string) resolves lookup-of-linked-record fields to
    # their human-readable primary field values instead of raw record IDs.
    records, display_records = await asyncio.gather(
        select_all(
            config.tables["reviews"],
            {"sort": [{"field": "Submitted At", "direction": "desc"}]},
        ),
        select_all(
            config.tables["reviews"],
            {
                "cellFormat": "string",
                "timeZone": "America/Los_Angeles",
                "userLocale": "en-us",
            },
        ),
    )

    display_map: dict = {r["id"]: r.get("fields", {}) for r in display_records}

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
        f = r["fields"]
        dn = display_map.get(r["id"], {})
        result.append(
            {
                "id": r["id"],
                "assetName": asset_name,
                "assetIds": linked_ids,
                "status": f.get("Status", "Pending"),
                "artist": f.get("Artist", ""),
                "notes": f.get("Notes", ""),
                "submittedAt": f.get("Submitted At", ""),
                "screenshot": screenshot,
                # All Airtable fields as display strings — rendered dynamically in the UI.
                # Lookup fields return resolved names; collaborators return display name.
                "fields": dn,
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
