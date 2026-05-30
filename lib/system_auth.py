"""
System identity (RLS migration §5 / identity #2).

Mints a short-lived JWT with role=arthound_system, signed HS256 with SUPABASE_JWT_SECRET.
PostgREST verifies it (proven against dev+prod, plan §0) and SET ROLEs to arthound_system,
which is bounded by its least-privilege grants + policies (migration 20260530000002).

Background jobs run their DB work inside `async with system_identity():` so _headers()
emits this token instead of a user JWT. The token is re-minted on demand once it passes
50% of its TTL — `system_headers()` / `system_identity()` always use a fresh-enough token,
including between long sync batches (plan §5 lifecycle).

Deprecation watch (plan §0a): this depends on the legacy shared HS256 secret, which Supabase
removes ~late-2026. `system_token_accepted()` re-runs the live acceptance probe so startup /
a health check can alert before that bites; the documented upgrade is an imported asymmetric
signing key (option a), a non-breaking swap of the signer here.
"""
import os
import time
import uuid
import logging
from contextlib import asynccontextmanager

import jwt as pyjwt
import httpx

from lib.db import set_request_token, reset_request_token, _url

log = logging.getLogger(__name__)

_SYSTEM_ROLE = "arthound_system"
_SENTINEL_SUB = "00000000-0000-0000-0000-000000000000"
_TTL_SECONDS = 3600          # 1h tokens
_REFRESH_AT = _TTL_SECONDS // 2  # re-mint past 50% of TTL

# Cached (token, expiry_epoch). Module-level; the mint is cheap and idempotent so a race
# just mints twice harmlessly.
_cache: tuple[str, float] | None = None


def _mint() -> tuple[str, float]:
    secret = os.environ["SUPABASE_JWT_SECRET"]
    now = int(time.time())
    exp = now + _TTL_SECONDS
    claims = {
        "role": _SYSTEM_ROLE,          # PostgREST maps this to the Postgres role → SET ROLE
        "aud": "authenticated",         # PostgREST's expected audience
        "sub": _SENTINEL_SUB,           # not a real user; auth.uid() is the sentinel for system calls
        "iat": now,
        "exp": exp,
        "jti": uuid.uuid4().hex,        # logged (never the token itself) for mint auditing
    }
    token = pyjwt.encode(claims, secret, algorithm="HS256")
    log.info("Minted system token jti=%s exp=%d", claims["jti"], exp)
    return token, exp


def get_system_token() -> str:
    """Return a valid system token, minting/refreshing as needed."""
    global _cache
    now = time.time()
    if _cache is None or (_cache[1] - now) < _REFRESH_AT:
        _cache = _mint()
    return _cache[0]


@asynccontextmanager
async def system_identity():
    """Bind the system token for the enclosing block so _headers() runs as arthound_system.

    Must wrap the DB work of every background entrypoint (poll/full-sync/trim/attachment
    drain+purge/schema-drift/scenario gen+cleanup, the webhook sync, and any create_task'd
    callee) — explicitly at the top of each, NOT relying on inheritance, because
    create_task snapshots context at creation (plan §8 (e)).
    """
    handle = set_request_token(get_system_token())
    try:
        yield
    finally:
        reset_request_token(handle)


async def system_token_accepted() -> bool:
    """Live acceptance probe: does PostgREST honour the minted system token right now?
    Used as a BLOCKING startup go/no-go (plan §8) and the HS256-deprecation watch (§0a).
    Returns True only on a 2xx from a trivial system-scoped read.
    """
    token = get_system_token()
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(
                _url("/rest/v1/source_credentials"),
                params={"select": "owner_type", "limit": "1"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "apikey": os.environ["SUPABASE_ANON_KEY"],
                },
            )
        return r.status_code == 200
    except Exception as exc:
        log.error("System token acceptance probe errored: %s", exc)
        return False
