"""
MCP agent key administration (docs/plans/mcp-server.md §0/§3, identity model A1).

Offline admin CLI to issue / revoke / list MCP agent credentials. Uses the SERVICE-ROLE key (a
sanctioned out-of-band admin path — service-role bypasses RLS; it is forbidden only in the request
SERVER, not in offline scripts, exactly like scripts/backfill_jwt_claims.py).

Issuing a key, in one atomic-ish sequence:
  1. mint a synthetic principal uuid (the agent's auth.uid()); it is NOT a GoTrue account,
  2. insert a studio_members/vendor_members row for it with member_role='agent' (this is what makes
     RLS resolve the agent's org — the whole of identity model A1),
  3. insert an agent_credentials row holding only the key HASH,
  4. print the raw key ONCE (it is never recoverable afterwards).

Revoking sets revoked_at AND deletes the membership row, so the principal is fully off-boarded:
resolve_credential refuses it, and even a not-yet-expired pre-minted token stops resolving via
resolve_my_membership → RLS returns empty.

Usage:
    python scripts/agent_keys.py issue  --org-type studio --org-id <uuid> --label "LoreBot prod" \
                                        [--mode read|write] [--tools "*"] [--expires-days 90]
    python scripts/agent_keys.py issue  --org-type vendor --org-name "Pixel Forge" --label "..."
    python scripts/agent_keys.py list   [--org-type studio --org-id <uuid>]
    python scripts/agent_keys.py revoke --id <credential_id>

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment (loads .env if present).
"""
import os
import sys
import json
import uuid
import asyncio
import argparse
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
load_dotenv()

import httpx

_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, _ROOT)
from lib.agent_auth import generate_key, hash_key  # pure functions, no network

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HEADERS = {
    "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
    "apikey": SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
}
_db = httpx.AsyncClient(timeout=30.0)


def _url(path: str) -> str:
    return f"{SUPABASE_URL}{path}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _resolve_org_id(org_type: str, org_id: str | None, org_name: str | None) -> str:
    if org_id:
        return org_id
    if not org_name:
        sys.exit("ERROR: provide --org-id or --org-name")
    table = "studios" if org_type == "studio" else "vendors"
    r = await _db.get(_url(f"/rest/v1/{table}"),
                      params={"name": f"eq.{org_name}", "select": "id", "limit": "2"},
                      headers=HEADERS)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        sys.exit(f"ERROR: no {org_type} named {org_name!r}")
    if len(rows) > 1:
        sys.exit(f"ERROR: {org_type} name {org_name!r} is ambiguous — use --org-id")
    return rows[0]["id"]


async def _append_event(credential_id: str, owner_type: str, owner_id: str, event: str) -> None:
    await _db.post(_url("/rest/v1/agent_access_log"),
                   json={"agent_credential_id": credential_id, "owner_type": owner_type,
                         "owner_id": owner_id, "event": event},
                   headers={**HEADERS, "Prefer": "return=minimal"})


async def cmd_issue(args) -> None:
    org_type = args.org_type
    owner_id = await _resolve_org_id(org_type, args.org_id, args.org_name)
    principal_id = str(uuid.uuid4())
    member_table = "studio_members" if org_type == "studio" else "vendor_members"
    org_fk = "studio_id" if org_type == "studio" else "vendor_id"

    tools = ["*"] if args.tools.strip() == "*" else [t.strip() for t in args.tools.split(",") if t.strip()]
    scopes = {"mode": args.mode, "tools": tools}
    expires_at = (
        (datetime.now(timezone.utc) + timedelta(days=args.expires_days)).isoformat()
        if args.expires_days else None
    )

    # 1. membership row (the RLS-scoping fact)
    mr = await _db.post(_url(f"/rest/v1/{member_table}"),
                        json={org_fk: owner_id, "user_id": principal_id, "member_role": "agent"},
                        headers={**HEADERS, "Prefer": "return=minimal"})
    if mr.status_code not in (200, 201, 204):
        sys.exit(f"ERROR: could not create agent member row: {mr.status_code} {mr.text}")

    # 2. credential row (only the hash is stored)
    raw_key = generate_key()
    cred = {
        "owner_type": org_type, "owner_id": owner_id, "principal_user_id": principal_id,
        "key_hash": hash_key(raw_key), "label": args.label, "scopes": scopes,
        "created_by": args.created_by, "expires_at": expires_at,
    }
    cr = await _db.post(_url("/rest/v1/agent_credentials"),
                        json=cred, headers={**HEADERS, "Prefer": "return=representation"})
    if cr.status_code not in (200, 201):
        # roll back the orphan membership row (best effort) — an agent member with no credential is inert
        await _db.delete(_url(f"/rest/v1/{member_table}"),
                         params={org_fk: f"eq.{owner_id}", "user_id": f"eq.{principal_id}"},
                         headers=HEADERS)
        sys.exit(f"ERROR: could not create credential: {cr.status_code} {cr.text}")
    credential_id = cr.json()[0]["id"]

    try:
        await _append_event(credential_id, org_type, owner_id, "issued")
    except Exception as exc:  # noqa: BLE001
        print(f"  (warning: issued-event log failed: {exc})")

    print("\n  Agent credential issued.")
    print(f"    credential_id : {credential_id}")
    print(f"    org           : {org_type} {owner_id}")
    print(f"    principal      : {principal_id}  (member_role=agent)")
    print(f"    scopes        : {json.dumps(scopes)}")
    print(f"    expires_at    : {expires_at or 'never'}")
    print("\n  API KEY (shown ONCE — store it now; it cannot be recovered):\n")
    print(f"    {raw_key}\n")


