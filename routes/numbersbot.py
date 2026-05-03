import os
from collections import Counter

import anthropic
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user
from lib.db import db_client, _url, _headers

router = APIRouter()

_SLOTS = "name,dev_name,item_type,priority,product,project_date,status,asset_number"

# Meta keys whose values are worth surfacing to NumberBot (milestone/date lookups, team).
# Bare record-ID arrays are already excluded by _fmt_meta below.
_META_KEYWORDS = ("milestone", "date", "team", "phase", "due", "target", "delivery")


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]


def _fmt_meta(v) -> str | None:
    """Return a display string for a meta value, or None if not useful."""
    if v is None or v == "" or v == []:
        return None
    if isinstance(v, list):
        if all(isinstance(x, str) and x.startswith("rec") for x in v):
            return None  # bare linked-record IDs
        return ", ".join(str(x) for x in v if x) or None
    return str(v)


async def _build_context(user: CurrentUser) -> str:
    owner_type = user.role
    if owner_type not in ("studio", "vendor"):
        return "Unrecognised account role — cannot load asset data."

    owner_id = user.studio_id if owner_type == "studio" else user.vendor_id
    if not owner_id:
        return "No studio or vendor linked to this account — cannot load asset data."

    asset_r, fm_r, tasks_r = await _parallel_fetch(owner_type, owner_id)

    raw_assets = asset_r.json() if asset_r.is_success else []
    fm_rows    = fm_r.json() if fm_r.is_success else []
    mappings   = (fm_rows[0].get("mappings") or []) if fm_rows else []
    tasks      = tasks_r.json() if tasks_r and tasks_r.is_success else []

    # Hard ownership assertion — discard any row that doesn't belong to this user.
    assets = [
        a for a in raw_assets
        if a.get("owner_type") == owner_type and a.get("owner_id") == owner_id
    ]

    if not assets:
        return "No assets have been synced yet. Run a sync from Settings first."

    products   = Counter(a.get("product") or "—" for a in assets)
    item_types = Counter(a.get("item_type") or "—" for a in assets)
    statuses   = Counter(a.get("status") or "—" for a in assets)

    owner_label = "STUDIO" if owner_type == "studio" else "VENDOR"
    lines = [
        f"{owner_label} ASSET INVENTORY: {len(assets)} total assets",
        "",
        "BREAKDOWN BY PRODUCT:",
        *[f"  {p}: {c}" for p, c in products.most_common()],
        "",
        "BREAKDOWN BY ITEM TYPE:",
        *[f"  {t}: {c}" for t, c in item_types.most_common()],
        "",
        "BREAKDOWN BY STATUS:",
        *[f"  {s}: {c}" for s, c in statuses.most_common()],
        "",
        "FIELD MAPPING (source field → ArtHound slot or meta):",
        *[f"  {m['source_field_name']} → {m.get('arthound_slot') or 'meta'}" for m in mappings],
        "",
        "ASSET LIST — columns: name | product | item_type | status | priority | project_date | asset# | [extra meta]",
    ]

    for a in assets:
        row = " | ".join(
            str(a.get(col) if a.get(col) is not None else "—")
            for col in ("name", "product", "item_type", "status", "priority", "project_date", "asset_number")
        )
        meta = a.get("meta") or {}
        extras = []
        for k, v in meta.items():
            if any(kw in k.lower() for kw in _META_KEYWORDS):
                display = _fmt_meta(v)
                if display:
                    extras.append(f"{k}: {display}")
        if extras:
            row += " | " + "; ".join(extras)
        lines.append(row)

    if tasks:
        crafts      = Counter(t.get("craft") or "—" for t in tasks)
        src_types   = Counter(t.get("source_type") or "—" for t in tasks)
        lines += [
            "",
            f"GENERATED TASKS — {len(tasks)} active tasks",
            "",
            "BREAKDOWN BY CRAFT:",
            *[f"  {c}: {n}" for c, n in crafts.most_common()],
            "",
            "BREAKDOWN BY SOURCE TYPE:",
            *[f"  {s}: {n}" for s, n in src_types.most_common()],
            "",
            "TASK LIST — columns: task_name | craft | estimate_days | start_date | end_date | generated_at | variable_values",
        ]
        for t in tasks:
            vars_display = str(t.get("variable_values") or "—")
            lines.append(
                " | ".join([
                    str(t.get("task_name") or "—"),
                    str(t.get("craft") or "—"),
                    str(t.get("estimate_days") if t.get("estimate_days") is not None else "—"),
                    str(t.get("start_date") or "—"),
                    str(t.get("end_date") or "—"),
                    str(t.get("generated_at") or "—"),
                    vars_display,
                ])
            )

    return "\n".join(lines)


async def _parallel_fetch(owner_type: str, owner_id: str):
    import asyncio

    params_base = {
        "owner_type":  f"eq.{owner_type}",
        "owner_id":    f"eq.{owner_id}",
        "source_type": "eq.airtable",
    }

    coros = [
        db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={**params_base, "select": f"owner_type,owner_id,{_SLOTS},meta", "order": "product.asc,name.asc"},
            headers=_headers({"Range": "0-999"}),
        ),
        db_client.get(
            _url("/rest/v1/source_field_mappings"),
            params={**params_base, "select": "mappings"},
            headers=_headers(),
        ),
    ]

    if owner_type == "studio":
        coros.append(
            db_client.get(
                _url("/rest/v1/generated_tasks"),
                params={
                    "studio_id":  f"eq.{owner_id}",
                    "deleted_at": "is.null",
                    "select":     "task_name,craft,estimate_days,start_date,end_date,generated_at,variable_values,source_type",
                    "order":      "generated_at.desc",
                },
                headers=_headers({"Range": "0-999"}),
            )
        )

    results = await asyncio.gather(*coros)
    return results[0], results[1], results[2] if owner_type == "studio" else None


@router.post("/chat")
async def chat(body: ChatRequest, user: CurrentUser = Depends(get_current_user)):
    context = await _build_context(user)

    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    owner_description = "studio" if user.role == "studio" else "vendor"
    response = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": (
                    "You are NumberBot, a production intelligence assistant built into ArtHound — "
                    "an asset management platform for production studios.\n\n"
                    f"You have direct access to this {owner_description}'s live asset data from the ArtHound database. "
                    "Answer questions about assets, products, priorities, statuses, milestone dates, and schedules "
                    "concisely and accurately. You can count, filter, aggregate, and reason about the data. "
                    "If a question requires information not in the data (e.g. detailed task breakdowns), "
                    "say what you can and note what's missing.\n\n"
                    f"{context}"
                ),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": m.role, "content": m.content} for m in body.messages],
    )

    return {"answer": response.content[0].text}
