import json
import logging
import os
import re
from typing import Literal, Optional

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers
from lib.scenario.context import build_scoping_prompt, build_discussion_prompt

# Matches "SCENARIO_ACTION: {...}" at any point in the text.
_ACTION_RE = re.compile(r'SCENARIO_ACTION:\s*(\{.*)', re.DOTALL)

log = logging.getLogger(__name__)
router = APIRouter()

_FORCE_SCOPE_TURN = 8   # Force submit_scope tool call at this turn count.
_ESCAPE_TURN      = 5   # Frontend shows "generate with what I have" after this turn.

_SUBMIT_SCOPE_TOOL = {
    "name": "submit_scope",
    "description": (
        "Call this when you have gathered enough information to generate the scenario. "
        "Required: scenario_category, release_cadence, num_products, distribution, scale. "
        "For target_date category also require target_date. "
        "horizon_months is optional — derived from target_date when not supplied."
    ),
    "input_schema": {
        "type": "object",
        "required": ["scenario_category", "release_cadence", "num_products", "distribution", "scale"],
        "properties": {
            "scenario_category": {
                "type": "string",
                "enum": ["earliest_ship", "target_date"],
                "description": (
                    "earliest_ship: schedule forward from today, derive the earliest completion date. "
                    "target_date: schedule backwards from a user-given target date."
                ),
            },
            "target_date": {
                "type": "string",
                "description": (
                    "Required for target_date category. The desired ship date for the final product "
                    "in YYYY-MM-DD format."
                ),
            },
            "horizon_months": {
                "type": "integer",
                "description": (
                    "Planning horizon in months. Optional for target_date (derived from target_date). "
                    "Omit for earliest_ship — the engine computes the horizon from the work itself."
                ),
            },
            "release_cadence": {
                "type": "string",
                "enum": ["single_launch", "regular_releases", "milestone_batched"],
                "description": "How content ships: one launch, regular cadence, or milestone gates",
            },
            "num_products": {
                "type": "integer",
                "description": "Exact number of products/releases to generate",
            },
            "distribution": {
                "type": "string",
                "enum": ["even", "front_loaded", "back_loaded", "milestone_batched"],
                "description": "How assets are spread across products",
            },
            "scale": {
                "type": "object",
                "description": (
                    "Exact asset count per classification profile. "
                    "Keys must use the exact profile labels shown in the matrix "
                    "(e.g. 'Hero | High'). Values are exact integer counts."
                ),
            },
            "constraints": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional hard constraints e.g. 'no character work before March'",
            },
            "craft_caps": {
                "type": "object",
                "description": (
                    "Optional per-craft concurrent-asset caps. "
                    "Keys are craft names (e.g. '2D', '3D'); "
                    "values are max simultaneous assets for that craft."
                ),
            },
        },
    },
}


_DISCUSSION_TOOLS = [
    {
        "name": "get_craft_overrun_assets",
        "description": (
            "Returns the assets whose work overlaps the above-cap periods for a given craft. "
            "Use this when asked which assets are causing a craft to exceed its concurrency cap."
        ),
        "input_schema": {
            "type": "object",
            "required": ["craft"],
            "properties": {
                "craft": {
                    "type": "string",
                    "description": "Craft name to investigate (e.g. 'Animation', 'VFX', '2D', '3D').",
                },
            },
        },
    },
    {
        "name": "list_assets_in_product",
        "description": (
            "Returns the full asset roster for a named product — asset names, profiles, "
            "and priorities. Use this when you need to know which assets are in a specific "
            "product before drilling into individual schedules."
        ),
        "input_schema": {
            "type": "object",
            "required": ["product_name"],
            "properties": {
                "product_name": {
                    "type": "string",
                    "description": "Product name to look up. Case-insensitive, partial match accepted.",
                },
            },
        },
    },
    {
        "name": "get_asset_schedule",
        "description": (
            "Returns the full step-by-step work schedule for a single named asset — "
            "step names, craft, start/end dates, and estimate_days. Use this when you "
            "need specific dates or durations for one asset."
        ),
        "input_schema": {
            "type": "object",
            "required": ["asset_name"],
            "properties": {
                "asset_name": {
                    "type": "string",
                    "description": "Asset name to look up. Case-insensitive, partial match accepted.",
                },
            },
        },
    },
]


