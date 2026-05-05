import os
import time
from dataclasses import dataclass, field
from typing import Optional

import jwt
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from lib.db import db_client, _url, _headers, _user_headers

bearer_scheme = HTTPBearer()

# Cached JWKS client — fetches Supabase's public keys once, refreshes every 5 min
_jwks_client: PyJWKClient | None = None

# Per-user membership cache: user_id -> (studio_id, vendor_id, cached_at)
# Keyed strictly by verified JWT sub — no cross-user leakage possible.
# TTL of 60s means a removed member retains access for at most one minute.
_MEMBERSHIP_TTL = 60
_membership_cache: dict[str, tuple[Optional[str], Optional[str], float]] = {}


def _get_cached_membership(user_id: str) -> tuple[Optional[str], Optional[str]] | None:
    entry = _membership_cache.get(user_id)
    if entry is not None and (time.monotonic() - entry[2]) < _MEMBERSHIP_TTL:
        return entry[0], entry[1]
    return None


def _set_cached_membership(user_id: str, studio_id: Optional[str], vendor_id: Optional[str]) -> None:
    _membership_cache[user_id] = (studio_id, vendor_id, time.monotonic())


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        supabase_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        _jwks_client = PyJWKClient(
            f"{supabase_url}/auth/v1/.well-known/jwks.json",
            cache_jwk_set=True,
            lifespan=300,
        )
    return _jwks_client


@dataclass
class CurrentUser:
    id: str
    email: str
    role: str
    token: str = field(default="")
    studio_id: str | None = field(default=None)
    vendor_id: str | None = field(default=None)
    is_admin: bool = field(default=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> CurrentUser:
    token = credentials.credentials

    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "HS256")

        if alg.startswith("HS"):
            # Symmetric signing — verify with JWT secret
            secret = os.environ.get("SUPABASE_JWT_SECRET", "")
            if not secret:
                raise HTTPException(status_code=500, detail="Auth not configured")
            payload = jwt.decode(
                token, secret, algorithms=[alg], audience="authenticated"
            )
        else:
            # Asymmetric signing (RS256 etc.) — verify with Supabase JWKS public key
            if not os.environ.get("SUPABASE_URL"):
                raise HTTPException(status_code=500, detail="Auth not configured")
            signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=[alg],
                audience="authenticated",
            )
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    app_metadata = payload.get("app_metadata") or {}
    role = app_metadata.get("role", "")
    is_admin = bool(app_metadata.get("is_admin", False))
    if role not in ("studio", "vendor"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No valid role assigned to this account",
        )

    user_id = payload["sub"]
    cached = _get_cached_membership(user_id)

    if cached is not None:
        studio_id, vendor_id = cached
    else:
        studio_id = None
        vendor_id = None

        if role == "studio":
            r = await db_client.get(
                _url("/rest/v1/studio_members"),
                params={"select": "studio_id", "user_id": f"eq.{user_id}"},
                headers=_headers(),
            )
            rows = r.json()
            if rows:
                studio_id = rows[0]["studio_id"]
        elif role == "vendor":
            r = await db_client.get(
                _url("/rest/v1/vendor_members"),
                params={"select": "vendor_id", "user_id": f"eq.{user_id}"},
                headers=_headers(),
            )
            rows = r.json()
            if rows:
                vendor_id = rows[0]["vendor_id"]

        _set_cached_membership(user_id, studio_id, vendor_id)

    return CurrentUser(
        id=user_id,
        email=payload.get("email", ""),
        role=role,
        token=token,
        studio_id=studio_id,
        vendor_id=vendor_id,
        is_admin=is_admin,
    )


def require_admin(user: CurrentUser) -> None:
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")


def require_studio(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if user.role != "studio":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Studio access required",
        )
    return user


def require_vendor(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if user.role != "vendor":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Vendor access required",
        )
    if not user.vendor_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No vendor linked to this account",
        )
    return user
