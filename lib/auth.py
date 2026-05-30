import os
import time
from dataclasses import dataclass, field
from typing import Optional, Union

import jwt
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from lib.db import db_client, _url, _headers, _user_headers, set_request_token, _use_user_identity

bearer_scheme = HTTPBearer()
bearer_scheme_optional = HTTPBearer(auto_error=False)

# Cached JWKS client — fetches Supabase's public keys once, refreshes every 5 min
_jwks_client: PyJWKClient | None = None

# Per-user membership cache: user_id -> (studio_id, vendor_id, member_role, cached_at)
# Keyed strictly by verified JWT sub — no cross-user leakage possible.
# TTL of 15s: a removed member retains access for at most 15 seconds;
# a newly-accepted pending member sees access within 15 seconds of approval.
_MEMBERSHIP_TTL = 15
_membership_cache: dict[str, tuple[Optional[str], Optional[str], Optional[str], float]] = {}


def _get_cached_membership(user_id: str) -> tuple[Optional[str], Optional[str], Optional[str]] | None:
    entry = _membership_cache.get(user_id)
    if entry is not None and (time.monotonic() - entry[3]) < _MEMBERSHIP_TTL:
        return entry[0], entry[1], entry[2]
    return None


def _set_cached_membership(
    user_id: str,
    studio_id: Optional[str],
    vendor_id: Optional[str],
    member_role: Optional[str],
) -> None:
    _membership_cache[user_id] = (studio_id, vendor_id, member_role, time.monotonic())


def invalidate_member_cache(user_id: str) -> None:
    """Remove a user's cached membership — call after accepting a join request."""
    _membership_cache.pop(user_id, None)


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


