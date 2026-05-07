"""
Jira OAuth 2.0 (3LO) routes — Cloud and Data Center.

Cloud flow:
  1. Frontend calls POST /initiate {deployment:"cloud"} → receives Atlassian authorize URL
  2. Frontend navigates user there
  3. Atlassian redirects to GET /callback with code + state
  4. Backend exchanges code for tokens, discovers cloud instance, stores credentials
  5. User is redirected back to /init?jira=connected

Data Center flow:
  1. Frontend calls POST /initiate {deployment:"datacenter", instance_url, dc_client_id, dc_client_secret}
     → partial DC credentials stored in DB; receives DC authorize URL
  2. Frontend navigates user to their Jira DC instance
  3. DC redirects to GET /callback with code + state
  4. Backend reads stored DC credentials, exchanges code for tokens, stores full credentials
  5. User is redirected back to /init?jira=connected
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user
from lib.crypto import decrypt_credentials, encrypt_credentials
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()

_ATLASSIAN_AUTH_URL      = "https://auth.atlassian.com/authorize"
_ATLASSIAN_TOKEN_URL     = "https://auth.atlassian.com/oauth/token"
_ATLASSIAN_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources"

# offline_access enables refresh tokens — Cloud only; DC refresh is always supported.
_CLOUD_SCOPES = "read:jira-work write:jira-work read:jira-user manage:jira-webhook offline_access"

_STATE_TTL_SECONDS = 600  # 10 minutes


def _sign_state(owner_id: str, deployment: str = "cloud", owner_type: str = "studio") -> str:
    payload = json.dumps({"owner_type": owner_type, "owner_id": owner_id, "deployment": deployment, "ts": int(time.time())})
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").encode()
    sig = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(f"{payload}|{sig}".encode()).decode()


def _verify_state(state: str) -> tuple[str, str, str]:
    """Validate HMAC-signed state and return (owner_type, owner_id, deployment), or raise 400."""
    try:
        raw = base64.urlsafe_b64decode(state.encode()).decode()
        payload_str, sig = raw.rsplit("|", 1)
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").encode()
        expected = hmac.new(key, payload_str.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            raise ValueError("signature mismatch")
        payload = json.loads(payload_str)
        if int(time.time()) - payload["ts"] > _STATE_TTL_SECONDS:
            raise ValueError("state expired")
        owner_type = payload.get("owner_type", "studio")
        owner_id   = payload.get("owner_id") or payload.get("studio_id")  # backwards compat
        return owner_type, owner_id, payload.get("deployment", "cloud")
    except (ValueError, KeyError, Exception) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid OAuth state: {exc}")


class InitiateBody(BaseModel):
    deployment: str = "cloud"
    instance_url: str | None = None    # DC only — e.g. "https://jira.studio.com"
    dc_client_id: str | None = None    # DC only — from Application Link
    dc_client_secret: str | None = None  # DC only


def _owner(user: CurrentUser) -> tuple[str, str]:
    owner_type = user.role
    owner_id   = user.studio_id if user.role == "studio" else user.vendor_id
    if not owner_id:
        raise HTTPException(status_code=403, detail="No studio/vendor linked to account")
    return owner_type, owner_id


@router.post("/initiate")
async def initiate_jira_oauth(
    body: InitiateBody,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Return the authorization URL. The frontend navigates the user there.
    For Cloud: uses ArtHound's global Atlassian app registration.
    For Data Center: requires instance_url + dc_client_id + dc_client_secret from the
    owner's Application Link; stores partial credentials before redirecting.
    """
    owner_type, owner_id = _owner(user)
    redirect_uri = os.environ.get("JIRA_REDIRECT_URI")
    if not redirect_uri:
        raise HTTPException(status_code=503, detail="Jira OAuth is not configured on this server")

    if body.deployment == "cloud":
        client_id = os.environ.get("JIRA_CLOUD_CLIENT_ID")
        if not client_id:
            raise HTTPException(status_code=503, detail="Jira Cloud OAuth is not configured on this server")

        params = {
            "audience":      "api.atlassian.com",
            "client_id":     client_id,
            "scope":         _CLOUD_SCOPES,
            "redirect_uri":  redirect_uri,
            "state":         _sign_state(owner_id, "cloud", owner_type),
            "response_type": "code",
            "prompt":        "consent",
        }
        return {"url": f"{_ATLASSIAN_AUTH_URL}?{urlencode(params)}"}

    elif body.deployment == "datacenter":
        if not body.instance_url or not body.dc_client_id or not body.dc_client_secret:
            raise HTTPException(
                status_code=422,
                detail="instance_url, dc_client_id, and dc_client_secret are required for Data Center",
            )

        instance_url = body.instance_url.rstrip("/")

        # Store partial DC credentials so the callback can read them for token exchange.
        # These will be replaced with full credentials (including tokens) after the callback.
        partial_creds = {
            "deployment":      "datacenter",
            "instance_url":    instance_url,
            "dc_client_id":    body.dc_client_id,
            "dc_client_secret": body.dc_client_secret,
        }
        await db_client.post(
            _url("/rest/v1/source_credentials?on_conflict=owner_type,owner_id,source_type"),
            headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            json={
                "owner_type":  owner_type,
                "owner_id":    owner_id,
                "source_type": "jira",
                "credentials": encrypt_credentials(partial_creds),
            },
        )

        # DC authorize URL — no audience/scope/prompt, just standard OAuth 2.0
        params = {
            "client_id":     body.dc_client_id,
            "redirect_uri":  redirect_uri,
            "response_type": "code",
            "state":         _sign_state(owner_id, "datacenter", owner_type),
        }
        return {"url": f"{instance_url}/rest/oauth2/latest/authorize?{urlencode(params)}"}

    else:
        raise HTTPException(status_code=422, detail=f"Unknown deployment type: {body.deployment}")


