"""Asset timeline (docs/plans/mcp-server.md §3 Phase 3) — v0.

Composes a chronological, actor-attributed event stream for one asset from the event-shaped sources
that exist TODAY: cross-org/internal review lifecycle (review_events via review_assets) and payload
dispatch lifecycle (sent / received / revoked). All RLS-scoped to the agent's org.

v0 is deliberately partial: source-field change history (status moved, estimate changed, …) needs the
asset-change-capture warehouse (docs/plans/asset-change-capture.md, not built). When that lands, this
tool reads paw_change_events through lib/changes.py and the stream becomes complete. The response is
labelled `partial: true` so a consumer knows not to treat absence of an event as absence of change.
"""
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from lib.db import db_client, _url, _headers
from mcp_server.context import tool_call
from mcp_server.shaping import owner_filter


async def get_asset_timeline(asset_id: str, limit: int = 100) -> dict[str, Any]:
    """A chronological, actor-attributed event stream for one asset — what actually happened to it.

    Composes review-cycle events and payload-dispatch lifecycle (sent/received/revoked), newest first.
    `asset_id` is the asset's stable id. NOTE: this is a partial view (`partial: true` in the result) —
    source-field change history is not yet captured, so the absence of an event does not mean nothing
    changed. Critical for retrospective reasoning about an asset's journey.
    """
    async with tool_call("paw_v1_get_asset_timeline") as p:
        ar = await db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={**owner_filter(p), "source_record_id": f"eq.{asset_id}",
                    "select": "canonical_asset_id,name", "limit": "1"},
            headers=_headers(),
        )
        rows = ar.json() if ar.is_success else []
        if not rows:
            raise ToolError(f"no asset {asset_id!r} in scope")
        cid = rows[0].get("canonical_asset_id")
        if not cid:
            raise ToolError(f"asset {asset_id!r} has no canonical link")

        events: list[dict] = []

        async def _get(path: str, params: dict) -> list[dict]:
            # A non-2xx here is a tool bug (bad column/filter), not "no data" — surface it loudly
            # rather than silently returning an empty (and misleadingly complete-looking) timeline.
            r = await db_client.get(_url(path), params=params, headers=_headers())
            if not r.is_success:
                raise ToolError(f"timeline source {path} failed: {r.status_code} {r.text[:160]}")
            return r.json()

        # ── dispatch lifecycle (payload_dispatches.asset_id → canonical_assets) ──
        # received_at was dropped (migration 20260503000004); ingest receipt lives on
        # payload_field_mappings (vendor-scoped) and is out of v0. Sent + revoked only.
        for d in await _get("/rest/v1/payload_dispatches",
                            {"asset_id": f"eq.{cid}",
                             "select": "id,created_at,revoked_at,recipient_vendor_id", "limit": "500"}):
            base = {"source": "dispatch", "dispatch_id": d["id"], "vendor_id": d.get("recipient_vendor_id")}
            if d.get("created_at"):
                events.append({"at": d["created_at"], "kind": "dispatch_sent", **base})
            if d.get("revoked_at"):
                events.append({"at": d["revoked_at"], "kind": "dispatch_revoked", **base})

        # ── review lifecycle (review_assets → review_events) ──
        review_ids = [r["review_id"] for r in await _get(
            "/rest/v1/review_assets", {"canonical_asset_id": f"eq.{cid}", "select": "review_id", "limit": "500"})]
        if review_ids:
            for e in await _get(
                "/rest/v1/review_events",
                {"review_id": f"in.({','.join(review_ids)})",
                 "select": "review_id,subject_type,event_type,actor_org_type,actor_org_id,created_at",
                 "order": "created_at.desc", "limit": "500"}):
                actor = (f"{e['actor_org_type']}:{e['actor_org_id']}"
                         if e.get("actor_org_type") and e.get("actor_org_id") else None)
                events.append({"at": e["created_at"], "kind": f"review_{e['event_type']}",
                               "source": "review", "actor": actor,
                               "review_id": e["review_id"], "subject_type": e.get("subject_type")})

        events = [e for e in events if e.get("at")]
        events.sort(key=lambda e: e["at"], reverse=True)

        return {
            "asset_id": asset_id,
            "canonical_asset_id": cid,
            "name": rows[0].get("name"),
            "partial": True,
            "coverage": "review + dispatch lifecycle; source-field change history pending asset-change-capture",
            "events": events[:limit],
            "count": min(len(events), limit),
        }
