"""
RLS persona matrix — the durable correctness guard for the service-role → RLS migration (plan §9).

Mints a JWT per persona and asserts the row-visibility contract for every tenancy-critical table by
hitting PostgREST directly (anon apikey + the persona's bearer), so RLS is exercised REGARDLESS of the
app's USE_USER_IDENTITY flag — the flag only governs which header the *app* sends; this script always
sends a user/anon/system bearer, so PostgREST always applies the live policies. Run it after any policy
migration and keep it green in CI.

What it checks (plan §9 matrix + highest-regression-risk list):
  * Studio persona: sees exactly its own rows; zero of another org's (replicated_assets, asset_reviews,
    payload_dispatches, estimate_matrix base-only).
  * Vendor persona: sees its own rows + dispatches it's the recipient of; estimate_matrix base+override.
  * estimate_matrix no studio cross-read (R1): a studio never sees a vendor base row or any override row.
  * §1a (R2): zero-membership user → resolve_my_membership empty + NO stack-depth; the three FORCE-exempt
    membership tables are not FORCE'd; predicate-fn owner == those tables' owner.
  * payload_dispatches recipient-can't-write (R3): a vendor recipient UPDATE affects 0 rows.
  * is_my_org type-binding (R5): a studio id can't match a vendor-owned estimate_matrix row.
  * F-table deny-all: a user reading source_credentials sees nothing.
  * arthound_system: reads the system-scoped F-table a user can't; distinct identity, not god-mode by JWT.
  * Anon: deny-all on protected tables; bootstrap read-RPC still works.
  * Break-glass unreachable: no routes/* module imports lib.db_breakglass / service_role_headers.

Personas are DISCOVERED from live data (a real studio member, a real vendor member), so the guard runs
against dev or prod without hardcoded fixtures. Checks with no data to exercise report SKIP (not FAIL).
Anything this script writes (none today beyond a transient UPDATE that RLS rejects) is non-mutating.

Usage:
    python scripts/rls_persona_matrix.py            # loads .env if present
Exit 0 = all PASS (SKIPs allowed). Exit 1 = one or more FAIL.
"""

import os
import re
import sys
import time
import uuid
import glob

import httpx
import jwt as pyjwt

# Repo root on path so `lib` imports resolve when run from anywhere.
_ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, _ROOT)

# Output uses §/✓/→; force UTF-8 so a cp1252 Windows console doesn't crash the run.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


# ── env ──────────────────────────────────────────────────────────────────────
def _load_env() -> None:
    """Populate os.environ from an env file. Default `.env`; set RLS_ENV_FILE to target another project
    (e.g. RLS_ENV_FILE=.env.prod to run the go/no-go against prod). When RLS_ENV_FILE is given the file's
    values OVERRIDE the ambient environment (so a stray exported SUPABASE_URL can't silently shadow the
    target); with the default .env, pre-set env vars win (CI-friendly)."""
    fname = os.environ.get("RLS_ENV_FILE")
    override = fname is not None
    path_name = fname or ".env"
    path = path_name if os.path.isabs(path_name) else os.path.join(_ROOT, path_name)
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                if override or k not in os.environ:
                    os.environ[k] = v.strip().strip('"').strip("'")


_load_env()
URL    = os.environ["SUPABASE_URL"].rstrip("/")
ANON   = os.environ["SUPABASE_ANON_KEY"]
SECRET = os.environ["SUPABASE_JWT_SECRET"]
SR     = os.environ["SUPABASE_SERVICE_ROLE_KEY"]


# ── header / mint helpers ─────────────────────────────────────────────────────
def _mint_user(sub: str, role: str) -> str:
    now = int(time.time())
    return pyjwt.encode(
        {"sub": sub, "role": "authenticated", "aud": "authenticated",
         "iat": now, "exp": now + 3600, "app_metadata": {"role": role}},
        SECRET, algorithm="HS256",
    )


