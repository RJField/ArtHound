"""
System identity (RLS migration §5 / identity #2).

Mints a short-lived JWT with role=arthound_system. PostgREST verifies it (proven against
dev+prod, plan §0) and SET ROLEs to arthound_system, which is bounded by its least-privilege
grants + policies (migration 20260530000002).

Signer (plan §0a "option a", swapped 2026-06-05): the token is signed with an imported ES256
**standby** JWT signing key we control (ARTHOUND_SYSTEM_SIGNING_JWK). Supabase publishes the
key's public half in the project JWKS so PostgREST verifies our system tokens, but GoTrue never
signs with it (it stays standby, never current) — user tokens are untouched. This removes the
dependency on the legacy shared HS256 secret, which Supabase removes ~late-2026.

If ARTHOUND_SYSTEM_SIGNING_JWK is unset we fall back to the legacy HS256-over-SUPABASE_JWT_SECRET
signer (still verified during Supabase's dual-verification window). That fallback is the instant
rollback: unset the env var and restart. Both signers produce identical claims; only the
signature alg + kid header differ.

Background jobs run their DB work inside `async with system_identity():` so _headers()
emits this token instead of a user JWT. The token is re-minted on demand once it passes
50% of its TTL — `system_headers()` / `system_identity()` always use a fresh-enough token,
including between long sync batches (plan §5 lifecycle).

Deprecation watch (plan §0a): `system_token_accepted()` re-runs the live acceptance probe so
startup / a health check alerts if PostgREST ever stops honouring the system token (e.g. the
standby key is revoked, or — on the HS256 fallback — the legacy secret is removed).
"""
import os
import json
import time
import uuid
import logging
from contextlib import asynccontextmanager

import jwt as pyjwt
from jwt.algorithms import ECAlgorithm
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

# Cached ES256 signer: (private_key_obj, kid) parsed once from ARTHOUND_SYSTEM_SIGNING_JWK,
# or None when the var is unset (→ HS256 fallback). _signer_loaded guards the one-shot parse
# (so an unset/invalid var isn't re-parsed every mint, and a parse error is logged once).
_es256_signer: tuple[object, str | None] | None = None
_signer_loaded = False


def _load_es256_signer() -> tuple[object, str | None] | None:
    """Parse the imported ES256 private JWK from env once; return (key_obj, kid) or None.

    None means no ES256 key is configured → caller uses the HS256 fallback. A malformed JWK
    is logged once and also returns None (fail safe to HS256 rather than crash the minter).
    """
    global _es256_signer, _signer_loaded
    if _signer_loaded:
        return _es256_signer
    _signer_loaded = True
    raw = os.environ.get("ARTHOUND_SYSTEM_SIGNING_JWK", "").strip()
    if not raw:
        _es256_signer = None
        return None
    try:
        jwk = json.loads(raw)
        key_obj = ECAlgorithm.from_jwk(json.dumps(jwk))   # private key (JWK carries "d")
        kid = jwk.get("kid") or os.environ.get("ARTHOUND_SYSTEM_SIGNING_KID")
        _es256_signer = (key_obj, kid)
        log.info("System token signer: ES256 (kid=%s)", kid)
    except Exception as exc:
        # Don't crash the minter on a bad key — fall back to HS256, but make it loud.
        log.error("ARTHOUND_SYSTEM_SIGNING_JWK present but unparseable (%s); "
                  "falling back to HS256 signer", exc)
        _es256_signer = None
    return _es256_signer


def _mint() -> tuple[str, float]:
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
    signer = _load_es256_signer()
    if signer is not None:
        key_obj, kid = signer
        headers = {"kid": kid} if kid else None
        token = pyjwt.encode(claims, key_obj, algorithm="ES256", headers=headers)
        alg = "ES256"
    else:
        secret = os.environ["SUPABASE_JWT_SECRET"]
        token = pyjwt.encode(claims, secret, algorithm="HS256")
        alg = "HS256"
    log.info("Minted system token alg=%s jti=%s exp=%d", alg, claims["jti"], exp)
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
