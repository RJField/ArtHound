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

_REVIEW_DESC_MAX = 200


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

    asset_r, fm_r, tasks_r, reviews_r = await _parallel_fetch(owner_type, owner_id)

    raw_assets  = asset_r.json() if asset_r.is_success else []
    fm_rows     = fm_r.json() if fm_r.is_success else []
    first_fm    = fm_rows[0] if fm_rows else {}
    mappings    = first_fm.get("mappings") or []
    source_type = first_fm.get("source_type") or "unknown"
    tasks       = tasks_r.json() if tasks_r and tasks_r.is_success else []
    reviews     = reviews_r.json() if reviews_r and reviews_r.is_success else []

    # Hard ownership assertion — discard any row that doesn't belong to this user.
    assets = [
        a for a in raw_assets
        if a.get("owner_type") == owner_type and a.get("owner_id") == owner_id
    ]

    # Hard studio scope assertion on reviews — belt-and-suspenders over service role fetch.
    if owner_type == "studio":
        reviews = [r for r in reviews if r.get("studio_id") == owner_id]

    if not assets:
        return "No assets have been synced yet. Run a sync from Settings first."

    products   = Counter(a.get("product") or "—" for a in assets)
    item_types = Counter(a.get("item_type") or "—" for a in assets)
    statuses   = Counter(a.get("status") or "—" for a in assets)

    owner_label = "STUDIO" if owner_type == "studio" else "VENDOR"
    lines = [
        f"{owner_label} ASSET INVENTORY: {len(assets)} total assets (source: {source_type})",
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

    asset_name_by_canonical_id: dict[str, str] = {}
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
        if cid := a.get("canonical_asset_id"):
            asset_name_by_canonical_id[cid] = a.get("name") or "—"

    if tasks:
        crafts      = Counter(t.get("craft") or "—" for t in tasks)
        src_types   = Counter(t.get("source_type") or "—" for t in tasks)
        lines += [
            "",
            f"GENERATED WORK — {len(tasks)} active work items",
            "",
            "BREAKDOWN BY CRAFT:",
            *[f"  {c}: {n}" for c, n in crafts.most_common()],
            "",
            "BREAKDOWN BY SOURCE TYPE:",
            *[f"  {s}: {n}" for s, n in src_types.most_common()],
            "",
            "WORK LIST — columns: work_name | craft | estimate_days | start_date | end_date | generated_at | variable_values",
        ]
        for t in tasks:
            vars_display = str(t.get("variable_values") or "—")
            lines.append(
                " | ".join([
                    str(t.get("work_name") or "—"),
                    str(t.get("craft") or "—"),
                    str(t.get("estimate_days") if t.get("estimate_days") is not None else "—"),
                    str(t.get("start_date") or "—"),
                    str(t.get("end_date") or "—"),
                    str(t.get("generated_at") or "—"),
                    vars_display,
                ])
            )

    if reviews:
        review_statuses = Counter(r.get("status") or "—" for r in reviews)
        lines += [
            "",
            f"ASSET REVIEWS — {len(reviews)} total",
            "",
            "BREAKDOWN BY STATUS:",
            *[f"  {s}: {c}" for s, c in review_statuses.most_common()],
            "",
            "REVIEW LIST — columns: asset_name | status | description | created_at | reviewer",
        ]
        for r in reviews:
            asset_name = asset_name_by_canonical_id.get(r.get("canonical_asset_id") or "", "unknown asset")
            desc = r.get("description") or "—"
            if len(desc) > _REVIEW_DESC_MAX:
                desc = desc[:_REVIEW_DESC_MAX] + "…"
            lines.append(
                " | ".join([
                    asset_name,
                    str(r.get("status") or "—"),
                    desc,
                    str(r.get("created_at") or "—"),
                    str(r.get("created_by_email") or "—"),
                ])
            )

    return "\n".join(lines)


async def _parallel_fetch(owner_type: str, owner_id: str):
    import asyncio

    params_base = {
        "owner_type": f"eq.{owner_type}",
        "owner_id":   f"eq.{owner_id}",
    }

    coros = [
        db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={**params_base, "select": f"owner_type,owner_id,canonical_asset_id,{_SLOTS},meta", "order": "product.asc,name.asc"},
            headers=_headers({"Range": "0-999"}),
        ),
        db_client.get(
            _url("/rest/v1/source_field_mappings"),
            params={**params_base, "select": "mappings,source_type", "limit": "1"},
            headers=_headers(),
        ),
    ]

    if owner_type == "studio":
        coros.append(
            db_client.get(
                _url("/rest/v1/generated_work"),
                params={
                    "studio_id":  f"eq.{owner_id}",
                    "deleted_at": "is.null",
                    "select":     "work_name,craft,estimate_days,start_date,end_date,generated_at,variable_values,source_type",
                    "order":      "generated_at.desc",
                },
                headers=_headers({"Range": "0-999"}),
            )
        )
        coros.append(
            db_client.get(
                _url("/rest/v1/asset_reviews"),
                params={
                    "studio_id": f"eq.{owner_id}",
                    "select":    "studio_id,canonical_asset_id,status,description,created_at,created_by_email",
                    "order":     "created_at.desc",
                },
                headers=_headers({"Range": "0-499"}),
            )
        )

    results = await asyncio.gather(*coros)
    if owner_type == "studio":
        return results[0], results[1], results[2], results[3]
    return results[0], results[1], None, None


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
                    "You are NumberBot, a production data assistant built into ArtHound — "
                    "an asset management platform for game production studios.\n\n"
                    f"You have access to this {owner_description}'s live data from the ArtHound database. "
                    "Your job is to answer questions about that data: assets, products, item types, statuses, "
                    "priorities, project dates, field mappings, generated work schedules, and asset reviews.\n\n"
                    "STRICT SCOPE RULES:\n"
                    "- Only answer questions about the data provided below. Do not answer general knowledge "
                    "questions, give opinions, write creative content, or discuss anything outside of this "
                    f"{owner_description}'s production data.\n"
                    "- If a question is outside this scope, respond with exactly: "
                    "\"I can only answer questions about your production data in ArtHound.\"\n"
                    "- If a question is within scope but the required data is not present below, say what you "
                    "can observe and clearly state what information is missing.\n"
                    "- Never fabricate data, infer records that aren't listed, or speculate beyond what the "
                    "data directly supports.\n\n"
                    f"{context}"
                ),
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": m.role, "content": m.content} for m in body.messages],
    )

    return {"answer": response.content[0].text}
