"""Shared PAW-shaping helpers for MCP read tools.

These keep tool bodies thin and consistent: org-scope filters, slot reads (meta["__slots"]), and a
meta cleaner that strips ArtHound-internal keys (especially `__slots`, which must NEVER leak) and the
noisy Jira plumbing fields the app already hides. Mirrors routes/assets.py:_META_HIDDEN intent.
"""
from lib.agent_auth import AgentPrincipal

# Demoted slots live here (status/priority/team/dev_name/item_type) — read, never echoed raw.
_SLOTS_KEY = "__slots"

# Meta keys never returned to an agent: the internal slots payload + the Jira/source plumbing the app
# strips before its own UI (routes/assets.py). Lower-cased for case-insensitive matching.
_META_HIDDEN = {
    "__slots", "_jira_self", "workratio", "statuscategorychangedate", "lastviewed", "watches",
    "votes", "progress", "timespent", "timeestimate", "timeoriginalestimate",
    "aggregatetimespent", "aggregatetimeestimate", "aggregatetimeoriginalestimate",
    "rank",
    # Jira display-name variants
    "time spent", "remaining estimate", "original estimate", "work ratio", "rank (jira)",
}


def owner_filter(p: AgentPrincipal) -> dict:
    """PostgREST params scoping a replicated_* / replicated_work read to the agent's org.
    RLS enforces this too; the explicit filter is correctness + clarity."""
    return {"owner_type": f"eq.{p.owner_type}", "owner_id": f"eq.{p.owner_id}"}


def get_slot(meta: dict | None, slot: str):
    """Read an ArtHound-normalized slot value (item_type/status/priority/team/dev_name)."""
    return (meta or {}).get(_SLOTS_KEY, {}).get(slot)


def slots(meta: dict | None) -> dict:
    """The full slot bundle, shaped for output."""
    s = (meta or {}).get(_SLOTS_KEY, {}) or {}
    return {
        "item_type": s.get("item_type"),
        "status": s.get("status"),
        "priority": s.get("priority"),
        "team": s.get("team"),
        "dev_name": s.get("dev_name"),
    }


def clean_meta(meta: dict | None) -> dict:
    """Drop internal/plumbing keys so only meaningful source fields reach the agent."""
    if not meta:
        return {}
    return {k: v for k, v in meta.items() if k.lower() not in _META_HIDDEN}