class StartBody(BaseModel):
    mode:              Literal["ai", "rule_based"]             = "ai"
    scenario_category: Literal["earliest_ship", "target_date"] = "target_date"


class GenerateBody(BaseModel):
    mode:  Literal["ai", "rule_based"] = "rule_based"
    scope: dict


class MessageBody(BaseModel):
    content: str


# ── POST /api/scenario/start ──────────────────────────────────────────────────

@router.post("/start")
async def start_scenario(body: StartBody = StartBody(), user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id
    mode     = body.mode
    category = body.scenario_category

    # Gate: estimate_matrix must exist for this studio.
    matrix_r = await db_client.get(
        _url("/rest/v1/estimate_matrix"),
        params={"studio_id": f"eq.{studio_id}", "select": "id", "limit": "1"},
        headers=_headers(),
    )
    if not matrix_r.is_success or not matrix_r.json():
        raise HTTPException(
            status_code=422,
            detail="Scenario planning requires an estimation matrix. Set one up in Estimates first.",
        )

    # Return existing active session if one exists.
    existing_r = await db_client.get(
        _url("/rest/v1/scenario_sessions"),
        params={
            "studio_id": f"eq.{studio_id}",
            "user_id":   f"eq.{user.id}",
            "status":    "eq.active",
            "select":    "id,ai_stage,message_count,scope_json,generation_mode",
            "limit":     "1",
        },
        headers=_headers(),
    )
    if existing_r.is_success and existing_r.json():
        row = existing_r.json()[0]
        existing_scope = row.get("scope_json") or {}
        return {
            "session_id":        row["id"],
            "ai_stage":          row["ai_stage"],
            "message_count":     row["message_count"],
            "generation_mode":   row.get("generation_mode", "ai"),
            "scenario_category": existing_scope.get("scenario_category", "target_date"),
            "resumed":           True,
        }

    # Create new session — pre-seed scope_json with the chosen category so the
    # scoping agent prompt can be tailored to it from the first turn.
    create_r = await db_client.post(
        _url("/rest/v1/scenario_sessions"),
        json={
            "studio_id":       studio_id,
            "user_id":         user.id,
            "generation_mode": mode,
            "scope_json":      {"scenario_category": category},
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not create_r.is_success:
        raise HTTPException(status_code=500, detail=f"Failed to create session: {create_r.text}")

    session = create_r.json()[0]
    return {
        "session_id":        session["id"],
        "ai_stage":          session["ai_stage"],
        "message_count":     session["message_count"],
        "generation_mode":   session.get("generation_mode", "ai"),
        "scenario_category": category,
        "resumed":           False,
    }


# ── GET /api/scenario/wizard-data ────────────────────────────────────────────

@router.get("/wizard-data")
async def get_wizard_data(user: CurrentUser = Depends(require_studio)):
    """
    Returns the studio's classification profiles and crafts for the wizard form.
    profiles: display labels in matrix order, e.g. ["Hero | High", "Support | Low"]
    crafts:   distinct craft names from workflow_steps
    """
    import asyncio
    cfg_r, matrix_r, steps_r = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/estimate_config"),
            params={"studio_id": f"eq.{user.studio_id}", "select": "variable_fields"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/estimate_matrix"),
            params={
                "studio_id": f"eq.{user.studio_id}",
                "select":    "variable_values,estimate_days",
                "limit":     "10000",
            },
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/workflow_steps"),
            params={"studio_id": f"eq.{user.studio_id}", "select": "craft"},
            headers=_headers(),
        ),
    )

    cfg_rows       = cfg_r.json()    if cfg_r.is_success    else []
    matrix_rows    = matrix_r.json() if matrix_r.is_success else []
    step_rows      = steps_r.json()  if steps_r.is_success  else []

    variable_fields: list[str] = cfg_rows[0]["variable_fields"] if cfg_rows else []

    # Build ordered, unique profile labels (only profiles with at least one estimate > 0).
    from lib.scenario.context import _combo_key
    seen: dict[str, str] = {}  # combo_key → display_label, insertion order
    for row in matrix_rows:
        if (row.get("estimate_days") or 0) <= 0:
            continue
        vv  = row["variable_values"] or {}
        ck  = _combo_key(vv, variable_fields)
        if ck not in seen:
            label = ck.replace("|", " | ") if ck != "__default__" else "Default"
            seen[ck] = label

    crafts = sorted({r["craft"] for r in step_rows if r.get("craft")})

    return {"profiles": list(seen.values()), "crafts": crafts}


# ── POST /api/scenario/generate ───────────────────────────────────────────────

@router.post("/generate")
async def generate_scenario(body: GenerateBody, user: CurrentUser = Depends(require_studio)):
    """
    Wizard submit endpoint. Accepts a fully-formed scope and immediately queues
    generation — no scoping chat. The generation loop picks it up within 30s.
    Any existing active session for this user is dismissed first.
    """
    studio_id = user.studio_id

    # Gate: estimate_matrix must exist.
    matrix_r = await db_client.get(
        _url("/rest/v1/estimate_matrix"),
        params={"studio_id": f"eq.{studio_id}", "select": "id", "limit": "1"},
        headers=_headers(),
    )
    if not matrix_r.is_success or not matrix_r.json():
        raise HTTPException(
            status_code=422,
            detail="Scenario planning requires an estimation matrix. Set one up in Estimates first.",
        )

    # Dismiss any existing active session for this user.
    await db_client.patch(
        _url("/rest/v1/scenario_sessions"),
        params={"studio_id": f"eq.{studio_id}", "user_id": f"eq.{user.id}", "status": "eq.active"},
        json={"status": "dismissed"},
        headers=_headers({"Prefer": "return=minimal"}),
    )

    # Create session already in pending_generation — the generation loop picks it up.
    create_r = await db_client.post(
        _url("/rest/v1/scenario_sessions"),
        json={
            "studio_id":       studio_id,
            "user_id":         user.id,
            "generation_mode": body.mode,
            "scope_json":      body.scope,
            "ai_stage":        "pending_generation",
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not create_r.is_success:
        raise HTTPException(status_code=500, detail=f"Failed to create session: {create_r.text}")

    session = create_r.json()[0]
    return {
        "session_id": session["id"],
        "ai_stage":   session["ai_stage"],
    }


# ── POST /api/scenario/{session_id}/message ───────────────────────────────────

@router.post("/{session_id}/message")
async def send_message(
    session_id: str,
    body: MessageBody,
    user: CurrentUser = Depends(require_studio),
):
    session = await _get_session(session_id, user.studio_id)
    stage = session["ai_stage"]

    # Block message input during generation stages — return stage in body.
    if stage in ("pending_generation", "generating", "generation_failed"):
        raise HTTPException(
            status_code=409,
            detail={"message": "Cannot send message in current stage", "ai_stage": stage},
        )

    # Persist user message.
    await _append_message(session_id, user.studio_id, "user", body.content)
    message_count = session["message_count"] + 1
    await _update_session(session_id, {"message_count": message_count})

    # Load conversation history.
    history = await _load_messages(session_id)

    try:
        if stage == "scoping":
            return await _handle_scoping(session_id, user.studio_id, history, message_count, session)

        if stage == "discussion":
            return await _handle_discussion(session_id, user.studio_id, history)
    except anthropic.APIStatusError as exc:
        if exc.status_code in (429, 529):
            raise HTTPException(
                status_code=503,
                detail="The AI is temporarily overloaded — please try again in a moment.",
            )
        raise

    raise HTTPException(status_code=409, detail={"message": "Unexpected stage", "ai_stage": stage})


async def _handle_scoping(session_id: str, studio_id: str, history: list, message_count: int, session: dict) -> dict:
    category = (session.get("scope_json") or {}).get("scenario_category", "target_date")
    system_prompt = await build_scoping_prompt(studio_id, category)
    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    # Force submit_scope at turn limit.
    tool_choice = (
        {"type": "tool", "name": "submit_scope"}
        if message_count >= _FORCE_SCOPE_TURN
        else {"type": "auto"}
    )

    response = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        tools=[_SUBMIT_SCOPE_TOOL],
        tool_choice=tool_choice,
        messages=history,
    )

    # Check for tool call.
    tool_use_block = next((b for b in response.content if b.type == "tool_use"), None)
    text_block = next((b for b in response.content if b.type == "text"), None)
    assistant_text = text_block.text if text_block else "I have enough information to generate your scenario now."

    if tool_use_block:
        scope = dict(tool_use_block.input)
        # Guarantee scenario_category is always in scope even if AI omitted it.
        scope.setdefault("scenario_category", category)
        await _update_session(session_id, {
            "ai_stage":  "pending_generation",
            "scope_json": scope,
        })
        await _append_message(session_id, studio_id, "assistant", assistant_text)
        return {
            "message":    assistant_text,
            "ai_stage":   "pending_generation",
            "generating": True,
            "show_escape": False,
        }

    await _append_message(session_id, studio_id, "assistant", assistant_text)
    return {
        "message":    assistant_text,
        "ai_stage":   "scoping",
        "generating": False,
        "show_escape": message_count >= _ESCAPE_TURN,
    }


async def _execute_discussion_tool(name: str, tool_input: dict, session_id: str) -> str:
    if name == "get_craft_overrun_assets":
        from lib.db import drain_pages
        from datetime import date as _date, timedelta as _td
        from collections import defaultdict

        craft_filter = (tool_input.get("craft") or "").strip()
        if not craft_filter:
            return "Please specify a craft name."

        # Fetch all work for this session scoped to the requested craft.
        work_r = await db_client.get(
            _url("/rest/v1/scenario_work"),
            params={
                "session_id": f"eq.{session_id}",
                "craft":      f"eq.{craft_filter}",
                "select":     "asset_id,step_name,start_date,end_date,estimate_days",
            },
            headers=_headers(),
        )
        work = work_r.json() if work_r.is_success else []
        if not work:
            return f"No work items found for craft '{craft_filter}' in this scenario."

        # Sweep-line: find above-cap periods and the assets active during them.
        # Build a sorted event list then walk it to find days when count > cap.
        # We don't store cap here so we derive peak and flag anything > peak-during-normal.
        # Instead: build a day-by-day active set for each asset during the overrun.
        # Simpler: collect all intervals, sweep, find dates with count > peak_normal (approximation).
        # Use session craft_caps from scope if available — fall back to peak-1 as the cap.

        # Fetch scope for cap value.
        sess_r = await db_client.get(
            _url("/rest/v1/scenario_sessions"),
            params={"id": f"eq.{session_id}", "select": "scope_json", "limit": "1"},
            headers=_headers(),
        )
        scope = {}
        if sess_r.is_success and sess_r.json():
            scope = sess_r.json()[0].get("scope_json") or {}
        cap = (scope.get("craft_caps") or {}).get(craft_filter)

        if not cap:
            return (
                f"No cap was set for '{craft_filter}' in this scenario, so no overrun occurred. "
                f"The craft ran uncapped."
            )

        # Build event list: (date, +1 or -1, asset_id)
        events = []
        for w in work:
            try:
                sd = _date.fromisoformat(w["start_date"])
                ed = _date.fromisoformat(w["end_date"])
            except (TypeError, ValueError):
                continue
            events.append((sd, +1, w["asset_id"]))
            events.append((ed + _td(days=1), -1, w["asset_id"]))

        # Secondary sort by delta (-1 before +1) so ends are processed before starts
        # on the same date — prevents transient false overruns at batch boundaries.
        events.sort(key=lambda e: (e[0], e[1]))

        active_assets: set = set()
        overrun_assets: set = set()
        prev_date = None
        running = 0

        for ev_date, delta, asset_id in events:
            if running > cap and prev_date is not None:
                overrun_assets.update(active_assets)
            if delta == +1:
                active_assets.add(asset_id)
                running += 1
            else:
                active_assets.discard(asset_id)
                running -= 1
            prev_date = ev_date

        if not overrun_assets:
            return f"No above-cap overrun detected for '{craft_filter}' (cap={cap})."

        # Resolve asset names.
        assets_r = await db_client.get(
            _url("/rest/v1/scenario_assets"),
            params={"session_id": f"eq.{session_id}", "select": "id,name,variable_values,product_id"},
            headers=_headers(),
        )
        asset_rows = assets_r.json() if assets_r.is_success else []
        asset_by_id = {a["id"]: a for a in asset_rows}

        lines = [
            f"Assets causing '{craft_filter}' to exceed cap={cap}:",
            f"({len(overrun_assets)} assets had overlapping {craft_filter} work during above-cap periods)",
            "",
        ]
        for aid in sorted(overrun_assets, key=lambda i: asset_by_id.get(i, {}).get("name", "")):
            a = asset_by_id.get(aid)
            if not a:
                continue
            vv = a.get("variable_values") or {}
            profile = " | ".join(str(v) for v in vv.values()) if vv else "default"
            lines.append(f"  {a['name']}  [{profile}]")
        return "\n".join(lines)

    if name == "list_assets_in_product":
        product_name = (tool_input.get("product_name") or "").lower()
        products_r = await db_client.get(
            _url("/rest/v1/scenario_products"),
            params={"session_id": f"eq.{session_id}", "select": "id,name,target_release_date",
                    "order": "created_at.asc"},
            headers=_headers(),
        )
        products = products_r.json() if products_r.is_success else []
        match = next((p for p in products if product_name in p["name"].lower()), None)
        if not match:
            return f"No product found matching '{tool_input.get('product_name')}'."

        assets_r = await db_client.get(
            _url("/rest/v1/scenario_assets"),
            params={"session_id": f"eq.{session_id}", "product_id": f"eq.{match['id']}",
                    "select": "name,variable_values,priority", "order": "created_at.asc"},
            headers=_headers(),
        )
        assets = assets_r.json() if assets_r.is_success else []
        if not assets:
            return f"No assets found in product '{match['name']}'."

        lines = [f"Assets in '{match['name']}' (release: {match.get('target_release_date') or '—'}):"]
        for a in assets:
            vv = a.get("variable_values") or {}
            profile = " | ".join(str(v) for v in vv.values()) if vv else "default"
            lines.append(f"  {a['name']}  [{profile}]  priority:{a.get('priority') or '—'}")
        return "\n".join(lines)

    if name == "get_asset_schedule":
        asset_name = (tool_input.get("asset_name") or "").lower()
        assets_r = await db_client.get(
            _url("/rest/v1/scenario_assets"),
            params={"session_id": f"eq.{session_id}",
                    "select": "id,name,variable_values,priority,product_id"},
            headers=_headers(),
        )
        assets = assets_r.json() if assets_r.is_success else []
        match = next((a for a in assets if asset_name in a["name"].lower()), None)
        if not match:
            return f"No asset found matching '{tool_input.get('asset_name')}'."

        product_r = await db_client.get(
            _url("/rest/v1/scenario_products"),
            params={"id": f"eq.{match['product_id']}", "select": "name,target_release_date"},
            headers=_headers(),
        )
        product = (product_r.json() or [{}])[0] if product_r.is_success else {}

        work_r = await db_client.get(
            _url("/rest/v1/scenario_work"),
            params={"asset_id": f"eq.{match['id']}",
                    "select": "step_name,craft,start_date,end_date,estimate_days",
                    "order": "start_date.asc"},
            headers=_headers(),
        )
        work = work_r.json() if work_r.is_success else []

        vv = match.get("variable_values") or {}
        profile = " | ".join(str(v) for v in vv.values()) if vv else "default"
        lines = [
            f"Schedule for '{match['name']}' [{profile}]",
            f"  Product: {product.get('name', '—')}  release:{product.get('target_release_date') or '—'}",
            f"  Priority: {match.get('priority') or '—'}",
            "",
            "  Work items (step | craft | start → end | days):",
        ]
        for w in work:
            est = int(w["estimate_days"]) if w.get("estimate_days") else "?"
            lines.append(
                f"    {w['step_name']} | {w.get('craft') or '—'}"
                f" | {w.get('start_date') or '—'}→{w.get('end_date') or '—'} | {est}d"
            )
        return "\n".join(lines)

    return f"Unknown tool: {name}"


async def _handle_discussion(session_id: str, studio_id: str, history: list) -> dict:
    system_prompt = await build_discussion_prompt(studio_id, session_id)
    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    # Tool loop — Haiku may call multiple tools in a single response; handle all of
    # them together to satisfy the API requirement that every tool_use block has a
    # corresponding tool_result in the immediately following user message.
    # Cap at 5 rounds (each round may execute multiple tools in parallel).
    messages = list(history)
    assistant_text = ""
    action: dict | None = None

    for _ in range(5):
        response = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
            tools=_DISCUSSION_TOOLS,
            messages=messages,
        )

        tool_blocks = [b for b in response.content if b.type == "tool_use"]
        text_block  = next((b for b in response.content if b.type == "text"), None)

        if not tool_blocks:
            assistant_text = text_block.text if text_block else ""
            break

        # Execute all tool calls from this response in parallel.
        import asyncio as _aio
        tool_results = await _aio.gather(*[
            _execute_discussion_tool(tb.name, tb.input, session_id)
            for tb in tool_blocks
        ])

        # Serialize all content blocks (both text and every tool_use) to plain dicts.
        assistant_content = []
        for b in response.content:
            if b.type == "text":
                assistant_content.append({"type": "text", "text": b.text})
            elif b.type == "tool_use":
                assistant_content.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})

        # All tool_results must appear in a single user message immediately after.
        messages = messages + [
            {"role": "assistant", "content": assistant_content},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": tb.id, "content": result}
                for tb, result in zip(tool_blocks, tool_results)
            ]},
        ]

    # If the loop exhausted all iterations on tool calls, force one final text response.
    if not assistant_text:
        fallback_r = await client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
            messages=messages,
        )
        fb_text = next((b for b in fallback_r.content if b.type == "text"), None)
        assistant_text = fb_text.text if fb_text else "I was unable to complete the analysis. Please try asking a more specific question."

    # Extract SCENARIO_ACTION block if Haiku emitted one.
    m = _ACTION_RE.search(assistant_text)
    if m:
        raw = m.group(1).strip()
        depth, end = 0, 0
        for i, ch in enumerate(raw):
            if ch == '{':   depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        try:
            action = json.loads(raw[:end])
        except json.JSONDecodeError:
            action = None
        assistant_text = assistant_text[:m.start()].rstrip()

    await _append_message(session_id, studio_id, "assistant", assistant_text)
    return {
        "message":  assistant_text,
        "ai_stage": "discussion",
        "action":   action,
    }


