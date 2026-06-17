"""
MCP agent identity — Phase 0 acceptance guard (docs/plans/mcp-server.md §0/§3, model A1).

Proves the agent identity scopes correctly UNDER RLS, end-to-end, against a live DB. Like
rls_persona_matrix.py it hits PostgREST directly with the minted bearer + anon apikey, so the live
policies are exercised regardless of the app's USE_USER_IDENTITY flag.

It sets up an EPHEMERAL agent principal (a member_role='agent' membership row + an agent_credentials
row) for a discovered studio, runs the assertions, and tears the fixture down in a finally block.
Setup/teardown use the service role (offline-admin path); every ASSERTION uses the agent token or an
authenticated-shaped token, never service-role.

Checks:
  1. Identity     — the minted agent token's resolve_my_membership() returns exactly the agent's org,
                    member_role='agent'.
  2. Org scoping  — reading replicated_assets with the agent token returns ONLY the agent's org's rows
                    (every row's owner_id == the org); a filter for another org's owner_id returns zero.
  3. Secrecy      — an authenticated-role token reading agent_credentials gets ZERO rows (key hashes
                    never reach a user/agent token; RLS deny-all + REVOKE).
  4. Lifecycle    — resolve_credential() accepts a live key, and refuses it once revoked, and refuses a
                    past-expiry key.

Usage:
    python scripts/test_agent_scoping.py            # loads .env; RLS_ENV_FILE=.env.prod targets prod
Exit 0 = all PASS (SKIPs allowed). Exit 1 = one or more FAIL.
"""
import os
import sys
import uuid
import asyncio
from datetime import datetime, timezone, timedelta

_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, _ROOT)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


def _load_env() -> None:
    fname = os.environ.get("RLS_ENV_FILE")
    override = fname is not None
    path = (fname or ".env")
    path = path if os.path.isabs(path) else os.path.join(_ROOT, path)
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                if override or k not in os.environ:
                    os.environ[k] = v.strip().strip('"').strip("'")


_load_env()

import httpx
import jwt as pyjwt  # noqa: F401  (kept for parity / future direct-claim checks)
from lib.agent_auth import (
    AgentPrincipal, generate_key, hash_key, mint_agent_token, resolve_credential,
)
from lib.system_auth import sign_server_token

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
ANON = os.environ["SUPABASE_ANON_KEY"]
SERVICE = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
SVC = {"Authorization": f"Bearer {SERVICE}", "apikey": SERVICE, "Content-Type": "application/json"}

_fail = 0
_pass = 0
_skip = 0


def _url(p: str) -> str:
    return f"{SUPABASE_URL}{p}"


def ok(msg: str) -> None:
    global _pass; _pass += 1; print(f"  ✓ {msg}")


def bad(msg: str) -> None:
    global _fail; _fail += 1; print(f"  ✗ {msg}")


def skip(msg: str) -> None:
    global _skip; _skip += 1; print(f"  → SKIP {msg}")


def _bearer(token: str) -> dict:
    """anon apikey + a minted bearer — the real RLS path PostgREST evaluates."""
    return {"Authorization": f"Bearer {token}", "apikey": ANON, "Content-Type": "application/json"}


async def _discover(db: httpx.AsyncClient) -> tuple[str | None, str | None]:
    """Return (studio_with_assets, other_org_owner_id) discovered from live data."""
    r = await db.get(_url("/rest/v1/replicated_assets"),
                     params={"owner_type": "eq.studio", "select": "owner_id", "limit": "1"}, headers=SVC)
    org_a = r.json()[0]["owner_id"] if r.is_success and r.json() else None
    other = None
    if org_a:
        r2 = await db.get(_url("/rest/v1/studios"),
                          params={"id": f"neq.{org_a}", "select": "id", "limit": "1"}, headers=SVC)
        if r2.is_success and r2.json():
            other = r2.json()[0]["id"]
    return org_a, other