def _mint_system() -> str:
    now = int(time.time())
    return pyjwt.encode(
        {"role": "arthound_system", "aud": "authenticated",
         "sub": "00000000-0000-0000-0000-000000000000", "iat": now, "exp": now + 3600,
         "jti": uuid.uuid4().hex},
        SECRET, algorithm="HS256",
    )


H_SERVICE = {"apikey": SR, "Authorization": f"Bearer {SR}"}           # bypasses RLS — ground truth
H_ANON    = {"apikey": ANON}                                          # anon role, no bearer


def _user_headers(sub: str, role: str) -> dict:
    return {"apikey": ANON, "Authorization": f"Bearer {_mint_user(sub, role)}"}


client = httpx.Client(base_url=URL, timeout=30.0)


def _rows(headers: dict, table: str, select: str = "*", **params) -> list:
    r = client.get(f"/rest/v1/{table}", headers=headers,
                   params={"select": select, "limit": "10000", **params})
    return r.json() if r.is_success else []


# ── result collection ─────────────────────────────────────────────────────────
_results: list[tuple[str, str, str]] = []  # (name, status, detail) status ∈ PASS/FAIL/SKIP


def record(name: str, status: str, detail: str = "") -> None:
    _results.append((name, status, detail))
    icon = {"PASS": "✓", "FAIL": "✗", "SKIP": "–"}[status]
    print(f"  {icon} [{status}] {name}" + (f"  — {detail}" if detail else ""))


def _visibility(name: str, headers: dict, table: str, owner_cols: list[str], predicate) -> None:
    """Assert the persona sees EXACTLY the rows satisfying `predicate`:
       no over-visibility (every visible row satisfies it) AND no under-visibility (count matches
       ground truth). Computes expected from a service-role read so no PostgREST filter gymnastics."""
    try:
        sel = ",".join(dict.fromkeys(owner_cols))
        truth = _rows(H_SERVICE, table, sel)
        expected = [r for r in truth if predicate(r)]
        seen = _rows(headers, table, sel)
        over = [r for r in seen if not predicate(r)]
        if over:
            record(name, "FAIL", f"{len(over)} visible row(s) violate owner predicate (cross-org leak)")
        elif len(seen) != len(expected):
            record(name, "FAIL", f"under/over-visibility: sees {len(seen)}, expected {len(expected)}")
        else:
            record(name, "PASS", f"sees exactly {len(seen)} own row(s) of {len(truth)} total")
    except Exception as exc:  # noqa: BLE001
        record(name, "FAIL", f"error: {exc}")


# ── persona discovery ─────────────────────────────────────────────────────────
def discover():
    sm = _rows(H_SERVICE, "studio_members", "user_id,studio_id", limit="50")
    vm = _rows(H_SERVICE, "vendor_members", "user_id,vendor_id", limit="50")
    studio = sm[0] if sm else None
    vendor = vm[0] if vm else None
    # a second studio (for explicit cross-org deny), if one exists
    studios = _rows(H_SERVICE, "studios", "id", limit="50")
    other_studio = None
    if studio:
        other_studio = next((s["id"] for s in studios if s["id"] != studio["studio_id"]), None)
    # multi-org user: appears in >1 membership row
    seen_users: dict[str, int] = {}
    for row in sm + vm:
        seen_users[row["user_id"]] = seen_users.get(row["user_id"], 0) + 1
    multi = next((u for u, n in seen_users.items() if n > 1), None)
    return studio, vendor, other_studio, multi


