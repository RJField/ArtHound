# `mcp_server/`

The ArtHound MCP server — exposes canonical production data (PAW) to external AI agents over the Model
Context Protocol, mounted at `/mcp` in `main.py` (FastMCP, Streamable HTTP), scoped per-org under RLS.

**Canonical documentation lives in [`docs/mcp.md`](../docs/mcp.md)** — connecting, identity & scoping
(model A1), key management (`scripts/agent_keys.py`), rate limiting, errors, the full `paw_v1_*` tool
catalog, UI surfacing, and versioning. Design + phase history: [`docs/plans/mcp-server.md`](../docs/plans/mcp-server.md).

## Layout
- `server.py` — FastMCP construction (resource-server mode) + `build_mcp()`.
- `auth.py` — `AgentTokenVerifier` (API key → `lib/agent_auth.resolve_credential`).
- `context.py` — `tool_call` (scope enforcement + rate limit + audit + agent-identity binding).
- `shaping.py` — slot reads + `_META_HIDDEN` cleaner.
- `ratelimit.py` — per-credential token bucket.
- `tools/` — the tool implementations (`products`, `assets`, `work`, `estimates`, `schedule`,
  `timeline`, `writes`), registered with versioned names in `tools/__init__.py`.
