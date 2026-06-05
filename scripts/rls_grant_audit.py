"""
RLS grant audit — the CATALOG guard for the service-role → RLS migration. Companion to
rls_persona_matrix.py (which checks the DATA PLANE over PostgREST and explicitly cannot see grants or
policies — its catalog checks are SKIP'd with footer SQL).

WHY THIS EXISTS
The RLS migration files were edited after they had already applied to dev/prod (see the [+ADD]/[~MOD]
annotations in 20260530000002 / ...004). A Supabase migration is one transaction recorded BY VERSION,
so a grant added to an already-applied file silently never reaches the live DB. That exact drift broke
vendor payload ingest: arthound_rpc was missing INSERT on payload_export_records, so rpc_ingest_payload
failed with "permission denied for table payload_export_records" (SQLSTATE 42501) and quarantined every
ingest. Code review can't see this — only a live-catalog vs declared-intent diff can.

WHAT IT CHECKS  (roles: arthound_system, arthound_rpc — the two privileged non-owner identities)
  1. GRANT parity — the live table privileges in information_schema.role_table_grants must EQUAL the
     set declared across supabase/migrations (parsed + accumulated in filename order).
       · MISSING (declared in files, absent in DB)  → FAIL. This is the drift that breaks features.
       · EXTRA   (in DB, not declared in files)      → WARN (FAIL under --strict). Possible over-grant.
  2. POLICY presence (grant-derived) — every granted table that has RLS ENABLED must also carry a policy
     for that role. A grant with no policy is dead under FORCE RLS (writes → "new row violates row-level
     security policy"). Derived from the grant set, so no fragile parsing of the dynamic policy loops.
  3. RLS COVERAGE (every public base table) — each must have RLS ENABLED + FORCE'd + ≥1 policy. The ONLY
     tables allowed to be enabled-but-not-forced are the documented FORCE-exempt set (migration
     20260530000005 §1a); an exempt table that IS forced re-arms the recursion/silent-deny footgun. Also
     re-asserts the §1a safety invariant (predicate-fn owner == exempt-table owner). This catches a brand-
     new table shipped with NO RLS (world-readable to any authenticated user) — which check 1 can't see,
     since it only inspects tables granted to the two privileged roles.

SOURCE OF TRUTH is the committed migration SQL — when a new migration legitimately grants something, the
expected set updates automatically and the guard then ensures the live DB actually received it.

CONNECTION
  Set DATABASE_URL to a libpq connection string for the target DB (the Supabase *pooler* string from the
  dashboard works; the legacy direct db.<ref>.supabase.co host is retired on IPv4). Falls back to building
  the direct host from SUPABASE_DB_PASSWORD + the ref in SUPABASE_URL (resolves only where IPv6/direct is
  available). RLS_ENV_FILE=.env.prod targets prod, mirroring rls_persona_matrix.py.

USAGE
  python scripts/rls_grant_audit.py --print-expected        # parse migrations only; NO DB (offline)
  DATABASE_URL=postgresql://... python scripts/rls_grant_audit.py
  RLS_ENV_FILE=.env.prod python scripts/rls_grant_audit.py --strict
Exit 0 = OK (warnings allowed). Exit 1 = drift (missing grants/policies, or extras under --strict).
"""

import os
import re
import sys
import glob

_ROOT = os.path.join(os.path.dirname(__file__), "..")
_MIGRATIONS = os.path.join(_ROOT, "supabase", "migrations")
ROLES = ("arthound_system", "arthound_rpc")

# Tables PERMANENTLY excluded from FORCE by design (predicate-consulted; migration 20260530000005 §1a).
# They keep RLS ENABLED + policies but must NOT be forced, else the membership predicate functions
# recurse / silent-deny. Must stay byte-identical to that migration's `excluded` array. review_grant is
# pre-emptive — it may not exist yet (skipped until it does).
FORCE_EXEMPT = {"studio_members", "vendor_members", "studio_vendor_links", "review_grant"}

# Public base tables intentionally WITHOUT RLS. Empty by design — a public table with no RLS is world-
# readable to any authenticated user (PostgREST exposes it). Add a name here ONLY after confirming it
# holds no tenant data, and say why; otherwise fix the table, don't allowlist it.
RLS_NOT_REQUIRED: set[str] = set()