# ── checks ─────────────────────────────────────────────────────────────────────
def check_studio(studio):
    if not studio:
        record("studio persona", "SKIP", "no studio member on this DB")
        return
    sid = studio["studio_id"]
    h = _user_headers(studio["user_id"], "studio")
    _visibility("studio · replicated_assets own-only", h, "replicated_assets",
                ["owner_type", "owner_id"],
                lambda r: r["owner_type"] == "studio" and r["owner_id"] == sid)
    _visibility("studio · asset_reviews own-only", h, "asset_reviews",
                ["studio_id", "author_org_type", "author_org_id"],
                lambda r: r["studio_id"] == sid or (r.get("author_org_type") == "studio" and r.get("author_org_id") == sid))
    _visibility("studio · payload_dispatches sender-only", h, "payload_dispatches",
                ["sender_studio_id", "recipient_vendor_id"],
                lambda r: r["sender_studio_id"] == sid)
    _visibility("studio · estimate_matrix base-only (R1/R5)", h, "estimate_matrix",
                ["studio_id", "vendor_id", "link_id"],
                lambda r: r["studio_id"] == sid and r["link_id"] is None)
    # F-table deny-all
    creds = _rows(h, "source_credentials", "owner_type")
    record("studio · source_credentials deny-all (F-table)", "PASS" if not creds else "FAIL",
           f"sees {len(creds)} (expect 0)")


def check_studio_cross_org_deny(studio, other_studio):
    if not studio or not other_studio:
        record("studio · explicit cross-org deny", "SKIP", "need a second studio with data")
        return
    h = _user_headers(studio["user_id"], "studio")
    # pick a replicated_asset owned by the OTHER studio, confirm invisible by id
    foreign = _rows(H_SERVICE, "replicated_assets", "canonical_asset_id,owner_id",
                    owner_type="eq.studio", owner_id=f"eq.{other_studio}", limit="1")
    if not foreign:
        record("studio · explicit cross-org deny", "SKIP", "other studio has no assets")
        return
    caid = foreign[0]["canonical_asset_id"]
    seen = _rows(h, "replicated_assets", "canonical_asset_id",
                 canonical_asset_id=f"eq.{caid}", owner_type="eq.studio", owner_id=f"eq.{other_studio}")
    record("studio · explicit cross-org deny", "PASS" if not seen else "FAIL",
           f"reads foreign asset by id → {len(seen)} rows (expect 0)")


def check_vendor(vendor):
    if not vendor:
        record("vendor persona", "SKIP", "no vendor member on this DB")
        return
    vid = vendor["vendor_id"]
    h = _user_headers(vendor["user_id"], "vendor")
    _visibility("vendor · replicated_assets own-only", h, "replicated_assets",
                ["owner_type", "owner_id"],
                lambda r: r["owner_type"] == "vendor" and r["owner_id"] == vid)
    _visibility("vendor · payload_dispatches recipient-only", h, "payload_dispatches",
                ["sender_studio_id", "recipient_vendor_id"],
                lambda r: r["recipient_vendor_id"] == vid)
    _visibility("vendor · estimate_matrix base+override", h, "estimate_matrix",
                ["studio_id", "vendor_id", "link_id"],
                lambda r: r["vendor_id"] == vid)


def _assert_override_hidden(name: str, override_id: str, studio_user: str) -> None:
    seen = _rows(_user_headers(studio_user, "studio"), "estimate_matrix", "id", id=f"eq.{override_id}")
    record(name, "PASS" if not seen else "FAIL",
           f"studio party reads its link's override row → {len(seen)} (expect 0)")