@router.get("/callback")
async def jira_oauth_callback(code: str, state: str):
    """
    Public endpoint — Jira redirects here after the user authorises.
    Handles both Cloud (Atlassian-hosted) and Data Center flows.
    """
    owner_type, owner_id, deployment = _verify_state(state)
    redirect_uri = os.environ.get("JIRA_REDIRECT_URI")
    frontend_base = os.environ.get("FRONTEND_URL", "http://localhost:5173")

    async with httpx.AsyncClient(timeout=30.0) as client:
        if deployment == "cloud":
            client_id     = os.environ.get("JIRA_CLOUD_CLIENT_ID")
            client_secret = os.environ.get("JIRA_CLOUD_CLIENT_SECRET")

            token_r = await client.post(
                _ATLASSIAN_TOKEN_URL,
                json={
                    "grant_type":    "authorization_code",
                    "client_id":     client_id,
                    "client_secret": client_secret,
                    "code":          code,
                    "redirect_uri":  redirect_uri,
                },
            )
            if not token_r.is_success:
                log.error("Jira Cloud token exchange failed for %s %s: %s", owner_type, owner_id, token_r.text)
                raise HTTPException(status_code=502, detail="Token exchange with Atlassian failed")
            tokens = token_r.json()

            resources_r = await client.get(
                _ATLASSIAN_RESOURCES_URL,
                headers={"Authorization": f"Bearer {tokens['access_token']}"},
            )
            if not resources_r.is_success:
                log.error("Jira accessible-resources failed for %s %s: %s", owner_type, owner_id, resources_r.text)
                raise HTTPException(status_code=502, detail="Failed to discover Jira instance")

            resources = resources_r.json()
            if not resources:
                raise HTTPException(status_code=400, detail="No accessible Jira instances found for this account")

            resource = resources[0]
            creds = {
                "deployment":          "cloud",
                "access_token":        tokens["access_token"],
                "refresh_token":       tokens.get("refresh_token"),
                "expires_at": (
                    datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))
                ).isoformat(),
                "cloud_id":            resource["id"],
                "site_url":            resource["url"],
                "available_resources": resources,
            }
            log.info(
                "Jira Cloud OAuth complete for %s %s (cloud_id=%s, site=%s)",
                owner_type, owner_id, resource["id"], resource["url"],
            )

        elif deployment == "datacenter":
            # Read the partial DC credentials stored during /initiate
            creds_r = await db_client.get(
                _url("/rest/v1/source_credentials"),
                params={
                    "owner_type":  f"eq.{owner_type}",
                    "owner_id":    f"eq.{owner_id}",
                    "source_type": "eq.jira",
                    "select":      "credentials",
                },
                headers=_headers(),
            )
            rows = creds_r.json()
            if not rows:
                raise HTTPException(status_code=400, detail="DC credentials not found — restart the connection flow")

            partial = decrypt_credentials(rows[0]["credentials"])
            instance_url  = partial["instance_url"]
            dc_client_id  = partial["dc_client_id"]
            dc_client_secret = partial["dc_client_secret"]

            token_r = await client.post(
                f"{instance_url}/rest/oauth2/latest/token",
                json={
                    "grant_type":    "authorization_code",
                    "client_id":     dc_client_id,
                    "client_secret": dc_client_secret,
                    "code":          code,
                    "redirect_uri":  redirect_uri,
                },
            )
            if not token_r.is_success:
                log.error("Jira DC token exchange failed for %s %s: %s", owner_type, owner_id, token_r.text)
                raise HTTPException(status_code=502, detail="Token exchange with Jira Data Center failed")
            tokens = token_r.json()

            creds = {
                "deployment":      "datacenter",
                "instance_url":    instance_url,
                "dc_client_id":    dc_client_id,
                "dc_client_secret": dc_client_secret,
                "access_token":    tokens["access_token"],
                "refresh_token":   tokens.get("refresh_token"),
                "expires_at": (
                    datetime.now(timezone.utc) + timedelta(seconds=tokens.get("expires_in", 3600))
                ).isoformat(),
            }
            log.info("Jira DC OAuth complete for %s %s (instance=%s)", owner_type, owner_id, instance_url)

        else:
            raise HTTPException(status_code=400, detail=f"Unknown deployment in state: {deployment}")

    await db_client.post(
        _url("/rest/v1/source_credentials?on_conflict=owner_type,owner_id,source_type"),
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={
            "owner_type":  owner_type,
            "owner_id":    owner_id,
            "source_type": "jira",
            "credentials": encrypt_credentials(creds),
        },
    )

    return RedirectResponse(url=f"{frontend_base}/init?jira=connected", status_code=302)