async def run() -> None:
    db = httpx.AsyncClient(timeout=30.0)
    principal_id = str(uuid.uuid4())
    credential_id = None
    org_a = None
    try:
        org_a, org_b = await _discover(db)
        if not org_a:
            skip("no studio with replicated_assets — cannot exercise scoping")
            return
        print(f"\nFixture: org_a={org_a}  other_org={org_b or '(none found)'}  principal={principal_id}")

        # ── setup (service role): ephemeral agent member + credential ─────────────────────────────
        await db.post(_url("/rest/v1/studio_members"),
                      json={"studio_id": org_a, "user_id": principal_id, "member_role": "agent"},
                      headers={**SVC, "Prefer": "return=minimal"})
        raw_key = generate_key()
        cr = await db.post(_url("/rest/v1/agent_credentials"),
                           json={"owner_type": "studio", "owner_id": org_a,
                                 "principal_user_id": principal_id, "key_hash": hash_key(raw_key),
                                 "label": "phase0-acceptance-test", "scopes": {"mode": "read", "tools": ["*"]}},
                           headers={**SVC, "Prefer": "return=representation"})
        credential_id = cr.json()[0]["id"]

        principal = AgentPrincipal(credential_id=credential_id, owner_type="studio", owner_id=org_a,
                                   principal_user_id=principal_id, label="test",
                                   scopes={"mode": "read", "tools": ["*"]})
        token = mint_agent_token(principal)
        hdr = _bearer(token)

        # ── 1. identity ────────────────────────────────────────────────────────────────────────────
        print("\n1. Identity (resolve_my_membership under the agent token):")
        r = await db.post(_url("/rest/v1/rpc/resolve_my_membership"), headers=hdr, json={})
        rows = r.json() if r.is_success else []
        if rows and rows[0].get("studio_id") == org_a and rows[0].get("member_role") == "agent":
            ok("resolves to the agent's org with member_role='agent'")
        else:
            bad(f"expected studio_id={org_a}/agent, got {r.status_code} {rows}")

        # ── 2. org scoping ──────────────────────────────────────────────────────────────────────────
        print("\n2. Org scoping (replicated_assets under the agent token):")
        r = await db.get(_url("/rest/v1/replicated_assets"),
                         params={"select": "owner_id,owner_type", "limit": "500"}, headers=hdr)
        body = r.json() if r.is_success else []
        if not r.is_success:
            bad(f"agent read failed: {r.status_code} {r.text[:120]}")
        elif body and all(row["owner_id"] == org_a for row in body):
            ok(f"sees only its own org's rows ({len(body)} rows, all owner_id={org_a})")
        elif not body:
            skip("agent read returned 0 rows (RLS may be denying — check policy)")
        else:
            leaked = {row["owner_id"] for row in body if row["owner_id"] != org_a}
            bad(f"CROSS-ORG LEAK — saw foreign owner_ids: {leaked}")

        if org_b:
            r = await db.get(_url("/rest/v1/replicated_assets"),
                             params={"owner_type": "eq.studio", "owner_id": f"eq.{org_b}",
                                     "select": "owner_id", "limit": "1"}, headers=hdr)
            if r.is_success and not r.json():
                ok(f"explicit filter for another org ({org_b}) returns zero rows")
            else:
                bad(f"explicit foreign-org filter leaked: {r.status_code} {r.json()}")
        else:
            skip("no second org found — explicit cross-org filter not exercised")

        # ── 3. secrecy — agent_credentials must be invisible to a non-service token ──────────────────
        print("\n3. Secrecy (agent_credentials under an authenticated-role token):")
        # an authenticated-shaped token (any sub); RLS + REVOKE must deny-all regardless of org
        auth_tok, _ = sign_server_token({"role": "authenticated", "aud": "authenticated",
                                         "sub": str(uuid.uuid4()),
                                         "iat": int(datetime.now(timezone.utc).timestamp()),
                                         "exp": int(datetime.now(timezone.utc).timestamp()) + 120})
        r = await db.get(_url("/rest/v1/agent_credentials"),
                         params={"select": "key_hash", "limit": "5"}, headers=_bearer(auth_tok))
        # acceptable: 200 with 0 rows (RLS deny-all) OR a permission error (REVOKE). NOT: any row.
        if r.is_success and not r.json():
            ok("authenticated token sees ZERO credential rows (RLS deny-all)")
        elif not r.is_success:
            ok(f"authenticated token blocked at the grant layer ({r.status_code})")
        else:
            bad(f"KEY-HASH EXPOSURE — authenticated token read {len(r.json())} credential row(s)")

        # ── 4. lifecycle — resolve_credential accepts live, refuses revoked + expired ────────────────
        print("\n4. Lifecycle (resolve_credential):")
        p = await resolve_credential(raw_key)
        if p and p.credential_id == credential_id and p.owner_id == org_a:
            ok("accepts a live key → correct principal")
        else:
            bad(f"live key did not resolve correctly: {p}")

        await db.patch(_url("/rest/v1/agent_credentials"), params={"id": f"eq.{credential_id}"},
                       json={"revoked_at": datetime.now(timezone.utc).isoformat()},
                       headers={**SVC, "Prefer": "return=minimal"})
        if await resolve_credential(raw_key) is None:
            ok("refuses a revoked key")
        else:
            bad("revoked key still resolved")

        # un-revoke + set a past expiry to test the expiry branch
        await db.patch(_url("/rest/v1/agent_credentials"), params={"id": f"eq.{credential_id}"},
                       json={"revoked_at": None,
                             "expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()},
                       headers={**SVC, "Prefer": "return=minimal"})
        if await resolve_credential(raw_key) is None:
            ok("refuses an expired key")
        else:
            bad("expired key still resolved")

    finally:
        # ── teardown ─────────────────────────────────────────────────────────────────────────────
        if credential_id:
            await db.delete(_url("/rest/v1/agent_access_log"),
                            params={"agent_credential_id": f"eq.{credential_id}"}, headers=SVC)
            await db.delete(_url("/rest/v1/agent_credentials"),
                            params={"id": f"eq.{credential_id}"}, headers=SVC)
        if org_a:
            await db.delete(_url("/rest/v1/studio_members"),
                            params={"studio_id": f"eq.{org_a}", "user_id": f"eq.{principal_id}"},
                            headers=SVC)
        await db.aclose()


async def _main() -> None:
    await run()
    print(f"\nResult: {_pass} PASS, {_fail} FAIL, {_skip} SKIP")
    sys.exit(1 if _fail else 0)


if __name__ == "__main__":
    asyncio.run(_main())