def _decode_jwt(token: str) -> dict:
    """Verify and decode a Supabase JWT. Raises HTTPException on failure."""
    try:
        header = jwt.get_unverified_header(token)
        alg = header.get("alg", "HS256")

        if alg.startswith("HS"):
            secret = os.environ.get("SUPABASE_JWT_SECRET", "")
            if not secret:
                raise HTTPException(status_code=500, detail="Auth not configured")
            return jwt.decode(token, secret, algorithms=[alg], audience="authenticated")
        else:
            if not os.environ.get("SUPABASE_URL"):
                raise HTTPException(status_code=500, detail="Auth not configured")
            signing_key = _get_jwks_client().get_signing_key_from_jwt(token)
            return jwt.decode(
                token, signing_key.key, algorithms=[alg], audience="authenticated"
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


@dataclass
class CurrentUser:
    id: str
    email: str
    role: str           # org type: "studio" | "vendor"
    member_role: str    # privilege: "owner" | "admin" | "user"
    token: str = field(default="")
    studio_id: str | None = field(default=None)
    vendor_id: str | None = field(default=None)
    is_admin: bool = field(default=False)


@dataclass
class PendingUser:
    """Returned by get_current_user_or_pending when a join request is awaiting approval."""
    id: str
    email: str
    role: str           # org type the user is trying to join
    org_name: str
    org_type: str
    status: str = "pending"


async def _resolve_membership(user_id: str, role: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Look up the user's membership row and return (studio_id, vendor_id, member_role).
    Returns (None, None, None) if no membership row exists.
    """
    cached = _get_cached_membership(user_id)
    if cached is not None:
        return cached

    studio_id = None
    vendor_id = None
    member_role = None

    if _use_user_identity():
        # Post-cutover: resolve via the SECURITY DEFINER RPC (RLS migration §6 #9). The DB — not the
        # app_metadata.role claim — is the source of truth for which org the user belongs to. The
        # caller's token is already bound (set_request_token in get_current_user), so the RPC runs as
        # this user and auth.uid() inside it is their id. `role` is ignored on this path.
        r = await db_client.post(
            _url("/rest/v1/rpc/resolve_my_membership"),
            headers=_headers(),
        )
        rows = r.json() if r.is_success else []
        if rows:
            studio_id = rows[0].get("studio_id")
            vendor_id = rows[0].get("vendor_id")
            member_role = rows[0].get("member_role")
    elif role == "studio":
        r = await db_client.get(
            _url("/rest/v1/studio_members"),
            params={"select": "studio_id,member_role", "user_id": f"eq.{user_id}"},
            headers=_headers(),
        )
        rows = r.json()
        if rows:
            studio_id = rows[0]["studio_id"]
            member_role = rows[0]["member_role"]
    elif role == "vendor":
        r = await db_client.get(
            _url("/rest/v1/vendor_members"),
            params={"select": "vendor_id,member_role", "user_id": f"eq.{user_id}"},
            headers=_headers(),
        )
        rows = r.json()
        if rows:
            vendor_id = rows[0]["vendor_id"]
            member_role = rows[0]["member_role"]

    _set_cached_membership(user_id, studio_id, vendor_id, member_role)
    return studio_id, vendor_id, member_role


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> "CurrentUser":
    """
    Strict dependency: valid JWT + active membership required, or raises 403.
    Used by all protected routes. get_current_user_or_pending is the only exception.
    """
    token = credentials.credentials
    # Bind the caller's identity for the whole request (RLS migration §4). Dormant pre-cutover
    # (_headers ignores it while USE_USER_IDENTITY is off); post-cutover every DB call in this
    # request — including the membership resolution below — runs AS this user. Set before the JWT
    # is decoded so even the bootstrap read is identity-bound.
    set_request_token(token)
    payload = _decode_jwt(token)

    app_metadata = payload.get("app_metadata") or {}
    role = app_metadata.get("role", "")
    if role not in ("studio", "vendor"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No valid role assigned to this account",
        )

    user_id = payload["sub"]
    studio_id, vendor_id, member_role = await _resolve_membership(user_id, role)

    if member_role is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No organisation linked to this account",
        )

    return CurrentUser(
        id=user_id,
        email=payload.get("email", ""),
        role=role,
        member_role=member_role,
        token=token,
        studio_id=studio_id,
        vendor_id=vendor_id,
        is_admin=member_role in ("owner", "admin"),
    )


async def get_current_user_or_pending(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> Union["CurrentUser", "PendingUser"]:
    """
    Lenient dependency used ONLY by GET /api/user/me.
    Returns CurrentUser for active members, PendingUser for users awaiting approval.
    Raises 403 for authenticated users with no membership and no pending request.
    """
    token = credentials.credentials
    set_request_token(token)  # bind identity for the request (RLS migration §4; dormant pre-cutover)
    payload = _decode_jwt(token)

    app_metadata = payload.get("app_metadata") or {}
    role = app_metadata.get("role", "")
    if role not in ("studio", "vendor"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No valid role assigned to this account",
        )

    user_id = payload["sub"]
    email = payload.get("email", "")
    studio_id, vendor_id, member_role = await _resolve_membership(user_id, role)

    if member_role is not None:
        return CurrentUser(
            id=user_id,
            email=email,
            role=role,
            member_role=member_role,
            token=token,
            studio_id=studio_id,
            vendor_id=vendor_id,
            is_admin=member_role in ("owner", "admin"),
        )

    # No membership — check for a pending join request.
    if _use_user_identity():
        # Flag-on: a non-member is denied a direct studios/vendors read (st_sel/v_sel), so resolve the
        # pending request + its org name via the auth.uid()-scoped DEFINER RPC (migration 6). The
        # caller's token is already bound (set_request_token above), so the RPC runs as this user.
        pr = await db_client.post(
            _url("/rest/v1/rpc/rpc_my_pending_org"),
            headers=_headers(),
            json={},
        )
        rows = pr.json() if pr.is_success else []
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="No organisation linked to this account",
            )
        return PendingUser(
            id=user_id,
            email=email,
            role=role,
            org_name=rows[0].get("org_name") or "",
            org_type=role,
        )

    # Flag-off (service-role): direct reads as today.
    req_table = "studio_join_requests" if role == "studio" else "vendor_join_requests"
    org_fk    = "studio_id"             if role == "studio" else "vendor_id"
    org_table = "studios"               if role == "studio" else "vendors"

    r = await db_client.get(
        _url(f"/rest/v1/{req_table}"),
        params={
            "select": f"{org_fk}",
            "user_id": f"eq.{user_id}",
            "status": "eq.pending",
            "limit": "1",
        },
        headers=_headers(),
    )
    rows = r.json() if r.is_success else []
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No organisation linked to this account",
        )

    org_id = rows[0][org_fk]
    org_r = await db_client.get(
        _url(f"/rest/v1/{org_table}"),
        params={"id": f"eq.{org_id}", "select": "name"},
        headers=_headers(),
    )
    org_name = org_r.json()[0]["name"] if org_r.is_success and org_r.json() else ""

    return PendingUser(
        id=user_id,
        email=email,
        role=role,
        org_name=org_name,
        org_type=role,
    )


def require_admin(user: CurrentUser) -> None:
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")


def require_owner(user: CurrentUser) -> None:
    if user.member_role != "owner":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Owner only")


def resolve_owner(user: CurrentUser) -> tuple[str, str]:
    """
    Resolve the org owner for the estimation stack (workflow_steps / estimate_config /
    estimate_matrix), which is scoped to either a studio or a vendor.

    Returns (owner_col, owner_id) where owner_col is the PostgREST column name
    ("studio_id" | "vendor_id") and owner_id is the resolved uuid. This pair is the
    runtime isolation boundary — every estimate-stack / share query must filter on it
    (see docs/plans/vendor-estimate-share.md §2.4/§6.4). Raises 403 if neither is set.
    """
    if user.role == "studio" and user.studio_id:
        return "studio_id", user.studio_id
    if user.role == "vendor" and user.vendor_id:
        return "vendor_id", user.vendor_id
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="No organisation linked to this account",
    )


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