# ── Disconnect ────────────────────────────────────────────────────────────────

@router.delete("/disconnect")
async def disconnect_jira(user: CurrentUser = Depends(get_current_user)):
    """Delete the owner's Jira credentials, allowing re-authorization."""
    owner_type, owner_id = _owner(user)
    r = await db_client.delete(
        _url("/rest/v1/source_credentials"),
        params={
            "owner_type":  f"eq.{owner_type}",
            "owner_id":    f"eq.{owner_id}",
            "source_type": "eq.jira",
        },
        headers=_headers({"Prefer": "return=minimal"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=500, detail="Failed to remove Jira credentials")
    log.info("%s %s disconnected Jira", owner_type, owner_id)
    return {"ok": True}


# ── Instance picker (Cloud only) ───────────────────────────────────────────────

@router.get("/instances")
async def list_instances(user: CurrentUser = Depends(get_current_user)):
    """
    Return the list of Atlassian Cloud sites the owner's token has access to.
    Only meaningful for Cloud deployments — DC always has exactly one instance.
    """
    owner_type, owner_id = _owner(user)
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
        raise HTTPException(status_code=404, detail="No Jira credentials found")

    creds = decrypt_credentials(rows[0]["credentials"])
    resources = creds.get("available_resources", [])

    return {
        "deployment":        creds.get("deployment", "cloud"),
        "selected_cloud_id": creds.get("cloud_id"),
        "instances": [
            {"id": res["id"], "url": res["url"], "name": res.get("name", res["url"])}
            for res in resources
        ],
    }


class SelectInstanceBody(BaseModel):
    cloud_id: str


@router.post("/select-instance")
async def select_instance(
    body: SelectInstanceBody,
    user: CurrentUser = Depends(get_current_user),
):
    """
    Set the active Atlassian Cloud instance for this owner.
    Updates cloud_id and site_url in stored credentials.
    """
    owner_type, owner_id = _owner(user)
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
        raise HTTPException(status_code=404, detail="No Jira credentials found")

    creds = decrypt_credentials(rows[0]["credentials"])
    resources = creds.get("available_resources", [])
    match = next((res for res in resources if res["id"] == body.cloud_id), None)
    if not match:
        raise HTTPException(status_code=400, detail=f"cloud_id {body.cloud_id!r} not in accessible resources")

    updated = {**creds, "cloud_id": match["id"], "site_url": match["url"]}
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
    log.info("%s %s selected Jira instance %s (%s)", owner_type, owner_id, match["id"], match["url"])
    return {"ok": True, "cloud_id": match["id"], "site_url": match["url"]}
