import asyncio
import logging

from fastapi import HTTPException

from lib.crypto import decrypt_credentials
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)


async def _write_access_log(
    owner_type: str, owner_id: str, source_type: str, user_id: str | None
) -> None:
    try:
        # credential_access_log is system-managed (no authenticated write policy); record as the system
        # identity. Fire-and-forget — credential access must never be blocked by an audit-log failure.
        from lib.system_auth import system_identity
        async with system_identity():
            await db_client.post(
                _url("/rest/v1/credential_access_log"),
                json={"user_id": user_id, "owner_type": owner_type, "owner_id": owner_id, "source_type": source_type},
                headers=_headers({"Prefer": "return=minimal"}),
            )
    except Exception:
        log.warning("credential_access_log write failed", exc_info=True)


def log_credential_access(
    owner_type: str, owner_id: str, source_type: str, user_id: str | None = None
) -> None:
    """Fire-and-forget audit entry. Swallows errors so credential access is never blocked."""
    asyncio.create_task(_write_access_log(owner_type, owner_id, source_type, user_id))


async def get_studio_airtable_creds(studio_id: str, user_id: str | None = None) -> tuple[str, str]:
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
    log_credential_access("studio", studio_id, "airtable", user_id)
    return creds["api_token"], creds["base_id"]