# ── POST /api/scenario/{session_id}/force-generate ───────────────────────────
# Triggered by the "Generate with what I have" escape button.

@router.post("/{session_id}/force-generate")
async def force_generate(
    session_id: str,
    user: CurrentUser = Depends(require_studio),
):
    session = await _get_session(session_id, user.studio_id)
    if session["ai_stage"] != "scoping":
        raise HTTPException(
            status_code=409,
            detail={"message": "Session is not in scoping stage", "ai_stage": session["ai_stage"]},
        )
    if not session.get("scope_json"):
        # Build a minimal scope from whatever was discussed — use Haiku to extract it.
        history = await _load_messages(session_id)
        scope = await _extract_partial_scope(history, user.studio_id)
    else:
        scope = session["scope_json"]

    await _update_session(session_id, {
        "ai_stage":   "pending_generation",
        "scope_json": scope,
    })
    return {"ai_stage": "pending_generation", "generating": True}


async def _extract_partial_scope(history: list, studio_id: str) -> dict:
    from lib.scenario.context import build_scoping_prompt
    system_prompt = await build_scoping_prompt(studio_id)
    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    response = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=512,
        system=[{"type": "text", "text": system_prompt}],
        tools=[_SUBMIT_SCOPE_TOOL],
        tool_choice={"type": "tool", "name": "submit_scope"},
        messages=history,
    )
    tool_block = next((b for b in response.content if b.type == "tool_use"), None)
    if tool_block:
        return tool_block.input
    # Absolute fallback — minimal defaults.
    return {"horizon_months": 6, "release_cadence": "regular_releases", "distribution": "even", "scale": {}}


