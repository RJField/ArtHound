import logging
import os

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers
from lib.scenario.context import build_scoping_prompt, build_discussion_prompt

log = logging.getLogger(__name__)
router = APIRouter()

_FORCE_SCOPE_TURN = 8   # Force submit_scope tool call at this turn count.
_ESCAPE_TURN      = 5   # Frontend shows "generate with what I have" after this turn.

_SUBMIT_SCOPE_TOOL = {
    "name": "submit_scope",
    "description": (
        "Call this when you have gathered enough information to generate the scenario. "
        "Do not call it until you have at least horizon_months, release_cadence, "
        "distribution, and scale."
    ),
    "input_schema": {
        "type": "object",
        "required": ["horizon_months", "release_cadence", "distribution", "scale"],
        "properties": {
            "horizon_months": {
                "type": "integer",
                "description": "Planning horizon in months",
            },
            "release_cadence": {
                "type": "string",
                "enum": ["single_launch", "regular_releases", "milestone_batched", "continuous"],
                "description": "How often finished content ships to end users",
            },
            "distribution": {
                "type": "string",
                "enum": ["even", "front_loaded", "back_loaded", "milestone_batched"],
                "description": "How assets are spread across the planning horizon",
            },
            "scale": {
                "type": "object",
                "description": 'Asset count per classification profile e.g. {"Hero": 4, "Supporting": 8}',
            },
            "constraints": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Optional hard constraints e.g. 'no character work before March'",
            },
        },
    },
}


class MessageBody(BaseModel):
    content: str


# ── POST /api/scenario/start ──────────────────────────────────────────────────

@router.post("/start")
async def start_scenario(user: CurrentUser = Depends(require_studio)):
    studio_id = user.studio_id

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
            "select":    "id,ai_stage,message_count,scope_json",
            "limit":     "1",
        },
        headers=_headers(),
    )
    if existing_r.is_success and existing_r.json():
        row = existing_r.json()[0]
        return {
            "session_id":    row["id"],
            "ai_stage":      row["ai_stage"],
            "message_count": row["message_count"],
            "resumed":       True,
        }

    # Create new session.
    create_r = await db_client.post(
        _url("/rest/v1/scenario_sessions"),
        json={
            "studio_id": studio_id,
            "user_id":   user.id,
        },
        headers=_headers({"Prefer": "return=representation"}),
    )
    if not create_r.is_success:
        raise HTTPException(status_code=500, detail=f"Failed to create session: {create_r.text}")

    session = create_r.json()[0]
    return {
        "session_id":    session["id"],
        "ai_stage":      session["ai_stage"],
        "message_count": session["message_count"],
        "resumed":       False,
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

    if stage == "scoping":
        return await _handle_scoping(session_id, user.studio_id, history, message_count)

    if stage == "discussion":
        return await _handle_discussion(session_id, user.studio_id, history)

    raise HTTPException(status_code=409, detail={"message": "Unexpected stage", "ai_stage": stage})


async def _handle_scoping(session_id: str, studio_id: str, history: list, message_count: int) -> dict:
    system_prompt = await build_scoping_prompt(studio_id)
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
        scope = tool_use_block.input
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


async def _handle_discussion(session_id: str, studio_id: str, history: list) -> dict:
    system_prompt = await build_discussion_prompt(studio_id, session_id)
    client = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

    response = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system=[{"type": "text", "text": system_prompt, "cache_control": {"type": "ephemeral"}}],
        messages=history,
    )
    assistant_text = response.content[0].text
    await _append_message(session_id, studio_id, "assistant", assistant_text)
    return {
        "message":  assistant_text,
        "ai_stage": "discussion",
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
    products_r, assets_r, work_r = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/scenario_products"),
            params={"session_id": f"eq.{session_id}", "select": "*", "order": "created_at.asc"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/scenario_assets"),
            params={"session_id": f"eq.{session_id}", "select": "*", "order": "created_at.asc", "limit": "10000"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/scenario_work"),
            params={"session_id": f"eq.{session_id}", "select": "*", "order": "start_date.asc,created_at.asc", "limit": "50000"},
            headers=_headers(),
        ),
    )

    return {
        "ai_stage":      session["ai_stage"],
        "message_count": session["message_count"],
        "scope":         session.get("scope_json"),
        "show_escape":   session["message_count"] >= _ESCAPE_TURN and session["ai_stage"] == "scoping",
        "products":      products_r.json() if products_r.is_success else [],
        "assets":        assets_r.json()   if assets_r.is_success   else [],
        "work":          work_r.json()     if work_r.is_success      else [],
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


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _get_session(session_id: str, studio_id: str) -> dict:
    r = await db_client.get(
        _url("/rest/v1/scenario_sessions"),
        params={
            "id":       f"eq.{session_id}",
            "studio_id": f"eq.{studio_id}",
            "select":   "id,studio_id,ai_stage,scope_json,message_count,status",
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
