"""ArtHound MCP server (docs/plans/mcp-server.md).

Exposes ArtHound's canonical production data to external agents over the Model Context Protocol,
scoped under RLS via the Phase-0 agent identity (lib/agent_auth.py). Mounted as an ASGI sub-app at
/mcp in the FastAPI process (see main.py).
"""
from mcp_server.server import build_mcp

__all__ = ["build_mcp"]
