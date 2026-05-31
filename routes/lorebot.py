"""LoreBot — Claude Haiku attachment summarization assistant (PoC)."""
import base64
import hashlib
import io
import logging
import os

import httpx
import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from lib.attachments import (
    _storage_api_url, _storage_headers, _storage_object_path, _BUCKET,
    _get_studio_source_creds, _source_fetch_headers, _storage_exists, _storage_upload,
    copy_payload_attachments,
)
from lib.auth import CurrentUser, get_current_user
from lib.db import db_client, _url, _headers

log = logging.getLogger(__name__)
router = APIRouter()

_MAX_TEXT_CHARS = 40_000
_MAX_IMAGES = 4
_IMAGE_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}


# ── models ────────────────────────────────────────────────────────────────────

class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[Message]
    asset_id: str | None = None
    dispatch_id: str | None = None


class ReplicateRequest(BaseModel):
    asset_id: str | None = None
    dispatch_id: str | None = None


# ── attachment helpers ─────────────────────────────────────────────────────────

def _is_attachment_item(item: dict) -> bool:
    """True if a meta list item looks like a real attachment (has both url and filename)."""
    return bool(item.get("url") and item.get("filename"))


def _find_meta_attachments(meta: dict) -> list[dict]:
    """Walk a replicated_assets meta dict and return all attachment items."""
    result = []
    for field_key, value in meta.items():
        if not isinstance(value, list) or not value:
            continue
        if not isinstance(value[0], dict) or not _is_attachment_item(value[0]):
            continue
        for idx, item in enumerate(value):
            if isinstance(item, dict) and _is_attachment_item(item):
                result.append({
                    "field_key": field_key,
                    "idx": idx,
                    "filename": item["filename"],
                    "mimetype": item.get("mimetype", "application/octet-stream"),
                    "content_hash": item.get("content_hash"),
                    "url": item.get("url"),
                })
    return result


