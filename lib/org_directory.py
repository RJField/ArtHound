"""
Link/invite-authorized counterparty org-name resolution (RLS migration 14).

Under FORCE RLS (flag-on), `studios`/`vendors` are scoped to the caller's OWN org (st_sel/v_sel), so
resolving a COUNTERPARTY org's display name (connections, the Send-to-Vendor dropdown, estimate shares,
pending invites) returns nothing → "Unknown Studio"/"Unknown Vendor". This helper routes those reads
through `rpc_org_directory` — a postgres-owned SECURITY DEFINER fn that returns only safe fields
(id, name, handle; NEVER invite_code) for orgs the caller owns / is linked to / has a pending invite
with. Flag-off keeps the legacy direct read (service-role), byte-identical to pre-cutover.
"""
from lib.db import db_client, _url, _headers, _use_user_identity


async def resolve_counterparty_names(org_type: str, ids) -> dict:
    """Return {org_id: {"id","name","handle"}} for the given counterparty org ids.

    `org_type` is "studio" or "vendor". Only ids the caller is entitled to (own / linked / invited)
    resolve; any other id is simply absent from the map (callers fall back to "Unknown …").
    """
    ids = [i for i in dict.fromkeys(ids or []) if i]
    if not ids:
        return {}

    if _use_user_identity():
        # Flag-on: safe-fields DEFINER RPC (authorization is inside the fn). Returns the caller's whole
        # directory of that org type; filter to the requested ids client-side.
        r = await db_client.post(
            _url("/rest/v1/rpc/rpc_org_directory"),
            json={"p_org_type": org_type},
            headers=_headers(),
        )
        rows = r.json() if r.is_success else []
        want = set(ids)
        return {row["id"]: row for row in rows if row.get("id") in want}

    # Flag-off (legacy service-role): direct read (studios have no `handle` column).
    table = "studios" if org_type == "studio" else "vendors"
    select = "id,name,handle" if org_type == "vendor" else "id,name"
    r = await db_client.get(
        _url(f"/rest/v1/{table}"),
        params={"id": f"in.({','.join(ids)})", "select": select},
        headers=_headers(),
    )
    return {row["id"]: row for row in (r.json() if r.is_success else [])}
