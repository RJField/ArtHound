"""MCP boundary auth — bridges the MCP SDK's resource-server auth to the Phase-0 agent identity.

FastMCP (resource-server mode) requires a Bearer token on every request and calls
AgentTokenVerifier.verify_token with it. We resolve the token as an ArtHound agent API key
(lib.agent_auth.resolve_credential) and, on success, hand the SDK an AccessToken whose `claims`
carry the full AgentPrincipal. Tools read it back via mcp_server.context.current_principal().

The raw API key IS the bearer token here — there is no OAuth dance. The SDK's protected-resource
metadata endpoint is emitted for spec-compliance but our key-based clients ignore it.
"""
import logging

from mcp.server.auth.provider import TokenVerifier, AccessToken

from lib.agent_auth import resolve_credential

log = logging.getLogger(__name__)


class AgentTokenVerifier(TokenVerifier):
    async def verify_token(self, token: str) -> AccessToken | None:
        principal = await resolve_credential(token)
        if principal is None:
            return None
        mode = (principal.scopes or {}).get("mode", "read")
        tools = (principal.scopes or {}).get("tools", ["*"])
        return AccessToken(
            token=token,
            client_id=principal.credential_id,
            subject=principal.principal_user_id,
            scopes=[f"mode:{mode}", *[f"tool:{t}" for t in tools]],
            claims={
                "credential_id": principal.credential_id,
                "owner_type": principal.owner_type,
                "owner_id": principal.owner_id,
                "principal_user_id": principal.principal_user_id,
                "label": principal.label,
                "scopes": principal.scopes,
            },
        )
