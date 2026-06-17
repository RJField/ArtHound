"""
MCP agent identity (docs/plans/mcp-server.md §0/§3, identity model A1).

An external MCP agent authenticates to the /mcp boundary with an API key. This module turns that
key into a bound, org-scoped DB identity that runs under the SAME RLS as a human member:

  1. resolve_credential(raw_key) — look up the live credential (under system_identity, before any
     agent identity exists) and return its AgentPrincipal, or None if unknown/revoked/expired.
  2. mint_agent_token(principal) — mint a short-lived `authenticated` JWT whose `sub` is the
     principal's member user_id, signed with the server signer Supabase's JWKS trusts
     (lib.system_auth.sign_server_token).
  3. agent_identity(principal) — bind that token for a block so every db_client call inside runs AS
     the agent's principal; RLS scopes it to the agent's org automatically.

Security model: RLS gives the ORG boundary (the principal is a `member_role='agent'` member, so
current_studio_ids()/current_vendor_ids() resolve its org and nothing else). `principal.scopes`
gives the WITHIN-org boundary (read vs write, tool allowlist) and is enforced at the app/tool layer —
RLS does not know about tools. Key hashes never leave the DB; the raw key is shown once at issuance.
"""
import os
import time
import uuid
import hashlib
import logging
import secrets
from dataclasses import dataclass
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from lib.db import db_client, _url, _headers, set_request_token, reset_request_token
from lib.system_auth import system_identity, sign_server_token

log = logging.getLogger(__name__)

_KEY_PREFIX = "ah_agent_"        # identifies an ArtHound agent key (aids secret-scanning + support)
_TOKEN_TTL_SECONDS = 300         # agent tokens are minted per request/session; keep them short-lived


# ── Key generation / hashing ──────────────────────────────────────────────────────────────────────
def generate_key() -> str:
    """A fresh, high-entropy API key. Shown to the issuer ONCE; only its hash is stored."""
    return _KEY_PREFIX + secrets.token_urlsafe(32)  # 256 bits of entropy


def hash_key(raw: str) -> str:
    """Deterministic lookup hash of an API key.

    sha256 (unsalted) is correct here: the key is a 256-bit random token, not a low-entropy password,
    so there is nothing to brute-force and we need a deterministic value to index/look up by. (bcrypt/
    argon2 exist to slow guessing of weak human passwords — irrelevant for a random token, and they
    can't be used as a lookup key.)
    """
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


@dataclass
class AgentPrincipal:
    credential_id: str
    owner_type: str            # 'studio' | 'vendor'
    owner_id: str
    principal_user_id: str     # the member user_id == auth.uid() the minted token carries
    label: str
    scopes: dict               # {"mode": "read"|"write", "tools": ["*"] | ["paw_v1.get_asset", ...]}


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        # PostgREST returns ISO 8601 (commonly with +00:00); tolerate a trailing Z.
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# ── Resolution (runs as arthound_system — no agent identity exists yet) ─────────────────────────────
async def resolve_credential(raw_key: str) -> AgentPrincipal | None:
    """Resolve an API key to its AgentPrincipal, or None if unknown / revoked / expired.

    Reads agent_credentials under system_identity() because at this point no caller identity is bound
    (we are establishing it). Best-effort stamps last_used_at and appends an audit event; neither is
    allowed to fail the auth.
    """
    if not raw_key or not raw_key.startswith(_KEY_PREFIX):
        return None
    hashed = hash_key(raw_key)

    async with system_identity():
        r = await db_client.get(
            _url("/rest/v1/agent_credentials"),
            params={
                "key_hash":   f"eq.{hashed}",
                "revoked_at": "is.null",
                "select":     "id,owner_type,owner_id,principal_user_id,label,scopes,expires_at",
                "limit":      "1",
            },
            headers=_headers(),
        )
        rows = r.json() if r.is_success else []
        if not rows:
            return None
        row = rows[0]

        expires_at = _parse_ts(row.get("expires_at"))
        if expires_at is not None and expires_at <= datetime.now(timezone.utc):
            await _append_event(row["id"], row["owner_type"], row["owner_id"], "expired")
            return None

        principal = AgentPrincipal(
            credential_id=row["id"],
            owner_type=row["owner_type"],
            owner_id=row["owner_id"],
            principal_user_id=row["principal_user_id"],
            label=row.get("label") or "",
            scopes=row.get("scopes") or {"mode": "read", "tools": ["*"]},
        )
        await _touch_last_used(principal.credential_id)
        await _append_event(principal.credential_id, principal.owner_type, principal.owner_id,
                            "authenticated")
        return principal


async def _touch_last_used(credential_id: str) -> None:
    try:
        async with system_identity():
            await db_client.patch(
                _url("/rest/v1/agent_credentials"),
                params={"id": f"eq.{credential_id}"},
                json={"last_used_at": datetime.now(timezone.utc).isoformat()},
                headers=_headers({"Prefer": "return=minimal"}),
            )
    except Exception as exc:  # auditing must never break auth
        log.warning("agent_auth: last_used_at update failed for %s: %s", credential_id, exc)


async def _append_event(credential_id: str, owner_type: str, owner_id: str,
                        event: str, tool: str | None = None, detail: dict | None = None) -> None:
    try:
        async with system_identity():
            await db_client.post(
                _url("/rest/v1/agent_access_log"),
                json={
                    "agent_credential_id": credential_id,
                    "owner_type": owner_type,
                    "owner_id": owner_id,
                    "event": event,
                    "tool": tool,
                    "detail": detail,
                },
                headers=_headers({"Prefer": "return=minimal"}),
            )
    except Exception as exc:
        log.warning("agent_auth: access-log append (%s) failed for %s: %s", event, credential_id, exc)


async def log_tool_event(principal: AgentPrincipal, event: str, tool: str,
                         detail: dict | None = None) -> None:
    """Public audit hook for the tool layer: record a 'tool_call' or 'denied' event."""
    await _append_event(principal.credential_id, principal.owner_type, principal.owner_id,
                        event, tool=tool, detail=detail)


# ── Token mint + identity binding ───────────────────────────────────────────────────────────────────
def mint_agent_token(principal: AgentPrincipal) -> str:
    """Mint a short-lived `authenticated` JWT for the principal.

    `role=authenticated` → PostgREST SET ROLEs to the authenticated Postgres role, so RLS applies.
    `sub` = the principal's member user_id → auth.uid() inside every policy resolves to it, and the
    membership predicates scope to exactly the agent's org. app_metadata is included for parity with
    real user tokens but is NOT trusted by RLS (migration 20260530000001 dissolved that dependency).
    """
    now = int(time.time())
    org_claim = "studio_id" if principal.owner_type == "studio" else "vendor_id"
    claims = {
        "role": "authenticated",
        "aud":  "authenticated",
        "sub":  principal.principal_user_id,
        "iat":  now,
        "exp":  now + _TOKEN_TTL_SECONDS,
        "jti":  uuid.uuid4().hex,
        "app_metadata": {"role": principal.owner_type, org_claim: principal.owner_id},
    }
    token, _alg = sign_server_token(claims)
    return token


@asynccontextmanager
async def agent_identity(principal: AgentPrincipal):
    """Bind a freshly-minted agent token for the enclosing block so _headers() runs AS the agent's
    principal. Mirrors lib.system_auth.system_identity()'s bind/reset discipline."""
    handle = set_request_token(mint_agent_token(principal))
    try:
        yield
    finally:
        reset_request_token(handle)