# ── GET /api/scenario/{session_id}/data ──────────────────────────────────────

@router.get("/{session_id}/data")
async def get_data(
    session_id: str,
    user: CurrentUser = Depends(require_studio),
):
    session = await _get_session(session_id, user.studio_id)

    import asyncio
    from lib.db import drain_pages
    product_rows, asset_rows, work_rows = await asyncio.gather(
        drain_pages(
            _url("/rest/v1/scenario_products"),
            params={"session_id": f"eq.{session_id}", "select": "*", "order": "created_at.asc"},
            headers=_headers(),
        ),
        drain_pages(
            _url("/rest/v1/scenario_assets"),
            params={"session_id": f"eq.{session_id}", "select": "*", "order": "created_at.asc"},
            headers=_headers(),
            page=1000,
        ),
        drain_pages(
            _url("/rest/v1/scenario_work"),
            params={"session_id": f"eq.{session_id}", "select": "*", "order": "start_date.asc,created_at.asc"},
            headers=_headers(),
            page=1000,
        ),
    )

    scope = session.get("scope_json") or {}
    return {
        "ai_stage":           session["ai_stage"],
        "message_count":      session["message_count"],
        "generation_mode":    session.get("generation_mode", "ai"),
        "scenario_category":  scope.get("scenario_category", "target_date"),
        "preflight_warnings": session.get("preflight_warnings") or [],
        "scope":              scope,
        "show_escape":        session["message_count"] >= _ESCAPE_TURN and session["ai_stage"] == "scoping",
        "products":           product_rows,
        "assets":             asset_rows,
        "work":               work_rows,
    }