def check_estimate_override_hidden_from_studio():
    """R1 hardened (the highest-regression-risk policy): a vendor OVERRIDE row (vendor_id + link_id,
    studio_id NULL) must be invisible to the studio party on that link — the exact row the rejected
    `em_studio_link_read` policy would have leaked. Uses an existing override row if one is present;
    otherwise, when RLS_MATRIX_SEED=1, transiently seeds one on a real link (always cleaned up in
    finally) so the case is exercised even on a DB with no override data. Read-only by default."""
    name = "estimate_matrix · override hidden from studio (R1)"
    overrides = [r for r in _rows(H_SERVICE, "estimate_matrix", "id,vendor_id,link_id,studio_id", limit="200")
                 if r["link_id"] is not None and r["vendor_id"] is not None]
    if overrides:
        ov = overrides[0]
        link = _rows(H_SERVICE, "studio_vendor_links", "studio_id", id=f"eq.{ov['link_id']}")
        member = _rows(H_SERVICE, "studio_members", "user_id", studio_id=f"eq.{link[0]['studio_id']}", limit="1") if link else []
        if not member:
            record(name, "SKIP", "override's link studio has no member")
            return
        _assert_override_hidden(name, ov["id"], member[0]["user_id"])
        return

    if os.environ.get("RLS_MATRIX_SEED") != "1":
        record(name, "SKIP", "no override rows; set RLS_MATRIX_SEED=1 to seed+test (base-only check covers the invariant)")
        return

    # Seed path (opt-in): need a link whose studio has a member, and any workflow_step for the FK.
    link = next((l for l in _rows(H_SERVICE, "studio_vendor_links", "id,studio_id,vendor_id", limit="50")
                 if _rows(H_SERVICE, "studio_members", "user_id", studio_id=f"eq.{l['studio_id']}", limit="1")), None)
    ws = _rows(H_SERVICE, "workflow_steps", "id", limit="1")
    if not link or not ws:
        record(name, "SKIP", "RLS_MATRIX_SEED=1 but no link-with-member / workflow_step to seed")
        return
    studio_user = _rows(H_SERVICE, "studio_members", "user_id", studio_id=f"eq.{link['studio_id']}", limit="1")[0]["user_id"]
    seeded = None
    try:
        ins = client.post("/rest/v1/estimate_matrix",
                          headers={**H_SERVICE, "Content-Type": "application/json", "Prefer": "return=representation"},
                          json={"vendor_id": link["vendor_id"], "link_id": link["id"], "studio_id": None,
                                "workflow_step_id": ws[0]["id"], "variable_values": {"__rls_probe__": True},
                                "estimate_days": 1})
        if not ins.is_success:
            record(name, "FAIL", f"seed insert failed: {ins.status_code} {ins.text[:80]}")
            return
        seeded = ins.json()[0]["id"]
        _assert_override_hidden(name + " [seeded]", seeded, studio_user)
    finally:
        if seeded:
            client.request("DELETE", "/rest/v1/estimate_matrix", headers=H_SERVICE, params={"id": f"eq.{seeded}"})


def check_counterparty_directory():
    """Migration 14: a linked party CAN resolve the counterparty org's name via rpc_org_directory
    (safe fields only — NEVER invite_code); an org with no link/invite is absent. Guards the
    post-cutover 'Unknown Studio/Vendor' + empty-dropdown regression."""
    name = "rpc_org_directory · linked counterparty name (mig 14)"
    link = next((l for l in _rows(H_SERVICE, "studio_vendor_links", "studio_id,vendor_id", limit="50")
                 if _rows(H_SERVICE, "vendor_members", "user_id", vendor_id=f"eq.{l['vendor_id']}", limit="1")), None)
    if not link:
        record(name, "SKIP", "no studio<->vendor link with a vendor member")
        return
    vuser = _rows(H_SERVICE, "vendor_members", "user_id", vendor_id=f"eq.{link['vendor_id']}", limit="1")[0]["user_id"]
    h = {**_user_headers(vuser, "vendor"), "Content-Type": "application/json"}
    r = client.post("/rest/v1/rpc/rpc_org_directory", headers=h, json={"p_org_type": "studio"})
    rows = r.json() if r.is_success else []
    linked = next((x for x in rows if x.get("id") == link["studio_id"]), None)
    leak = any("invite_code" in x for x in rows)
    related = {l["studio_id"] for l in _rows(H_SERVICE, "studio_vendor_links", "studio_id", vendor_id=f"eq.{link['vendor_id']}", limit="200")}
    related |= {i["studio_id"] for i in _rows(H_SERVICE, "studio_vendor_invites", "studio_id", vendor_id=f"eq.{link['vendor_id']}", limit="200")}
    unrelated = next((s["id"] for s in _rows(H_SERVICE, "studios", "id", limit="200") if s["id"] not in related), None)
    unrelated_absent = unrelated is None or not any(x.get("id") == unrelated for x in rows)
    ok = bool(linked and linked.get("name")) and not leak and unrelated_absent
    record(name, "PASS" if ok else "FAIL",
           f"linked-name-resolves={bool(linked and linked.get('name'))} no-invite_code-leak={not leak} unrelated-absent={unrelated_absent}")