async def _fetch_studio_asset_row(canonical_asset_id: str, studio_id: str) -> dict:
    r = await db_client.get(
        _url("/rest/v1/replicated_assets"),
        params={
            "canonical_asset_id": f"eq.{canonical_asset_id}",
            "owner_type": "eq.studio",
            "owner_id": f"eq.{studio_id}",
            "select": "meta,source_record_id,source_type",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(404, "Asset not found")
    return rows[0]


async def _fetch_studio_meta(canonical_asset_id: str, studio_id: str) -> dict:
    row = await _fetch_studio_asset_row(canonical_asset_id, studio_id)
    return row.get("meta") or {}


async def _fetch_asset_table_id(studio_id: str, source_type: str) -> str | None:
    r = await db_client.get(
        _url("/rest/v1/source_entity_definitions"),
        params={
            "owner_type": "eq.studio",
            "owner_id": f"eq.{studio_id}",
            "source_type": f"eq.{source_type}",
            "entity_type": "eq.asset",
            "select": "table_id",
        },
        headers=_headers(),
    )
    rows = r.json()
    return rows[0]["table_id"] if rows else None


async def _fetch_vendor_dispatch(dispatch_id: str, vendor_id: str) -> dict:
    r = await db_client.get(
        _url("/rest/v1/payload_dispatches"),
        params={
            "id": f"eq.{dispatch_id}",
            "recipient_vendor_id": f"eq.{vendor_id}",
            "revoked_at": "is.null",
            "select": "payload_data",
        },
        headers=_headers(),
    )
    rows = r.json()
    if not rows:
        raise HTTPException(404, "Dispatch not found or revoked")
    return rows[0].get("payload_data") or {}


async def _read_from_storage(content_hash: str, client: httpx.AsyncClient) -> bytes:
    # Service-role byte fetch (§0c carve-out). §7 GATE CONTRACT: callers MUST have resolved the
    # content_hash from a user-context, RLS-gated read first (here, _fetch_vendor_dispatch → pd_sel).
    # Blobs are content-addressed, so the only access control is "can the caller discover the hash" —
    # which the dispatch RLS gate enforces. Never call this with a hash from an ungated source.
    url = _storage_api_url(f"/object/{_BUCKET}/{_storage_object_path(content_hash)}")
    r = await client.get(url, headers=_storage_headers())
    r.raise_for_status()
    return r.content


def _extract_text(file_bytes: bytes, mimetype: str, filename: str) -> str | None:
    fname = filename.lower()

    if mimetype == "application/pdf" or fname.endswith(".pdf"):
        try:
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(file_bytes))
            text = "\n".join(page.extract_text() or "" for page in reader.pages).strip()
            if not text:
                return f"[Scanned PDF — no text could be extracted from {filename}]"
            return text[:_MAX_TEXT_CHARS]
        except Exception as exc:
            log.warning("lorebot: PDF extraction failed for %s: %s", filename, exc)
            return None

    is_text = (
        mimetype.startswith("text/")
        or mimetype in {"application/json", "application/xml"}
        or any(fname.endswith(ext) for ext in (".txt", ".md", ".csv", ".json", ".xml"))
    )
    if is_text:
        try:
            return file_bytes.decode("utf-8", errors="replace")[:_MAX_TEXT_CHARS]
        except Exception:
            return None

    return None


# ── studio replication helper ─────────────────────────────────────────────────

async def _refresh_airtable_urls(
    studio_id: str,
    source_record_id: str,
    creds: dict,
    updated_meta: dict,
    client: httpx.AsyncClient,
) -> None:
    """Fetch a single Airtable record to get fresh attachment URLs and patch them into updated_meta."""
    table_id = await _fetch_asset_table_id(studio_id, "airtable")
    if not table_id or not creds.get("base_id") or not creds.get("api_token"):
        return
    r = await client.get(
        f"https://api.airtable.com/v0/{creds['base_id']}/{table_id}/{source_record_id}",
        headers={"Authorization": f"Bearer {creds['api_token']}"},
    )
    if not r.is_success:
        log.warning("lorebot: airtable single-record refresh failed: %s", r.status_code)
        return
    fresh_fields = r.json().get("fields", {})
    for fk, fv in fresh_fields.items():
        if not isinstance(fv, list) or not fv or not isinstance(fv[0], dict) or "url" not in fv[0]:
            continue
        if not isinstance(updated_meta.get(fk), list):
            continue
        for fi, fitem in enumerate(fv):
            if fi < len(updated_meta[fk]) and isinstance(fitem, dict) and not updated_meta[fk][fi].get("content_hash"):
                updated_meta[fk][fi] = {**updated_meta[fk][fi], "url": fitem.get("url") or updated_meta[fk][fi].get("url")}


async def _replicate_studio_asset(canonical_asset_id: str, studio_id: str) -> None:
    """Copy all uncopied source-URL attachments for a studio asset to Supabase Storage."""
    asset_row = await _fetch_studio_asset_row(canonical_asset_id, studio_id)
    meta = asset_row.get("meta") or {}
    source_record_id: str = asset_row.get("source_record_id", "")
    source_type_from_db: str = asset_row.get("source_type", "airtable")

    items = _find_meta_attachments(meta)
    to_copy = [a for a in items if not a.get("content_hash") and a.get("url")]
    if not to_copy:
        return

    async with httpx.AsyncClient(timeout=120.0) as client:
        source_type, creds = await _get_studio_source_creds(studio_id, client)
        fetch_headers = _source_fetch_headers(source_type, creds)

        updated_meta = {k: list(v) if isinstance(v, list) else v for k, v in meta.items()}
        urls_refreshed = False

        for att in to_copy:
            field_key, idx, url = att["field_key"], att["idx"], att["url"]
            try:
                r_file = await client.get(url, headers=fetch_headers, follow_redirects=True)

                if r_file.status_code == 410:
                    if not urls_refreshed and source_type_from_db == "airtable" and source_record_id:
                        await _refresh_airtable_urls(
                            studio_id, source_record_id, creds, updated_meta, client,
                        )
                        urls_refreshed = True
                    fresh_list = updated_meta.get(field_key, [])
                    url = (fresh_list[idx].get("url") if idx < len(fresh_list) else None) or url
                    r_file = await client.get(url, headers=fetch_headers, follow_redirects=True)

                r_file.raise_for_status()
                file_bytes = r_file.content
                content_type = (
                    r_file.headers.get("content-type", "application/octet-stream")
                    .split(";")[0].strip()
                )
                content_hash = hashlib.sha256(file_bytes).hexdigest()
                if not await _storage_exists(content_hash, client):
                    await _storage_upload(content_hash, file_bytes, content_type, client)
                item = updated_meta[field_key][idx]
                updated_meta[field_key][idx] = {**item, "content_hash": content_hash, "mimetype": content_type}
                log.info("lorebot: copied %s[%d] for asset %s", field_key, idx, canonical_asset_id)
            except Exception as exc:
                log.warning("lorebot: copy failed %s[%d]: %s", field_key, idx, exc)

        await db_client.patch(
            _url("/rest/v1/replicated_assets"),
            params={
                "canonical_asset_id": f"eq.{canonical_asset_id}",
                "owner_type": "eq.studio",
                "owner_id": f"eq.{studio_id}",
            },
            headers=_headers({"Prefer": "return=minimal"}),
            json={"meta": updated_meta},
        )


# ── routes ────────────────────────────────────────────────────────────────────

@router.get("/items")
async def get_items(user: CurrentUser = Depends(get_current_user)):
    """List assets (studio) or received dispatches (vendor) that have attachments."""
    if user.role == "studio" and user.studio_id:
        r = await db_client.get(
            _url("/rest/v1/replicated_assets"),
            params={
                "owner_type": "eq.studio",
                "owner_id": f"eq.{user.studio_id}",
                "select": "canonical_asset_id,name,meta",
                "order": "name.asc",
            },
            headers=_headers({"Range": "0-499"}),
        )
        result = []
        for a in (r.json() if r.is_success else []):
            meta = a.get("meta") or {}
            has_att = any(
                isinstance(v, list) and v and isinstance(v[0], dict) and _is_attachment_item(v[0])
                for v in meta.values()
            )
            if has_att:
                result.append({
                    "id": a["canonical_asset_id"],
                    "label": a.get("name") or a["canonical_asset_id"],
                    "type": "asset",
                })
        return result

    if user.role == "vendor" and user.vendor_id:
        r = await db_client.get(
            _url("/rest/v1/payload_dispatches"),
            params={
                "recipient_vendor_id": f"eq.{user.vendor_id}",
                "revoked_at": "is.null",
                "select": "id,created_at,payload_data",
                "order": "created_at.desc",
            },
            headers=_headers({"Range": "0-99"}),
        )
        result = []
        for d in (r.json() if r.is_success else []):
            pd = d.get("payload_data") or {}
            data = pd.get("data") or {}
            has_att = any(
                isinstance(v, list) and v and isinstance(v[0], dict) and _is_attachment_item(v[0])
                for v in data.values()
            )
            if has_att:
                studio_name = pd.get("sender_studio_name") or ""
                created = (d.get("created_at") or "")[:10]
                label = (
                    f"{studio_name} — {created}" if studio_name
                    else f"Dispatch {d['id'][:8]} ({created})"
                )
                result.append({"id": d["id"], "label": label, "type": "dispatch"})
        return result

    raise HTTPException(403, "No studio or vendor linked to account")


@router.post("/replicate")
async def replicate(body: ReplicateRequest, user: CurrentUser = Depends(get_current_user)):
    """Trigger attachment copy for an asset or dispatch. Runs synchronously."""
    if body.asset_id and user.role == "studio" and user.studio_id:
        await _replicate_studio_asset(body.asset_id, user.studio_id)
        return {"status": "done"}

    if body.dispatch_id and user.role == "vendor" and user.vendor_id:
        await _fetch_vendor_dispatch(body.dispatch_id, user.vendor_id)  # ownership check
        await copy_payload_attachments(body.dispatch_id)
        return {"status": "done"}

    raise HTTPException(400, "Provide asset_id (studio) or dispatch_id (vendor)")


@router.post("/chat")
async def chat(body: ChatRequest, user: CurrentUser = Depends(get_current_user)):
    if not body.messages:
        raise HTTPException(400, "messages required")

    # ── resolve attachments ────────────────────────────────────────────────────
    if body.asset_id and user.role == "studio" and user.studio_id:
        meta = await _fetch_studio_meta(body.asset_id, user.studio_id)
        all_atts = _find_meta_attachments(meta)
    elif body.dispatch_id and user.role == "vendor" and user.vendor_id:
        pd = await _fetch_vendor_dispatch(body.dispatch_id, user.vendor_id)
        data = pd.get("data") or {}
        all_atts = []
        for field_key, value in data.items():
            if not isinstance(value, list) or not value:
                continue
            if isinstance(value[0], dict) and _is_attachment_item(value[0]):
                for idx, item in enumerate(value):
                    if isinstance(item, dict) and _is_attachment_item(item):
                        all_atts.append({
                            "field_key": field_key,
                            "idx": idx,
                            "filename": item["filename"],
                            "mimetype": item.get("mimetype", "application/octet-stream"),
                            "content_hash": item.get("content_hash"),
                        })
    else:
        raise HTTPException(400, "Provide asset_id (studio) or dispatch_id (vendor)")

    # ── replication gate ───────────────────────────────────────────────────────
    uncopied = [a for a in all_atts if not a.get("content_hash")]
    if uncopied:
        return {
            "needs_replication": True,
            "uncopied": [
                {"filename": a["filename"], "field_key": a["field_key"], "idx": a["idx"]}
                for a in uncopied
            ],
        }

    if not all_atts:
        return {"answer": "This asset has no attachments for me to read."}

    # ── read content from storage ──────────────────────────────────────────────
    text_sections: list[str] = []
    image_blocks: list[dict] = []
    att_summary: list[str] = []

    async with httpx.AsyncClient(timeout=60.0) as http:
        for att in all_atts:
            try:
                file_bytes = await _read_from_storage(att["content_hash"], http)
            except Exception as exc:
                log.warning("lorebot: storage read failed %s: %s", att["filename"], exc)
                att_summary.append(f"- {att['filename']} (read error — skipped)")
                continue

            mimetype = att.get("mimetype", "")
            filename = att.get("filename", "attachment")

            if mimetype in _IMAGE_TYPES and len(image_blocks) < _MAX_IMAGES:
                b64 = base64.standard_b64encode(file_bytes).decode()
                image_blocks.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": mimetype, "data": b64},
                })
                att_summary.append(f"- {filename} (image)")
            else:
                text = _extract_text(file_bytes, mimetype, filename)
                if text:
                    text_sections.append(f"=== {filename} ===\n{text}\n=== END ===")
                    att_summary.append(f"- {filename} ({len(text):,} chars extracted)")
                else:
                    att_summary.append(f"- {filename} [{mimetype}] (format not supported)")

    # ── build Haiku call ───────────────────────────────────────────────────────
    system_text = (
        "You are LoreBot, a document reference assistant built into ArtHound — "
        "an asset management platform for game production studios.\n\n"
        "⚠️ PROOF OF CONCEPT — powered by Claude Haiku. Do not share confidential data.\n\n"
        "Your job is to answer questions about the attached documents: summaries, synopses, "
        "quick-reference lookups, and cross-referencing information within the files.\n\n"
        "Rules:\n"
        "- Base answers only on the content provided below.\n"
        "- If something is not covered in the attachments, say so clearly.\n"
        "- Never fabricate details not present in the content.\n"
        "- If content was truncated, note that the full document may contain more.\n\n"
        "ATTACHMENTS:\n" + "\n".join(att_summary) + "\n\n"
    )
    if text_sections:
        system_text += "CONTENT:\n\n" + "\n\n".join(text_sections)
    elif not image_blocks:
        system_text += "No readable content could be extracted from the attachments."

    messages_out = [{"role": m.role, "content": m.content} for m in body.messages]

    if image_blocks:
        # Inject images as content blocks into the last user message
        for i in range(len(messages_out) - 1, -1, -1):
            if messages_out[i]["role"] == "user":
                messages_out[i]["content"] = image_blocks + [
                    {"type": "text", "text": messages_out[i]["content"]}
                ]
                break

    ac = anthropic.AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    response = await ac.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        system=[{"type": "text", "text": system_text, "cache_control": {"type": "ephemeral"}}],
        messages=messages_out,
    )
    return {"answer": response.content[0].text}
