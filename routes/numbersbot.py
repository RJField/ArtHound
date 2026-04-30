import json
import os

import anthropic
import httpx
from fastapi import APIRouter
from pydantic import BaseModel

import config
from routes.schema import FIELD_CATEGORY

router = APIRouter()


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]


async def _fetch_schema() -> list[dict]:
    token = os.environ.get("AIRTABLE_TOKEN")
    base_id = os.environ.get("AIRTABLE_BASE_ID")
    if not token or not base_id:
        return []
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(
            f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not r.is_success:
            return []
        tables = r.json().get("tables", [])
    by_name = {t["name"]: t for t in tables}
    return [
        {
            "key": key,
            "name": name,
            "found": name in by_name,
            "fields": [
                {
                    "name": f["name"],
                    "type": f["type"],
                    "category": FIELD_CATEGORY.get(f["type"], "other"),
                }
                for f in by_name[name].get("fields", [])
            ]
            if name in by_name
            else [],
        }
        for key, name in config.tables.items()
    ]


@router.post("/chat")
async def chat(body: ChatRequest):
    schema = await _fetch_schema()
    schema_text = json.dumps(schema, indent=2)

    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    response = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": (
                    "You are NumberBot, a production intelligence assistant built into ArtHound — "
                    "an asset management platform for production studios. "
                    "You have access to the ArtHound asset schema below, which describes the tables "
                    "and fields in the connected Airtable base, including each field's type and category.\n\n"
                    "Answer questions about the schema concisely and accurately. "
                    "When asked about actual record data you cannot see, say so clearly. "
                    "Keep responses focused on asset management, estimation, and production context.\n\n"
                    f"SCHEMA:\n{schema_text}"
                ),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": m.role, "content": m.content} for m in body.messages],
    )

    return {"answer": response.content[0].text}
