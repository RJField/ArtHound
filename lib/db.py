import os
import contextvars
import httpx

# ── Shared connection pool ───────────────────────────────────────────────────
db_client = httpx.AsyncClient(
    timeout=30.0,
    limits=httpx.Limits(max_keepalive_connections=10, max_connections=25, keepalive_expiry=30.0),
)

_PAGE = 200

# ── Runtime identity (RLS migration §4) ──────────────────────────────────────
# The cutover lever (plan §8). Read PER CALL, not at import, so a flip is a runtime
# env change, not a redeploy — and every worker sees the same value at one instant.
#   off (default): _headers() returns SERVICE-ROLE headers — byte-identical to the
#                  pre-RLS behaviour. The whole refactor ships dormant.
#   on:            _headers() returns the CONTEXTUAL identity (anon key + the token in
#                  _token_ctx) and FAILS CLOSED if no identity is bound — no silent
#                  service-role or anon fallback (plan finding H1).
def _use_user_identity() -> bool:
    return os.environ.get("USE_USER_IDENTITY") == "1"


# Request/job-scoped bearer token. Set by the FastAPI middleware from the caller's JWT
# (user identity #1) or by system_identity() for background jobs (identity #2).
# ContextVar is task-safe: each request/task sees only its own value, and
# asyncio.create_task() snapshots the current context at creation.
_token_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar("db_token", default=None)


def set_request_token(token: str | None):
    """Bind the active identity token for the current context. Returns the Token handle
    so the caller can reset it (the middleware does). Background jobs use system_identity()."""
    return _token_ctx.set(token)


def reset_request_token(handle) -> None:
    try:
        _token_ctx.reset(handle)
    except (ValueError, LookupError):
        # reset across a different context (e.g. handle from another task) — ignore.
        pass


def current_token() -> str | None:
    return _token_ctx.get()


def _url(path: str) -> str:
    return f"{os.environ['SUPABASE_URL']}{path}"


def _service_role_headers(extra: dict) -> dict:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
        **extra,
    }


def _anon_headers(extra: dict = {}) -> dict:
    """Anon (no-bearer) headers for PUBLIC / pre-login endpoints.

    apikey = anon key, NO Authorization bearer → PostgREST runs as the `anon` role. Used by the few
    unauthenticated read paths (org invite-code resolution, the platform registration gate), which call
    anon-granted SECURITY DEFINER read-RPCs (migration 6) that return only public-safe fields.
    Flag-independent: never relies on a bound token or the service key, so it behaves identically whether
    USE_USER_IDENTITY is on or off.
    """
    return {
        "apikey": os.environ["SUPABASE_ANON_KEY"],
        "Content-Type": "application/json",
        **extra,
    }


def _admin_headers(extra: dict = {}) -> dict:
    """Service-role headers for the GoTrue Admin API (/auth/v1/admin/*) ONLY.

    A SANCTIONED structural carve-out (plan §0c): the Admin API is not a PostgREST table, so
    RLS and the system role do not apply — only the service key reaches it. Always returns
    service-role regardless of USE_USER_IDENTITY (a user JWT would be rejected by GoTrue).
    Used by member-email resolution, signup, and account deletion.

    Do NOT use this for PostgREST table access — that is what _headers() (and, for the rare
    sanctioned table case, lib/db_breakglass) are for. The §9 break-glass-unreachable test
    allowlists exactly this helper + storage headers and nothing else.
    """
    return _service_role_headers(extra)


def _headers(extra: dict = {}) -> dict:
    """Identity-aware PostgREST headers.

    Pre-cutover (USE_USER_IDENTITY unset): service-role, exactly as before.
    Post-cutover: anon key + the context-bound token (user JWT or system token). Raises
    if nothing is bound — a request without an identity, or a background job that forgot
    to enter system_identity(), is a bug and must fail loudly rather than leak/strand.
    """
    if not _use_user_identity():
        return _service_role_headers(extra)

    tok = _token_ctx.get()
    if tok is None:
        raise RuntimeError(
            "No DB identity in context: a user request must bind its JWT (middleware) and a "
            "background job must run inside system_identity(). Refusing to fall back to service-role."
        )
    return {
        "Authorization": f"Bearer {tok}",
        "apikey": os.environ["SUPABASE_ANON_KEY"],
        "Content-Type": "application/json",
        **extra,
    }


# ── Deprecated: retained only so existing imports don't break. Do not add new callers. ──
# Superseded by the _token_ctx mechanism above. _headers() is now the per-identity builder.
def _user_headers(jwt: str, extra: dict = {}) -> dict:
    anon_key = os.environ["SUPABASE_ANON_KEY"]
    return {
        "Authorization": f"Bearer {jwt}",
        "apikey": anon_key,
        "Content-Type": "application/json",
        **extra,
    }


async def drain_pages(url: str, params: dict, page: int = _PAGE, headers: dict | None = None) -> list[dict]:
    """Collect all rows from a PostgREST endpoint using limit/offset pagination."""
    h = headers if headers is not None else _headers()
    rows: list[dict] = []
    offset = 0
    while True:
        r = await db_client.get(
            url,
            params={**params, "limit": page, "offset": offset},
            headers=h,
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += len(batch)
    return rows
