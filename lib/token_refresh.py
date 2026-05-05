"""
Jira OAuth token refresh. Called transparently before any Jira API request.
Reads/writes source_credentials — callers receive a refreshed creds dict or an error.
Supports both Cloud (global ArtHound app credentials) and Data Center (per-instance credentials).
"""

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone

import httpx

from lib.crypto import decrypt_credentials, encrypt_credentials
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)

_ATLASSIAN_TOKEN_URL    = "https://auth.atlassian.com/oauth/token"
_REFRESH_BUFFER_MINUTES = 5

# Per-owner asyncio locks prevent concurrent refreshes from racing on Atlassian's
# rotating refresh tokens. Two syncs hitting the same studio simultaneously would
# each POST the same refresh token; the second request returns a 400 because
# Atlassian already rotated it. The lock serialises them: the second waiter reads
# fresh credentials after the first completes and finds them unexpired.
_token_locks: dict[str, asyncio.Lock] = {}


def _get_lock(owner_type: str, owner_id: str) -> asyncio.Lock:
    key = f"{owner_type}/{owner_id}"
    if key not in _token_locks:
        _token_locks[key] = asyncio.Lock()
    return _token_locks[key]


async def get_jira_token(
    owner_type: str,
    owner_id: str,
    client: httpx.AsyncClient,
) -> dict:
    """
    Return the full credentials dict for the given owner, refreshing the access token
    if it expires within _REFRESH_BUFFER_MINUTES.
    Raises RuntimeError if credentials are missing or refresh fails.
    """
    async with _get_lock(owner_type, owner_id):
        r = await db_client.get(
            _url("/rest/v1/source_credentials"),
            params={
                "owner_type":  f"eq.{owner_type}",
                "owner_id":    f"eq.{owner_id}",
                "source_type": "eq.jira",
                "select":      "credentials",
            },
            headers=_headers(),
        )
        rows = r.json()
        if not rows:
            raise RuntimeError(f"No Jira credentials for {owner_type}/{owner_id} — user must reconnect")

        creds = decrypt_credentials(rows[0]["credentials"])

        # Partial DC credentials (no tokens yet) — the OAuth callback hasn't run yet.
        if not creds.get("access_token"):
            raise RuntimeError(f"Jira credentials incomplete for {owner_type}/{owner_id} — OAuth not complete")

        expires_at = datetime.fromisoformat(creds["expires_at"])
        if datetime.now(timezone.utc) < expires_at - timedelta(minutes=_REFRESH_BUFFER_MINUTES):
            return creds

        log.info("Refreshing Jira access token for %s/%s", owner_type, owner_id)

        deployment = creds.get("deployment", "cloud")

        if deployment == "datacenter":
            token_url     = f"{creds['instance_url']}/rest/oauth2/latest/token"
            client_id     = creds["dc_client_id"]
            client_secret = creds["dc_client_secret"]
        else:
            token_url     = _ATLASSIAN_TOKEN_URL
            client_id     = os.environ["JIRA_CLOUD_CLIENT_ID"]
            client_secret = os.environ["JIRA_CLOUD_CLIENT_SECRET"]

        refresh_r = await client.post(
            token_url,
            json={
                "grant_type":    "refresh_token",
                "client_id":     client_id,
                "client_secret": client_secret,
                "refresh_token": creds["refresh_token"],
            },
            timeout=15.0,
        )
        if not refresh_r.is_success:
            log.error(
                "Jira token refresh failed for %s/%s: %s %s",
                owner_type, owner_id, refresh_r.status_code, refresh_r.text,
            )
            raise RuntimeError("Jira token refresh failed — studio must reconnect Jira")

        tokens = refresh_r.json()
        updated = {
            **creds,
            "access_token":  tokens["access_token"],
            "refresh_token": tokens.get("refresh_token", creds["refresh_token"]),
            "expires_at": (
                datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))
            ).isoformat(),
        }

        await db_client.post(
            _url("/rest/v1/source_credentials?on_conflict=owner_type,owner_id,source_type"),
            headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            json={
                "owner_type":  owner_type,
                "owner_id":    owner_id,
                "source_type": "jira",
                "credentials": encrypt_credentials(updated),
            },
        )

        return updated
