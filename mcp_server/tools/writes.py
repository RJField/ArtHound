"""Lightweight write tools (docs/plans/mcp-server.md §3 Phase 2).

Each creates an ArtHound-native paper-trail record for a human to act on — it does NOT mutate
production state. All require a write-scoped credential, carry mandatory actor attribution
(actor_type='agent' / actor_ref=<credential id>), and abort rather than write an orphan when a
canonical asset can't be resolved.
"""
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from lib.db import db_client, _url, _headers
from lib.agent_auth import AgentPrincipal
from mcp_server.context import tool_call
from mcp_server.shaping import owner_filter


async def _resolve_canonical(p: AgentPrincipal, asset_id: str) -> str:
    """Resolve a source asset id to its canonical_asset_id within the agent's org, or abort."""
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={**owner_filter(p), "source_record_id": f"eq.{asset_id}",
                "select": "canonical_asset_id", "limit": "1"},
        headers=_headers(),
    )
    rows = r.json() if r.is_success else []
    cid = rows[0].get("canonical_asset_id") if rows else None
    if not cid:
        raise ToolError(f"no canonical asset for {asset_id!r} in scope — refusing to write an orphan")
    return cid


async def _insert(table: str, row: dict) -> dict:
    r = await db_client.post(
        _url(f"/rest/v1/{table}"), json=row,
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not r.is_success or not r.json():
        raise ToolError(f"could not record to {table}: {r.status_code} {r.text[:160]}")
    return r.json()[0]


async def flag_asset_risk(asset_id: str, risk_type: str, summary: str,
                          severity: str | None = None, evidence: dict | None = None) -> dict[str, Any]:
    """Raise a risk flag against an asset — a delivery, quality, or dependency concern — with your
    reasoning and any supporting evidence.

    This creates a flag record visible to the asset's producer; it does NOT change production state.
    `risk_type` ∈ delivery|quality|dependency|other; `severity` (optional) ∈ low|medium|high;
    `evidence` is a free-form object of supporting detail. Requires a write-scoped credential.
    """
    if risk_type not in ("delivery", "quality", "dependency", "other"):
        raise ToolError("risk_type must be one of delivery|quality|dependency|other")
    if severity is not None and severity not in ("low", "medium", "high"):
        raise ToolError("severity must be one of low|medium|high")
    async with tool_call("paw_v1_flag_asset_risk", write=True) as p:
        cid = await _resolve_canonical(p, asset_id)
        row = await _insert("asset_flags", {
            "owner_type": p.owner_type, "owner_id": p.owner_id, "canonical_asset_id": cid,
            "risk_type": risk_type, "severity": severity, "summary": summary,
            "evidence": evidence or {}, "actor_type": "agent", "actor_ref": p.credential_id,
        })
        return {"flag_id": row["id"], "status": row["status"], "canonical_asset_id": cid}


async def request_human_review(asset_id: str, subject: str, context: str | None = None) -> dict[str, Any]:
    """Escalate to a human: request that a person review something about an asset.

    The "good agent behavior" surface — call this when you hit a confidence boundary rather than
    guessing and acting. Creates a review-request record visible to the asset's producer. `subject` is
    what needs review; `context` is your reasoning / why you're unsure. Requires a write-scoped credential.
    """
    async with tool_call("paw_v1_request_human_review", write=True) as p:
        cid = await _resolve_canonical(p, asset_id)
        row = await _insert("review_requests", {
            "owner_type": p.owner_type, "owner_id": p.owner_id, "canonical_asset_id": cid,
            "subject": subject, "context": context, "actor_type": "agent", "actor_ref": p.credential_id,
        })
        return {"request_id": row["id"], "status": row["status"], "canonical_asset_id": cid}


async def propose_estimate_adjustment(proposed_estimate_days: float, reasoning: str,
                                      workflow_step_id: str | None = None,
                                      variable_values: dict[str, Any] | None = None,
                                      asset_id: str | None = None,
                                      current_estimate_days: float | None = None) -> dict[str, Any]:
    """Propose an adjustment to an estimation-matrix cell, with your reasoning, for human review.

    Preserves producer authority: this records a PROPOSAL (status='pending'), it does not change the
    matrix. `workflow_step_id` + `variable_values` identify the cell; `proposed_estimate_days` is your
    suggested value; `asset_id` (optional) gives context for an asset that motivated it. Requires a
    write-scoped credential.
    """
    async with tool_call("paw_v1_propose_estimate_adjustment", write=True) as p:
        cid = await _resolve_canonical(p, asset_id) if asset_id else None
        row = await _insert("estimate_adjustment_proposals", {
            "owner_type": p.owner_type, "owner_id": p.owner_id,
            "workflow_step_id": workflow_step_id, "canonical_asset_id": cid,
            "current_estimate_days": current_estimate_days,
            "proposed_estimate_days": proposed_estimate_days,
            "variable_values": variable_values, "reasoning": reasoning,
            "actor_type": "agent", "actor_ref": p.credential_id,
        })
        return {"proposal_id": row["id"], "status": row["status"]}
