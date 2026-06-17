"""Per-credential rate limiting for MCP tool calls (docs/plans/mcp-server.md Phase 5).

An in-process token bucket keyed on the agent credential id — the first line of defense against a
compromised or runaway agent hammering the data plane (the broader data-plane rate-limiting gap is a
known hardening item). PER-PROCESS by design: on a multi-worker deploy each worker keeps its own
bucket, so the effective ceiling is limit × workers; a shared (Redis) limiter is the future upgrade,
tracked with the account-system rate-limiter TODO. Tunable via env; set MCP_RATE_LIMIT_PER_MIN=0 to
disable (e.g. in tests).
"""
import os
import time

_PER_MIN = float(os.environ.get("MCP_RATE_LIMIT_PER_MIN", "120"))  # sustained refill rate
_BURST   = float(os.environ.get("MCP_RATE_LIMIT_BURST", "30"))     # bucket capacity (burst allowance)
_REFILL_PER_SEC = _PER_MIN / 60.0

# key -> (tokens, last_monotonic). Module-level; a race only mis-meters by a token, harmlessly.
_buckets: dict[str, tuple[float, float]] = {}


def allow(key: str) -> bool:
    """Consume one token for `key`; return False if the bucket is empty (caller rejects the call)."""
    if _PER_MIN <= 0:
        return True
    now = time.monotonic()
    tokens, last = _buckets.get(key, (_BURST, now))
    tokens = min(_BURST, tokens + (now - last) * _REFILL_PER_SEC)
    if tokens < 1.0:
        _buckets[key] = (tokens, now)
        return False
    _buckets[key] = (tokens - 1.0, now)
    return True
