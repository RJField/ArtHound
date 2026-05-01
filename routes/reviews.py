import asyncio
import base64
import os
import random
import string
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.airtable import select_all, create_records, update_records, http_client
from lib.auth import CurrentUser, require_studio
import config


def _at_headers():
    return {"Authorization": f"Bearer {os.environ.get('AIRTABLE_TOKEN', '')}"}


def _comments_url(review_id: str) -> str:
    base = os.environ.get("AIRTABLE_BASE_ID", "")
    table = config.tables["reviews"]
    return f"https://api.airtable.com/v0/{base}/{table}/{review_id}/comments"

router = APIRouter()

SCREENSHOTS_DIR = Path(__file__).parent.parent / "media" / "reviews"
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
async def submit_review(body: ReviewSubmitBody, _: CurrentUser = Depends(require_studio)):
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
        first_att = attachments[0] if attachments else None
        screenshot = first_att.get("url") if first_att else None
        screenshot_type = first_att.get("type", "") if first_att else ""
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
                "screenshotType": screenshot_type,
                # All Airtable fields as display strings — rendered dynamically in the UI.
                # Lookup fields return resolved names; collaborators return display name.
                "fields": dn,
            }
        )
    return result


@router.get("/status-options")
async def get_status_options():
    token = os.environ.get("AIRTABLE_TOKEN", "")
    base_id = os.environ.get("AIRTABLE_BASE_ID", "")
    r = await http_client.get(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not r.is_success:
        raise HTTPException(status_code=502, detail=f"Airtable metadata API returned {r.status_code}")
    tables = r.json().get("tables", [])
    table = next((t for t in tables if t["name"] == config.tables["reviews"]), None)
    if not table:
        raise HTTPException(status_code=404, detail=f"Reviews table '{config.tables['reviews']}' not found in schema")
    field = next((f for f in table.get("fields", []) if f["name"] == "Status"), None)
    if not field:
        raise HTTPException(status_code=404, detail="Status field not found in reviews table")
    choices = [c["name"] for c in field.get("options", {}).get("choices", [])]
    return {"options": choices}


class StatusUpdate(BaseModel):
    status: str


@router.patch("/{review_id}/status")
async def update_review_status(
    review_id: str, body: StatusUpdate, _: CurrentUser = Depends(require_studio)
):
    if not body.status:
        raise HTTPException(status_code=400, detail="status required")
    base_id = os.environ.get("AIRTABLE_BASE_ID", "")
    table_enc = quote(config.tables["reviews"], safe="")
    r = await http_client.patch(
        f"https://api.airtable.com/v0/{base_id}/{table_enc}",
        headers={**_at_headers(), "Content-Type": "application/json"},
        json={"records": [{"id": review_id, "fields": {"Status": body.status}}]},
    )
    if not r.is_success:
        msg = r.json().get("error", {}).get("message", f"Airtable returned {r.status_code}")
        raise HTTPException(status_code=502, detail=msg)
    return {"ok": True}


@router.get("/{review_id}/comments")
async def get_comments(review_id: str):
    r = await http_client.get(_comments_url(review_id), headers=_at_headers())
    if not r.is_success:
        msg = r.json().get("error", {}).get("message", f"Airtable returned {r.status_code}")
        raise HTTPException(status_code=502, detail=msg)
    return r.json().get("comments", [])


class CommentBody(BaseModel):
    text: str


@router.post("/{review_id}/comments")
async def add_comment(
    review_id: str, body: CommentBody, _: CurrentUser = Depends(require_studio)
):
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="Comment text is required")
    r = await http_client.post(
        _comments_url(review_id),
        headers={**_at_headers(), "Content-Type": "application/json"},
        json={"text": body.text},
    )
    if not r.is_success:
        msg = r.json().get("error", {}).get("message", f"Airtable returned {r.status_code}")
        raise HTTPException(status_code=502, detail=msg)
    return r.json()