# ── GET /api/scenario/{session_id}/messages ───────────────────────────────────

@router.get("/{session_id}/messages")
async def get_messages(
    session_id: str,
    user: CurrentUser = Depends(require_studio),
):
    await _get_session(session_id, user.studio_id)  # auth check
    msgs = await _load_messages(session_id)
    return {"messages": msgs}


# ── DELETE /api/scenario/{session_id} ─────────────────────────────────────────

@router.delete("/{session_id}")
async def dismiss_scenario(
    session_id: str,
    user: CurrentUser = Depends(require_studio),
):
    await _get_session(session_id, user.studio_id)
    r = await db_client.patch(
        _url("/rest/v1/scenario_sessions"),
        params={"id": f"eq.{session_id}"},
        json={"status": "dismissed"},
        headers=_headers({"Prefer": "return=minimal"}),
    )
    if not r.is_success:
        raise HTTPException(status_code=500, detail=f"Failed to dismiss session: {r.text}")
    return {"ok": True}


# ── POST /api/scenario/{session_id}/retry-generation ─────────────────────────

@router.post("/{session_id}/retry-generation")
async def retry_generation(
    session_id: str,
    user: CurrentUser = Depends(require_studio),
):
    session = await _get_session(session_id, user.studio_id)
    if session["ai_stage"] != "generation_failed":
        raise HTTPException(
            status_code=409,
            detail={"message": "Session is not in generation_failed stage", "ai_stage": session["ai_stage"]},
        )
    await _update_session(session_id, {"ai_stage": "pending_generation"})
    return {"ai_stage": "pending_generation", "generating": True}