try:
    sys.stdout.reconfigure(encoding="utf-8")  # /✓/✗ on a cp1252 Windows console
except Exception:  # noqa: BLE001
    pass


# ── env (same contract as rls_persona_matrix.py) ───────────────────────────────
def _load_env() -> None:
    fname = os.environ.get("RLS_ENV_FILE")
    override = fname is not None
    path_name = fname or ".env"
    path = path_name if os.path.isabs(path_name) else os.path.join(_ROOT, path_name)
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


# ── migration parsing (the declared intent) ────────────────────────────────────
# Table grants only: `grant <privs> on [table] public.<tbl> to arthound_<role>;`. Anchoring on
# `public.<ident>` naturally excludes `on function public.foo(...)`, `on schema public`, and the role-
# membership `grant arthound_rpc to <x>` (no `on public.<tbl>`), which must NOT count as table grants.
_GRANT_RE = re.compile(
    r"\bgrant\s+(?P<privs>[a-z][a-z ,]*?)\s+on\s+(?:table\s+)?public\.(?P<tbl>[a-z_][a-z0-9_]*)\s+to\s+"
    r"(?P<role>arthound_system|arthound_rpc)\b",
    re.IGNORECASE,
)
_REVOKE_RE = re.compile(
    r"\brevoke\s+(?P<privs>[a-z][a-z ,]*?)\s+on\s+(?:table\s+)?public\.(?P<tbl>[a-z_][a-z0-9_]*)\s+from\s+"
    r"(?P<role>arthound_system|arthound_rpc)\b",
    re.IGNORECASE,
)
# Visibility net: any line that grants/revokes to one of our roles but isn't a table grant we captured.
_MENTIONS_RE = re.compile(r"\b(grant|revoke)\b.*\barthound_(system|rpc)\b", re.IGNORECASE)
_TABLE_PRIVS = {"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"}


def _split_privs(s: str) -> set[str]:
    out = set()
    for p in s.split(","):
        p = p.strip().upper()
        if p == "ALL" or p == "ALL PRIVILEGES":
            out |= _TABLE_PRIVS
        elif p in _TABLE_PRIVS:
            out.add(p)
    return out


def parse_expected() -> tuple[dict, list]:
    """Accumulate (role, table) -> set(privs) across every migration in filename order.
    Returns (expected, unparsed_lines) where unparsed_lines flags any grant/revoke touching our roles
    that the table-grant/-revoke regexes did NOT capture (so nothing is silently dropped)."""
    expected: dict[tuple[str, str], set[str]] = {}
    unparsed: list[tuple[str, str]] = []
    for path in sorted(glob.glob(os.path.join(_MIGRATIONS, "*.sql"))):
        fname = os.path.basename(path)
        with open(path, encoding="utf-8") as f:
            for raw in f:
                line = raw.split("--", 1)[0]  # drop trailing line comments
                if "arthound_system" not in line and "arthound_rpc" not in line:
                    continue
                g = _GRANT_RE.search(line)
                if g:
                    privs = _split_privs(g["privs"])
                    if privs:
                        expected.setdefault((g["role"], g["tbl"]), set()).update(privs)
                    continue
                rv = _REVOKE_RE.search(line)
                if rv:
                    privs = _split_privs(rv["privs"])
                    key = (rv["role"], rv["tbl"])
                    if key in expected:
                        expected[key] -= privs
                        if not expected[key]:
                            del expected[key]
                    continue
                # Mentions a role with grant/revoke but wasn't a table grant/revoke we model.
                # Benign cases (schema usage, role membership, function execute, dynamic %I policy
                # loops) are expected; list them so a NEW unmodeled table grant can't hide.
                if _MENTIONS_RE.search(line) and "on public." in line.lower():
                    unparsed.append((fname, line.strip()))
    return expected, unparsed


