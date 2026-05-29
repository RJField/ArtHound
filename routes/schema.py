from fastapi import APIRouter, Depends
import httpx

from lib.auth import CurrentUser, require_studio
from lib.source_creds import get_studio_airtable_creds
import config

router = APIRouter()

FIELD_CATEGORY = {
    "singleLineText": "text", "multilineText": "text", "richText": "text",
    "email": "text", "url": "text", "phoneNumber": "text",
    "number": "number", "percent": "number", "currency": "number",
    "rating": "number", "duration": "number", "autoNumber": "number",
    "date": "date", "dateTime": "date", "createdTime": "date", "lastModifiedTime": "date",
    "multipleRecordLinks": "link",
    "formula": "computed", "rollup": "computed", "count": "computed", "lookup": "computed",
    "singleSelect": "select", "multipleSelects": "select",
    "checkbox": "bool",
    "collaborator": "user", "multipleCollaborators": "user",
    "createdBy": "user", "lastModifiedBy": "user",
    "multipleAttachments": "file",
}


@router.get("")
async def get_schema(current_user: CurrentUser = Depends(require_studio)):
    token, base_id = await get_studio_airtable_creds(current_user.studio_id, current_user.id)

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(
            f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
            headers={"Authorization": f"Bearer {token}"},
        )
        if not r.is_success:
            body = r.json() if "application/json" in r.headers.get("content-type", "") else {}
            msg = (
                body.get("error", {}).get("message")
                or f"Metadata API returned {r.status_code}. Ensure your token has the 'schema.bases:read' scope."
            )
            raise ValueError(msg)
        tables = r.json().get("tables", [])

    by_name = {t["name"]: t for t in tables}

    configured = [
        {
            "key": key,
            "name": name,
            "found": name in by_name,
            "id": by_name[name]["id"] if name in by_name else None,
            "fields": [
                {
                    "id": f["id"],
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

    return {"configured": configured, "allTableNames": [t["name"] for t in tables]}