# ── POST /api/scenario/{session_id}/regenerate ────────────────────────────────

class RegenerateBody(BaseModel):
    scope_changes: dict


@router.post("/{session_id}/regenerate")
async def regenerate_scenario(
    session_id: str,
    body: RegenerateBody,
    user: CurrentUser = Depends(require_studio),
):
    """
    Apply scope_changes to the stored scope, roll back all generated data,
    and re-queue the session for generation. The generation loop picks it up
    within 30 s — same path as the original generation trigger.
    """
    session = await _get_session(session_id, user.studio_id)
    if session["ai_stage"] not in ("discussion", "generation_failed"):
        raise HTTPException(
            status_code=409,
            detail={"message": "Session must be in discussion stage to regenerate", "ai_stage": session["ai_stage"]},
        )

    # Merge scope_changes into the stored scope (deep-merge for dicts).
    scope = dict(session.get("scope_json") or {})
    changes = body.scope_changes

    if "craft_caps" in changes:
        existing = dict(scope.get("craft_caps") or {})
        for craft, cap in (changes["craft_caps"] or {}).items():
            if cap is None:
                existing.pop(craft, None)
            else:
                existing[craft] = cap
        scope["craft_caps"] = existing or None

    if "release_interval_days" in changes:
        scope["release_interval_days"] = changes["release_interval_days"]

    if "num_products" in changes:
        scope["num_products"] = changes["num_products"]

    if "scale" in changes:
        existing = dict(scope.get("scale") or {})
        existing.update(changes.get("scale") or {})
        scope["scale"] = existing

    # Persist updated scope + reset to pending_generation.
    await _update_session(session_id, {"scope_json": scope, "ai_stage": "pending_generation"})

    # Roll back all scenario data — the generation loop will rebuild it.
    from lib.scenario.shared import rollback
    await rollback(session_id)

    return {"ai_stage": "pending_generation", "generating": True}


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _get_session(session_id: str, studio_id: str) -> dict:
    r = await db_client.get(
        _url("/rest/v1/scenario_sessions"),
        params={
            "id":       f"eq.{session_id}",
            "studio_id": f"eq.{studio_id}",
            "select":   "id,studio_id,ai_stage,scope_json,message_count,status,generation_mode,preflight_warnings",
            "limit":    "1",
        },
        headers=_headers(),
    )
    rows = r.json() if r.is_success else []
    if not rows:
        raise HTTPException(status_code=404, detail="Scenario session not found")
    session = rows[0]
    if session["status"] == "dismissed":
        raise HTTPException(status_code=410, detail="Scenario session has been dismissed")
    return session


async def _update_session(session_id: str, patch: dict) -> None:
    await db_client.patch(
        _url("/rest/v1/scenario_sessions"),
        params={"id": f"eq.{session_id}"},
        json=patch,
        headers=_headers({"Prefer": "return=minimal"}),
    )


async def _append_message(session_id: str, studio_id: str, role: str, content: str) -> None:
    await db_client.post(
        _url("/rest/v1/scenario_messages"),
        json={"session_id": session_id, "studio_id": studio_id, "role": role, "content": content},
        headers=_headers({"Prefer": "return=minimal"}),
    )


async def _load_messages(session_id: str) -> list[dict]:
    r = await db_client.get(
        _url("/rest/v1/scenario_messages"),
        params={
            "session_id": f"eq.{session_id}",
            "select":     "role,content",
            "order":      "created_at.asc",
        },
        headers=_headers(),
    )
    return r.json() if r.is_success else []