# ── live catalog (the actual state) ─────────────────────────────────────────────
def fetch_live(conn):
    cur = conn.cursor()
    cur.execute(
        "select grantee, table_name, privilege_type "
        "from information_schema.role_table_grants "
        "where table_schema='public' and grantee = any(%s)",
        (list(ROLES),),
    )
    grants: dict[tuple[str, str], set[str]] = {}
    for grantee, tbl, priv in cur.fetchall():
        grants.setdefault((grantee, tbl), set()).add(priv.upper())

    # Every public base table with its RLS posture + owner (drives the coverage sweep).
    cur.execute(
        "select c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relowner "
        "from pg_class c join pg_namespace n on n.oid = c.relnamespace "
        "where n.nspname='public' and c.relkind='r'"
    )
    tables = {r[0]: {"rls": r[1], "force": r[2], "owner": r[3]} for r in cur.fetchall()}

    cur.execute("select tablename, roles from pg_policies where schemaname='public'")
    policy_roles: dict[str, set[str]] = {}
    for tbl, roles in cur.fetchall():
        policy_roles.setdefault(tbl, set()).update(roles or [])

    # Owners of the §1a predicate functions — the FORCE-exemption is only safe while
    # fn-owner == exempt-table-owner (migration 20260530000005).
    cur.execute(
        "select proname, proowner from pg_proc where pronamespace='public'::regnamespace "
        "and proname in ('current_studio_ids','current_vendor_ids','is_link_party')"
    )
    fn_owners = {r[0]: r[1] for r in cur.fetchall()}
    cur.close()
    return grants, tables, policy_roles, fn_owners


def check_rls_coverage(tables, policy_roles, fn_owners) -> None:
    """Item #2 (full sweep): every public base table must have RLS ENABLED + FORCE'd + ≥1 policy, with the
    documented FORCE-exempt set the ONLY tables allowed enabled-but-not-forced. Catches a table shipped
    with no RLS (world-readable) — invisible to the grant audit, which only sees granted tables."""
    global _fail
    print("\nRLS coverage (every public base table forced + policied; exemptions exactly as designed):")
    before = _fail

    for t in sorted(tables):
        info = tables[t]
        # a. world-readable: RLS not enabled at all
        if not info["rls"]:
            if t not in RLS_NOT_REQUIRED:
                _fail += 1
                _say("✗", f"{t}: RLS NOT ENABLED — world-readable to any authenticated user")
            continue
        # b. under-protected: RLS on, not forced, and not a sanctioned exemption
        if not info["force"] and t not in FORCE_EXEMPT:
            _fail += 1
            _say("✗", f"{t}: RLS enabled but NOT FORCE'd (owner/SECURITY DEFINER bypass; FORCE it or justify)")
        # d. deny-all-by-accident: RLS on but no policy at all
        if not policy_roles.get(t):
            _fail += 1
            _say("✗", f"{t}: RLS enabled but has NO policy (deny-all to everyone — likely unintended)")

    # c. re-armed footgun: a FORCE-exempt table got forced
    for t in sorted(FORCE_EXEMPT):
        if t in tables and tables[t]["force"]:
            _fail += 1
            _say("✗", f"{t}: FORCE-exempt by design but IS forced — re-arms §1a recursion/silent-deny")

    # e. §1a safety: predicate-fn owner == exempt-table owner
    fo = fn_owners.get("current_studio_ids")
    if fo is not None:
        for t in ("studio_members", "vendor_members", "studio_vendor_links"):
            if t in tables and tables[t]["owner"] != fo:
                _fail += 1
                _say("✗", f"{t}: owner != current_studio_ids() owner — FORCE-exemption unsafe (§1a)")

    if _fail == before:
        n_rls = sum(1 for i in tables.values() if i["rls"])
        _say("✓", f"all {n_rls} RLS-enabled tables forced+policied; {len(tables) - n_rls} non-RLS; "
                  f"exemptions correct")


# ── reporting ───────────────────────────────────────────────────────────────────
_fail = 0
_warn = 0


def _say(icon, msg):
    print(f"  {icon} {msg}")