async def cmd_revoke(args) -> None:
    r = await _db.get(_url("/rest/v1/agent_credentials"),
                      params={"id": f"eq.{args.id}",
                              "select": "id,owner_type,owner_id,principal_user_id,revoked_at",
                              "limit": "1"},
                      headers=HEADERS)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        sys.exit(f"ERROR: no credential {args.id}")
    row = rows[0]
    if row.get("revoked_at"):
        print(f"  Already revoked at {row['revoked_at']}.")
        return

    await _db.patch(_url("/rest/v1/agent_credentials"),
                    params={"id": f"eq.{args.id}"},
                    json={"revoked_at": _now_iso()},
                    headers={**HEADERS, "Prefer": "return=minimal"})

    # full off-board: drop the principal's membership row so no token can ever resolve it again
    member_table = "studio_members" if row["owner_type"] == "studio" else "vendor_members"
    org_fk = "studio_id" if row["owner_type"] == "studio" else "vendor_id"
    await _db.delete(_url(f"/rest/v1/{member_table}"),
                     params={org_fk: f"eq.{row['owner_id']}",
                             "user_id": f"eq.{row['principal_user_id']}"},
                     headers=HEADERS)
    try:
        await _append_event(args.id, row["owner_type"], row["owner_id"], "revoked")
    except Exception:  # noqa: BLE001
        pass
    print(f"  Revoked {args.id} and removed its agent member row.")


async def cmd_list(args) -> None:
    params = {"select": "id,owner_type,owner_id,label,scopes,created_at,expires_at,revoked_at,last_used_at",
              "order": "created_at.desc"}
    if args.org_id:
        params["owner_type"] = f"eq.{args.org_type}"
        params["owner_id"] = f"eq.{args.org_id}"
    r = await _db.get(_url("/rest/v1/agent_credentials"), params=params, headers=HEADERS)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        print("  (no credentials)")
        return
    for c in rows:
        state = "REVOKED" if c.get("revoked_at") else "active"
        print(f"  {c['id']}  [{state}]  {c['owner_type']} {c['owner_id']}")
        print(f"      label={c['label']!r}  scopes={json.dumps(c['scopes'])}")
        print(f"      created={c['created_at']}  expires={c.get('expires_at') or 'never'}  "
              f"last_used={c.get('last_used_at') or 'never'}")


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="MCP agent key administration")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("issue", help="issue a new agent API key")
    pi.add_argument("--org-type", required=True, choices=["studio", "vendor"])
    pi.add_argument("--org-id")
    pi.add_argument("--org-name")
    pi.add_argument("--label", required=True)
    pi.add_argument("--mode", choices=["read", "write"], default="read")
    pi.add_argument("--tools", default="*", help='comma-separated tool allowlist, or "*"')
    pi.add_argument("--expires-days", type=int, default=0, help="0 = never")
    pi.add_argument("--created-by", help="uuid of the human issuing this (optional)")
    pi.set_defaults(func=cmd_issue)

    pr = sub.add_parser("revoke", help="revoke a credential + off-board its principal")
    pr.add_argument("--id", required=True)
    pr.set_defaults(func=cmd_revoke)

    pl = sub.add_parser("list", help="list credentials (no secrets)")
    pl.add_argument("--org-type", choices=["studio", "vendor"], default="studio")
    pl.add_argument("--org-id")
    pl.set_defaults(func=cmd_list)
    return p


async def _main() -> None:
    args = _build_parser().parse_args()
    try:
        await args.func(args)
    finally:
        await _db.aclose()


if __name__ == "__main__":
    asyncio.run(_main())
