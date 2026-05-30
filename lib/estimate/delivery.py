"""
Estimate-share delivery strategies (vendor-estimate-share plan §2.4).

Delivery is a pluggable strategy so the snapshot/series/log core never has to be reshaped when a new
channel is added. v1 ships only `route_inbox`: the dispatch row IS the delivery — the recipient studio
reads it through the authenticated, route-scoped inbox endpoint (the route-layer owner filter is the
isolation boundary; RLS is defense-in-depth). There is nothing to push.

The reserved future strategy is `token` (external / non-ArtHound recipients, DocuSign-style), which
will add its own delivery-specific fields (e.g. token_hash) without touching this core. Not built now.
"""
from typing import Protocol


class DeliveryStrategy(Protocol):
    mode: str

    async def deliver(self, dispatch: dict) -> None:
        ...


class RouteInboxDelivery:
    """The dispatch row + RLS-scoped inbox read is the delivery — no external push."""
    mode = "route_inbox"

    async def deliver(self, dispatch: dict) -> None:
        return None


_STRATEGIES: dict[str, DeliveryStrategy] = {
    RouteInboxDelivery.mode: RouteInboxDelivery(),
}


def get_delivery_strategy(mode: str = "route_inbox") -> DeliveryStrategy:
    strategy = _STRATEGIES.get(mode)
    if strategy is None:
        raise ValueError(f"Unknown delivery mode: {mode!r}")
    return strategy