def main() -> None:
    global _fail, _warn
    strict = "--strict" in sys.argv
    print_only = "--print-expected" in sys.argv
    _load_env()

    expected, unparsed = parse_expected()
    print(f"RLS grant audit — parsed {len({k[1] for k in expected})} tables across migrations "
          f"for {', '.join(ROLES)}\n")

    if print_only:
        for role in ROLES:
            print(f"[{role}]")
            for (r, tbl), privs in sorted(expected.items()):
                if r == role:
                    print(f"  {tbl:<34} {', '.join(sorted(privs))}")
            print()
        if unparsed:
            print(f"unmodeled grant/revoke lines mentioning a role ({len(unparsed)}):")
            for fn, ln in unparsed:
                print(f"  · {fn}: {ln}")
        sys.exit(0)

    dsn = _resolve_dsn()
    if not dsn:
        print("ERROR: no DATABASE_URL set (and could not build one from SUPABASE_* in the env file).\n"
              "       Set DATABASE_URL to the Supabase pooler connection string, or run "
              "--print-expected for the offline parse.", file=sys.stderr)
        sys.exit(2)

    import psycopg2
    conn = psycopg2.connect(dsn)
    try:
        live_grants, tables, policy_roles, fn_owners = fetch_live(conn)
    finally:
        conn.close()
    rls_enabled = {t for t, info in tables.items() if info["rls"]}

    # 1 ── GRANT parity ────────────────────────────────────────────────────────
    print("GRANT parity (declared in migrations vs live DB):")
    for (role, tbl), want in sorted(expected.items()):
        have = live_grants.get((role, tbl), set())
        missing = want - have
        if missing:
            _fail += 1
            _say("✗", f"{role}: MISSING {', '.join(sorted(missing))} on {tbl}  "
                      f"(declared in migrations, absent in DB — drift)")
    # extras: live grants not declared anywhere
    for (role, tbl), have in sorted(live_grants.items()):
        extra = have - expected.get((role, tbl), set())
        if extra:
            if strict:
                _fail += 1
                _say("✗", f"{role}: EXTRA {', '.join(sorted(extra))} on {tbl} (in DB, not declared)")
            else:
                _warn += 1
                _say("!", f"{role}: extra {', '.join(sorted(extra))} on {tbl} (in DB, not declared)")
    if _fail == 0 and _warn == 0:
        _say("✓", "live grants match declared grants exactly")

    # 2 ── POLICY presence for granted + RLS-enabled tables ─────────────────────
    print("\nPOLICY presence (granted + RLS-enabled table must carry a policy for the role):")
    policy_gaps = 0
    for (role, tbl) in sorted(expected.keys()):
        if tbl not in rls_enabled:
            continue  # no RLS → a policy is moot; grant alone governs
        roles_on_tbl = policy_roles.get(tbl, set())
        if role not in roles_on_tbl and "public" not in roles_on_tbl:
            _fail += 1
            policy_gaps += 1
            _say("✗", f"{role}: GRANTED on {tbl} but NO policy for it (dead grant under FORCE RLS)")
    if policy_gaps == 0:
        _say("✓", "every granted + RLS-enabled table has a policy for its role")

    # 3 ── RLS coverage across ALL public base tables (item #2 full sweep) ───────
    check_rls_coverage(tables, policy_roles, fn_owners)

    if unparsed:
        print(f"\nNote: {len(unparsed)} grant/revoke line(s) mention a role but weren't modeled as table "
              f"grants (expected: schema/role/function/dynamic-policy). Review if a new TABLE grant is among them:")
        for fn, ln in unparsed[:20]:
            print(f"  · {fn}: {ln}")

    print(f"\nResult: {_fail} FAIL, {_warn} WARN" + ("  (--strict)" if strict else ""))
    sys.exit(1 if _fail else 0)


def _resolve_dsn() -> str | None:
    """DATABASE_URL wins. Otherwise build the Supabase DIRECT host from SUPABASE_DB_PASSWORD + the ref in
    SUPABASE_URL (works only where the direct host resolves; the pooler string in DATABASE_URL is the
    portable path)."""
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    url = os.environ.get("SUPABASE_URL", "")
    pw = os.environ.get("SUPABASE_DB_PASSWORD", "")
    m = re.search(r"https://([a-z0-9]+)\.supabase\.co", url)
    if m and pw:
        from urllib.parse import quote
        return f"postgresql://postgres:{quote(pw, safe='')}@db.{m.group(1)}.supabase.co:5432/postgres?sslmode=require"
    return None


if __name__ == "__main__":
    main()
