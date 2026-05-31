"""
Break-glass service-role access (RLS migration §0c / identity #4).

DELIBERATELY ISOLATED from lib/db.py and never imported by routes/*. After the cutover the
service-role key is migrations + break-glass + the two structural carve-outs only. This module
is the one sanctioned, grep-able, env-gated way for app/operational code to obtain service-role
headers — so a reviewer can find every such use by searching for this import.

The §0c carve-outs (GoTrue Admin API, Storage blob I/O) do NOT go through here — they are not
PostgREST/service-role-key table access; they use the Admin API / storage headers directly and
are allowlisted by name in the §9 break-glass-unreachable test.

Guarded by ALLOW_SERVICE_ROLE=1. The HTTP app process must NOT set that flag in normal operation
(assert_breakglass_not_in_server() enforces it at startup); only scripts / a deliberate, logged,
time-boxed break-glass deploy set it.
"""
import os


def _enabled() -> bool:
    return os.environ.get("ALLOW_SERVICE_ROLE") == "1"


def service_role_headers(extra: dict | None = None) -> dict:
    """Service-role (RLS-bypassing) headers. Raises unless ALLOW_SERVICE_ROLE=1."""
    if not _enabled():
        raise RuntimeError(
            "service_role_headers() requires ALLOW_SERVICE_ROLE=1. This is break-glass only — "
            "do not enable it in the HTTP server process."
        )
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
        **(extra or {}),
    }


def assert_breakglass_not_in_server() -> None:
    """Refuse to boot the HTTP server with break-glass enabled (plan §0b: service-role must not be
    the default in a process serving requests). Call from the app startup path."""
    if _enabled():
        raise RuntimeError(
            "ALLOW_SERVICE_ROLE=1 is set in a request-serving process — refusing to start. "
            "Break-glass is for scripts / deliberate maintenance only."
        )