def check_recipient_cannot_write(vendor):
    """R3: a vendor recipient UPDATE on payload_dispatches affects 0 rows (write is RPC-only; pd_upd is
    sender-scoped)."""
    if not vendor:
        record("payload_dispatches · recipient can't write (R3)", "SKIP", "no vendor member")
        return
    vid = vendor["vendor_id"]
    disp = _rows(H_SERVICE, "payload_dispatches", "id,expires_at",
                 recipient_vendor_id=f"eq.{vid}", limit="1")
    if not disp:
        record("payload_dispatches · recipient can't write (R3)", "SKIP", "vendor is recipient of none")
        return
    h = {**_user_headers(vendor["user_id"], "vendor"),
         "Content-Type": "application/json", "Prefer": "return=representation"}
    # No-op self-write. Either outcome means the recipient cannot write: a permission-denied (no UPDATE
    # grant) OR a 200 with 0 rows affected (RLS pd_upd USING is sender-only → no row matches). The only
    # FAIL is a 200 that actually returns the mutated row.
    r = client.patch("/rest/v1/payload_dispatches", headers=h,
                     params={"id": f"eq.{disp[0]['id']}"},
                     json={"expires_at": disp[0]["expires_at"]})
    if r.status_code in (401, 403):
        record("payload_dispatches · recipient can't write (R3)", "PASS",
               f"recipient UPDATE denied at grant/RLS (status {r.status_code})")
    elif r.is_success and isinstance(r.json(), list) and len(r.json()) == 0:
        record("payload_dispatches · recipient can't write (R3)", "PASS",
               "recipient UPDATE affected 0 rows (RLS sender-only)")
    else:
        record("payload_dispatches · recipient can't write (R3)", "FAIL",
               f"recipient UPDATE → status {r.status_code}, body {r.text[:80]}")


def check_force_set_and_owner():
    """R2 (b)(c): the three predicate-consulted membership tables must NOT be FORCE'd, and the predicate
    fn owner == those tables' owner. This is a CATALOG (pg_class/pg_proc) assertion — not reachable over
    PostgREST — so the script reports SKIP and the footer SQL is the run-via-supabase-db-query companion.
    The runtime SYMPTOM of a regression here (silent-deny / recursion) IS covered by the R2a check."""
    record("§1a · FORCE-set + fn-owner (R2bc)", "SKIP",
           "catalog check — run footer SQL via `supabase db query` (R2a covers the runtime symptom)")


def check_zero_membership_no_recursion():
    """R2 (a): a zero-membership user calls resolve_my_membership → 200 + empty, NO stack-depth error."""
    h = _user_headers(str(uuid.uuid4()), "studio")
    r = client.post("/rest/v1/rpc/resolve_my_membership", headers={**h, "Content-Type": "application/json"})
    body = r.text[:120]
    ok = r.status_code == 200 and (r.json() == [] or r.json() is None) and "stack depth" not in body.lower()
    record("§1a · zero-membership no recursion (R2a)", "PASS" if ok else "FAIL",
           f"status {r.status_code}, body {body}")


def check_anon_deny():
    bad = []
    for tbl in ("replicated_assets", "payload_dispatches", "source_credentials", "asset_reviews"):
        seen = _rows(H_ANON, tbl, "*", limit="1")
        if seen:
            bad.append(f"{tbl}={len(seen)}")
    record("anon · deny-all on protected tables", "PASS" if not bad else "FAIL",
           "all empty" if not bad else f"LEAK: {bad}")
    # bootstrap read-RPC still works for anon
    r = client.post("/rest/v1/rpc/rpc_registration_required", headers={**H_ANON, "Content-Type": "application/json"}, json={})
    record("anon · bootstrap read-RPC works", "PASS" if r.status_code == 200 else "FAIL",
           f"rpc_registration_required → {r.status_code}")


