from fastapi import HTTPException

from lib.crypto import decrypt_credentials
from lib.db import db_client, _url, _headers


async def get_studio_airtable_creds(studio_id: str) -> tuple[str, str]:
    """Return (api_token, base_id) for the given studio from source_credentials."""
    r = await db_client.get(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type":  "eq.studio",
            "owner_id":    f"eq.{studio_id}",
            "source_type": "eq.airtable",
            "select":      "credentials",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(status_code=400, detail="No Airtable credentials found for this studio")
    creds = decrypt_credentials(rows[0]["credentials"])
    return creds["api_token"], creds["base_id"]
