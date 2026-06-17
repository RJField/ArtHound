"""FastMCP server construction (docs/plans/mcp-server.md §1).

Resource-server mode: the agent's ArtHound API key IS the bearer token; AgentTokenVerifier resolves
it and FastMCP enforces auth on the streamable-HTTP transport. Stateless HTTP + JSON responses keep it
a plain request/response surface suitable for mounting inside the FastAPI app at /mcp.
"""
import os

from pydantic import AnyHttpUrl
from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.server import AuthSettings

from mcp_server.auth import AgentTokenVerifier
from mcp_server.tools import register_all

_INSTRUCTIONS = (
    "ArtHound is the canonical production-data layer for a game/film studio or vendor, organized as "
    "PAW: Product → Asset → Work. The Asset is the central, stable identity everything anchors to. "
    "All data you can see is automatically scoped to your organization. Start from list_products or "
    "list_assets to discover the data, then get_asset for the rich record. This surface is read-only "
    "(v1); write tools (work submission, risk flags, estimate-adjustment proposals) arrive in a later "
    "version. Tool names are versioned paw_v1_*."
)


def build_mcp() -> FastMCP:
    base = (os.environ.get("MCP_PUBLIC_URL") or os.environ.get("FRONTEND_URL")
            or "http://localhost:8000").rstrip("/")
    mcp = FastMCP(
        "ArtHound",
        instructions=_INSTRUCTIONS,
        token_verifier=AgentTokenVerifier(),
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(base),
            resource_server_url=AnyHttpUrl(f"{base}/mcp"),
            required_scopes=[],          # per-tool scope is enforced in mcp_server.context.authorize
        ),
        stateless_http=True,
        json_response=True,
        streamable_http_path="/",        # mounted at /mcp → endpoint is /mcp
    )
    register_all(mcp)
    return mcp