def check_system_identity(studio):
    """arthound_system reads the system-scoped F-table a user can't — distinct, functional identity."""
    hs = {"apikey": ANON, "Authorization": f"Bearer {_mint_system()}"}
    r = client.get("/rest/v1/source_credentials", headers=hs, params={"select": "owner_type", "limit": "1"})
    sys_ok = r.status_code == 200
    record("system · source_credentials readable (identity #2)", "PASS" if sys_ok else "FAIL",
           f"status {r.status_code} (200 = system token accepted + granted)")


def check_multi_org(multi):
    if not multi:
        record("multi-org persona · union visibility", "SKIP", "no user belongs to >1 org")
        return
    # ground-truth orgs for this user
    sids = [r["studio_id"] for r in _rows(H_SERVICE, "studio_members", "studio_id", user_id=f"eq.{multi}")]
    vids = [r["vendor_id"] for r in _rows(H_SERVICE, "vendor_members", "vendor_id", user_id=f"eq.{multi}")]
    role = "studio" if sids else "vendor"
    h = _user_headers(multi, role)
    seen = _rows(h, "replicated_assets", "owner_type,owner_id")
    bad = [r for r in seen
           if not ((r["owner_type"] == "studio" and r["owner_id"] in sids)
                   or (r["owner_type"] == "vendor" and r["owner_id"] in vids))]
    record("multi-org persona · union visibility", "PASS" if not bad else "FAIL",
           f"{len(seen)} rows, {len(bad)} outside the org union")


def check_breakglass_unreachable():
    """Static guard: no routes/* module imports the break-glass service-role path."""
    offenders = []
    for path in glob.glob(os.path.join(_ROOT, "routes", "**", "*.py"), recursive=True):
        with open(path, encoding="utf-8") as f:
            txt = f.read()
        if re.search(r"\b(db_breakglass|service_role_headers)\b", txt):
            offenders.append(os.path.relpath(path, _ROOT))
    record("break-glass unreachable from routes/*", "PASS" if not offenders else "FAIL",
           "none import it" if not offenders else f"OFFENDERS: {offenders}")


def main():
    print(f"RLS persona matrix → {URL}\n")
    studio, vendor, other_studio, multi = discover()
    print(f"personas: studio={'yes' if studio else 'NONE'}  vendor={'yes' if vendor else 'NONE'}  "
          f"other_studio={'yes' if other_studio else 'no'}  multi_org={'yes' if multi else 'no'}\n")

    check_studio(studio)
    check_studio_cross_org_deny(studio, other_studio)
    check_vendor(vendor)
    check_estimate_override_hidden_from_studio()
    check_counterparty_directory()
    check_recipient_cannot_write(vendor)
    check_zero_membership_no_recursion()
    check_force_set_and_owner()
    check_anon_deny()
    check_system_identity(studio)
    check_multi_org(multi)
    check_breakglass_unreachable()

    n_pass = sum(1 for _, s, _ in _results if s == "PASS")
    n_fail = sum(1 for _, s, _ in _results if s == "FAIL")
    n_skip = sum(1 for _, s, _ in _results if s == "SKIP")
    print(f"\nResult: {n_pass} PASS, {n_fail} FAIL, {n_skip} SKIP")
    client.close()
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()


# ── companion DB-introspection SQL (R2 b/c — run with the service role / supabase db query) ──────────
# These cannot run over PostgREST (no raw SQL); the persona checks above cover the data-plane contract.
#   -- (b) the three membership tables must NOT be FORCE'd:
#   select relname, relforcerowsecurity from pg_class
#    where relname in ('studio_members','vendor_members','studio_vendor_links')
#      and relnamespace='public'::regnamespace;   -- expect relforcerowsecurity = f for all three
#   -- (c) predicate-fn owner == those tables' owner (table-owner exemption, not rolbypassrls):
#   select (select relowner::regrole from pg_class where relname='studio_members'
#             and relnamespace='public'::regnamespace) as tbl_owner,
#          (select proowner::regrole from pg_proc where proname='current_studio_ids'
#             and pronamespace='public'::regnamespace) as fn_owner;   -- expect equal
