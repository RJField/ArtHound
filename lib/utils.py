from typing import Any, Optional


def resolve_name(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        first = value[0] if value else None
        if not first:
            return None
        if isinstance(first, str):
            return first
        return first.get("name") or first.get("id") or None
    if isinstance(value, dict):
        return value.get("name")
    return None


def link_id(v: Any) -> Optional[str]:
    if not v:
        return None
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        return v.get("id")
    return None
