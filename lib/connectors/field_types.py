from __future__ import annotations
from dataclasses import dataclass


@dataclass
class SelectValue:
    label: str
    id: str | None = None


@dataclass
class LinkedRecord:
    source_id: str
    display_name: str | None = None


@dataclass
class UserValue:
    source_id: str
    display_name: str
    email: str | None = None
    avatar_url: str | None = None


@dataclass
class AttachmentValue:
    url: str
    filename: str
    mimetype: str | None = None
    size_bytes: int | None = None


def to_json(value: object) -> object:
    """Recursively convert canonical types to JSON-safe dicts, dropping None fields."""
    if isinstance(value, list):
        return [to_json(v) for v in value]
    if hasattr(value, "__dataclass_fields__"):
        return {k: v for k, v in value.__dict__.items() if v is not None}
    return value
