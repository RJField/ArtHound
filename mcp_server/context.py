"""Per-request agent context for MCP tools.

current_principal() reconstructs the AgentPrincipal the verifier stashed in the access-token claims;
authorize() enforces the credential's app-layer scopes (read vs write, tool allowlist) — RLS already
enforces the ORG boundary, this narrows WITHIN it. run_as() is the canonical wrapper a tool uses to
run its DB work as the agent's RLS-scoped identity.
"""
import logging
from contextlib import asynccontextmanager

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.fastmcp.exceptions import ToolError

from lib.agent_auth import AgentPrincipal, agent_identity, log_tool_event
from mcp_server.ratelimit import allow as _rate_allow

log = logging.getLogger(__name__)


def current_principal() -> AgentPrincipal:
    at = get_access_token()
    if at is None or not at.claims:
        # Should be unreachable: the SDK rejects unauthenticated requests before a tool runs.
        raise ToolError("unauthenticated")
    c = at.claims
    return AgentPrincipal(
        credential_id=c["credential_id"],
        owner_type=c["owner_type"],
        owner_id=c["owner_id"],
        principal_user_id=c["principal_user_id"],
        label=c.get("label", ""),
        scopes=c.get("scopes") or {"mode": "read", "tools": ["*"]},
    )


def _tool_allowed(principal: AgentPrincipal, tool_name: str) -> bool:
    tools = (principal.scopes or {}).get("tools", ["*"])
    return "*" in tools or tool_name in tools


async def authorize(principal: AgentPrincipal, tool_name: str, *, write: bool = False) -> None:
    """Enforce the credential's app-layer scope; raise ToolError (and audit a 'denied' event) if not."""
    mode = (principal.scopes or {}).get("mode", "read")
    if write and mode != "write":
        await log_tool_event(principal, "denied", tool_name, {"reason": "read-only credential"})
        raise ToolError("this credential is read-only; a write-scoped key is required")
    if not _tool_allowed(principal, tool_name):
        await log_tool_event(principal, "denied", tool_name, {"reason": "tool not in allowlist"})
        raise ToolError(f"tool '{tool_name}' is not permitted for this credential")


@asynccontextmanager
async def run_as(principal: AgentPrincipal):
    """Bind the agent's RLS-scoped DB identity for the enclosing block (delegates to agent_identity)."""
    async with agent_identity(principal):
        yield


@asynccontextmanager
async def tool_call(tool_name: str, *, write: bool = False):
    """One-stop entry for a tool body: resolve the principal, enforce its scope, audit the call, and
    bind its RLS identity. Yields the AgentPrincipal. Usage:

        async with tool_call("paw_v1_get_asset") as p:
            ... db reads scoped to p.owner_type / p.owner_id ...
    """
    principal = current_principal()
    await authorize(principal, tool_name, write=write)
    if not _rate_allow(principal.credential_id):
        await log_tool_event(principal, "denied", tool_name, {"reason": "rate_limited"})
        raise ToolError("rate limit exceeded — slow down and retry shortly")
    await log_tool_event(principal, "tool_call", tool_name)
    async with run_as(principal):
        yield principal
