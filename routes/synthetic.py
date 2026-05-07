import asyncio
import logging
import random
from datetime import date, datetime, timedelta
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from lib.auth import CurrentUser, get_current_user, require_admin
from lib.crypto import decrypt_credentials, encrypt_credentials
from lib.db import db_client, _url, _headers
from lib.airtable import http_client
from lib.sync.connectors.airtable import AirtableConnector

log = logging.getLogger(__name__)

router = APIRouter()

_BATCH_SIZE    = 10
_INTER_BATCH_S = 0.2   # 200ms between batches — stays under Airtable's 5 req/s limit
_MAX_RETRIES   = 3

# Field types that Airtable accepts values for on create/update
_WRITABLE_TYPES = {
    'singleLineText', 'multilineText', 'number', 'currency', 'percent',
    'singleSelect', 'multipleSelects', 'checkbox', 'date', 'dateTime',
    'rating', 'duration', 'email', 'url', 'phoneNumber',
}


# ── Word lists ────────────────────────────────────────────────────────────────

_NOUNS = [
    "Phoenix", "Ember", "Cobalt", "Titan", "Raven", "Onyx", "Nova", "Flare",
    "Zenith", "Apex", "Prism", "Nexus", "Cipher", "Dusk", "Forge", "Glacier",
    "Halcyon", "Ironwood", "Jasper", "Kindle", "Lantern", "Mast", "Nebula",
    "Obsidian", "Pinnacle", "Quartz", "Rift", "Solace", "Tempest", "Umbra",
    "Vault", "Warden", "Xenon", "Yarrow", "Zephyr", "Basalt", "Canopy",
    "Deluge", "Eclipse", "Fathom", "Grotto", "Harbor", "Indigo", "Jetsam",
    "Kelp", "Marrow", "Nadir", "Ochre", "Pelage", "Quarry", "Reliquary",
    "Sable", "Talon", "Undertow", "Vesper", "Wisp", "Abyss", "Blaze",
    "Crest", "Drift", "Epoch", "Fissure", "Glyph", "Haze", "Icon",
    "Jetty", "Lava", "Mesa", "Nimbus", "Opal", "Peak", "Ridge",
    "Shard", "Tide", "Veil", "Wraith", "Cinder", "Flint", "Gale",
    "Helm", "Ingot", "Knoll", "Lumen", "Moraine", "Nook", "Outcrop",
]

_VERBS = [
    "Render", "Scatter", "Forge", "Carve", "Weld", "Cast", "Etch", "Sculpt",
    "Trace", "Mold", "Hone", "Spin", "Draft", "Shade", "Blend", "Refine",
    "Layer", "Mirror", "Prune", "Anchor", "Bevel", "Chisel", "Dampen",
    "Engrave", "Filter", "Grind", "Hammer", "Infuse", "Knit", "Lacquer",
    "Merge", "Notch", "Offset", "Polish", "Quench", "Rivet", "Solder",
    "Temper", "Unite", "Varnish", "Weave", "Burnish", "Compress", "Distill",
    "Emboss", "Flatten", "Glaze", "Harden", "Imprint", "Kiln", "Laminate",
    "Manifest", "Outline", "Pattern", "Raster", "Stipple", "Unwrap",
    "Vector", "Wash", "Extrude", "Bake", "Clip", "Dissolve", "Erode",
    "Fuse", "Glitch", "Inflate", "Jitter", "Keyframe", "Loop", "Mask",
    "Noise", "Occlude", "Pivot", "Rig", "Sweep", "Trim", "Unfold",
    "Wrap", "Yield", "Zero", "Align", "Bridge", "Constrain", "Deform",
]

_ADVERBS = [
    "Swiftly", "Boldly", "Crisply", "Cleanly", "Sharply", "Firmly", "Neatly",
    "Briskly", "Clearly", "Deftly", "Evenly", "Finely", "Gently", "Heavily",
    "Intently", "Jointly", "Keenly", "Lightly", "Nimbly", "Promptly",
    "Quickly", "Readily", "Smoothly", "Tightly", "Uniformly", "Vividly",
    "Warmly", "Exactly", "Ably", "Aptly", "Calmly", "Directly", "Earnestly",
    "Freely", "Gladly", "Honestly", "Ideally", "Justly", "Kindly", "Lively",
    "Mindfully", "Nobly", "Orderly", "Plainly", "Quietly", "Resolutely",
    "Steadily", "Truly", "Urgently", "Valiantly", "Wisely", "Zealously",
    "Actively", "Briefly", "Closely", "Deeply", "Eagerly", "Freshly",
    "Gracefully", "Heartily", "Instantly", "Joyfully", "Loyally", "Modestly",
    "Notably", "Precisely", "Rapidly", "Soundly", "Thoroughly", "Uniquely",
    "Vigorously", "Wholly", "Adeptly", "Capably", "Dutifully",
    "Efficiently", "Fluently", "Graciously", "Humbly", "Ingeniously",
]


# ── Random value generation ───────────────────────────────────────────────────

def _random_value(field_type: str, options: dict) -> Any:
    """Return a plausible random value for a given Airtable field type."""
    opts = options or {}

    if field_type == 'singleLineText':
        return random.choice(_NOUNS + _VERBS + _ADVERBS)

    if field_type == 'multilineText':
        return f"{random.choice(_NOUNS)} {random.choice(_VERBS)} {random.choice(_ADVERBS)}"

    if field_type in ('number', 'currency', 'percent'):
        precision = opts.get('precision', 0)
        return random.randint(1, 100) if precision == 0 else round(random.uniform(1.0, 100.0), precision)

    if field_type == 'singleSelect':
        choices = opts.get('choices', [])
        return random.choice(choices)['name'] if choices else None

    if field_type == 'multipleSelects':
        choices = opts.get('choices', [])
        if not choices:
            return None
        k = min(random.randint(1, 2), len(choices))
        return [c['name'] for c in random.sample(choices, k)]

    if field_type == 'checkbox':
        return random.choice([True, False])

    if field_type == 'date':
        d = date.today() - timedelta(days=random.randint(0, 365))
        return d.isoformat()

    if field_type == 'dateTime':
        dt = datetime.utcnow() - timedelta(days=random.randint(0, 365), hours=random.randint(0, 23))
        return dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')

    if field_type == 'rating':
        max_val = opts.get('max', 5)
        return random.randint(1, max_val)

    if field_type == 'duration':
        return random.randint(60, 7200)  # seconds, 1 min – 2 hrs

    if field_type == 'email':
        return f"{random.choice(_VERBS).lower()}.{random.choice(_NOUNS).lower()}@example.com"

    if field_type == 'url':
        return f"https://example.com/{random.choice(_NOUNS).lower()}"

    if field_type == 'phoneNumber':
        return f"+1{random.randint(2000000000, 9999999999)}"

    return None


# ── Helpers ───────────────────────────────────────────────────────────────────


async def _load_target(target_id: str, studio_id: str) -> dict:
    r = await db_client.get(
        _url("/rest/v1/synthetic_targets"),
        params={
            "id":        f"eq.{target_id}",
            "studio_id": f"eq.{studio_id}",
            "select":    "id,name,base_id,token_enc,p_table,a_table,w_table,"
                         "p_primary_field,a_primary_field,w_primary_field,"
                         "a_link_field,w_link_field",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        raise HTTPException(404, "Target not found")
    return rows[0]


async def _airtable_batch_create(
    base_id: str,
    table: str,
    records: list[dict],
    token: str,
) -> list[dict]:
    """
    POST one batch (≤10 records) to Airtable with retry/backoff.

    429 → respect Retry-After header (default 30s), up to _MAX_RETRIES attempts.
    5xx / timeout → exponential backoff (2 → 4 → 8s), up to _MAX_RETRIES attempts.
    4xx (non-429) → fail immediately with a descriptive message.
    """
    url     = f"https://api.airtable.com/v0/{base_id}/{table}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {"records": [{"fields": r} for r in records]}
    backoff = 2.0

    for attempt in range(_MAX_RETRIES + 1):
        try:
            r = await http_client.post(url, json=payload, headers=headers)
        except httpx.TimeoutException as exc:
            if attempt == _MAX_RETRIES:
                raise HTTPException(504, f"Airtable timed out after {_MAX_RETRIES + 1} attempts") from exc
            log.warning("Airtable timeout — backoff %.0fs (attempt %d)", backoff, attempt + 1)
            await asyncio.sleep(backoff)
            backoff *= 2
            continue

        if r.status_code == 429:
            if attempt == _MAX_RETRIES:
                raise HTTPException(429, f"Rate limited by Airtable — exhausted {_MAX_RETRIES} retries")
            wait = float(r.headers.get("Retry-After", 30))
            log.warning("Airtable 429 — waiting %.0fs (attempt %d)", wait, attempt + 1)
            await asyncio.sleep(wait)
            continue

        if r.status_code >= 500:
            if attempt == _MAX_RETRIES:
                raise HTTPException(502, f"Airtable server error {r.status_code} after {_MAX_RETRIES} retries")
            log.warning("Airtable %d — backoff %.0fs (attempt %d)", r.status_code, backoff, attempt + 1)
            await asyncio.sleep(backoff)
            backoff *= 2
            continue

        if r.status_code == 401:
            raise HTTPException(401, "Airtable rejected the token — verify it has write access to this base")
        if r.status_code == 403:
            raise HTTPException(403, "Airtable access denied — token may lack write permissions")
        if r.status_code == 404:
            raise HTTPException(404, f"Table '{table}' not found in base '{base_id}' — check the table name")
        if r.status_code == 422:
            err = r.json().get("error", {})
            msg = err.get("message", r.text) if isinstance(err, dict) else r.text
            raise HTTPException(422, f"Airtable rejected records — check link field names. Detail: {msg}")

        r.raise_for_status()
        return r.json()["records"]

    raise HTTPException(500, "Airtable request failed — unexpected state after retries")


async def _create_all(
    base_id: str,
    table: str,
    names: list[str],
    token: str,
    primary_field: str,
    link_field: Optional[str] = None,
    link_pool: Optional[list[str]] = None,
    extra_fields: list = [],
) -> list[str]:
    """Batch-create all records; return list of created Airtable record IDs."""
    created_ids: list[str] = []

    for i in range(0, len(names), _BATCH_SIZE):
        batch = names[i : i + _BATCH_SIZE]
        records = []
        for name in batch:
            fields: dict = {primary_field: name}
            if link_field and link_pool:
                fields[link_field] = [random.choice(link_pool)]
            for ef in extra_fields:
                val = _random_value(ef.type, ef.options)
                if val is not None:
                    fields[ef.name] = val
            records.append(fields)

        created = await _airtable_batch_create(base_id, table, records, token)
        created_ids.extend(rec["id"] for rec in created)

        await asyncio.sleep(_INTER_BATCH_S)

    return created_ids


# ── Pydantic models ───────────────────────────────────────────────────────────

class TargetCreate(BaseModel):
    """Initial connection — just enough to validate credentials and save the target."""
    name:    str
    base_id: str
    token:   str


class TargetMappingUpdate(BaseModel):
    """Table/field mapping saved in step 2, after schema discovery."""
    p_table:         str
    a_table:         str
    w_table:         str
    p_primary_field: str
    a_primary_field: str
    w_primary_field: str
    a_link_field:    Optional[str] = None
    w_link_field:    Optional[str] = None


class ExtraField(BaseModel):
    """A single additional field to populate with random data during generation."""
    name:    str
    type:    str
    options: dict = {}


class GenerateRequest(BaseModel):
    target_id:      str
    p_count:        int
    a_count:        int
    w_count:        int
    link_a_to_p:    bool = False
    link_w_to_a:    bool = False
    extra_fields_p: list[ExtraField] = []
    extra_fields_a: list[ExtraField] = []
    extra_fields_w: list[ExtraField] = []


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/targets")
async def list_targets(user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    r = await db_client.get(
        _url("/rest/v1/synthetic_targets"),
        params={
            "studio_id": f"eq.{user.studio_id or '00000000-0000-0000-0000-000000000000'}",
            "select":    "id,name,base_id,p_table,a_table,w_table,"
                         "p_primary_field,a_primary_field,w_primary_field,"
                         "a_link_field,w_link_field,created_at",
            "order":     "created_at.asc",
        },
        headers=_headers(),
    )
    r.raise_for_status()
    return r.json()


@router.post("/targets", status_code=201)
async def create_target(body: TargetCreate, user: CurrentUser = Depends(get_current_user)):
    """Save credentials only — table mapping is set separately via PATCH."""
    require_admin(user)
    if not user.studio_id:
        raise HTTPException(400, "No studio linked to this account")

    async with httpx.AsyncClient(timeout=15.0) as client:
        connector = AirtableConnector(
            api_token=body.token.strip(),
            base_id=body.base_id.strip(),
            client=client,
        )
        try:
            tables = await connector.fetch_base_schema()
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                raise HTTPException(422, "Invalid token — Airtable rejected it")
            if e.response.status_code == 404:
                raise HTTPException(422, "Base not found — check the Base ID")
            raise HTTPException(422, f"Airtable error {e.response.status_code}")
        except Exception as e:
            raise HTTPException(422, f"Connection failed: {e}")

    if not tables:
        raise HTTPException(422, "Connected but base has no tables")

    token_enc = encrypt_credentials({"token": body.token.strip()})

    r = await db_client.post(
        _url("/rest/v1/synthetic_targets"),
        json={
            "studio_id": user.studio_id,
            "name":      body.name.strip(),
            "base_id":   body.base_id.strip(),
            "token_enc": token_enc,
        },
        headers={**_headers(), "Prefer": "return=representation"},
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return {}
    row = rows[0]
    return {k: v for k, v in row.items() if k != "token_enc"}


@router.patch("/targets/{target_id}")
async def update_target_mapping(
    target_id: str,
    body: TargetMappingUpdate,
    user: CurrentUser = Depends(get_current_user),
):
    """Save table/field mapping after schema discovery."""
    require_admin(user)
    r = await db_client.patch(
        _url("/rest/v1/synthetic_targets"),
        params={
            "id":        f"eq.{target_id}",
            "studio_id": f"eq.{user.studio_id or ''}",
        },
        json={
            "p_table":         body.p_table,
            "a_table":         body.a_table,
            "w_table":         body.w_table,
            "p_primary_field": body.p_primary_field,
            "a_primary_field": body.a_primary_field,
            "w_primary_field": body.w_primary_field,
            "a_link_field":    body.a_link_field or None,
            "w_link_field":    body.w_link_field or None,
        },
        headers={**_headers(), "Prefer": "return=minimal"},
    )
    r.raise_for_status()
    return {"ok": True}


@router.get("/targets/{target_id}/schema")
async def get_target_schema(target_id: str, user: CurrentUser = Depends(get_current_user)):
    """Fetch all tables + fields from the target base. Used to populate mapping dropdowns."""
    require_admin(user)
    t = await _load_target(target_id, user.studio_id or "")
    token = decrypt_credentials(t["token_enc"])["token"]

    async with httpx.AsyncClient(timeout=20.0) as client:
        connector = AirtableConnector(
            api_token=token,
            base_id=t["base_id"],
            client=client,
        )
        try:
            tables = await connector.fetch_base_schema()
        except httpx.HTTPStatusError as e:
            raise HTTPException(422, f"Airtable schema fetch failed: {e.response.status_code}")
        except Exception as e:
            raise HTTPException(422, f"Schema fetch failed: {e}")

    return {"tables": tables}


@router.delete("/targets/{target_id}", status_code=204)
async def delete_target(target_id: str, user: CurrentUser = Depends(get_current_user)):
    require_admin(user)
    r = await db_client.delete(
        _url("/rest/v1/synthetic_targets"),
        params={
            "id":        f"eq.{target_id}",
            "studio_id": f"eq.{user.studio_id or ''}",
        },
        headers=_headers(),
    )
    r.raise_for_status()


@router.post("/generate")
async def generate(body: GenerateRequest, user: CurrentUser = Depends(get_current_user)):
    require_admin(user)

    for label, val in [("p_count", body.p_count), ("a_count", body.a_count), ("w_count", body.w_count)]:
        if not 1 <= val <= 1000:
            raise HTTPException(400, f"{label} must be between 1 and 1000")

    t = await _load_target(body.target_id, user.studio_id or "")

    if not all([t.get("p_table"), t.get("a_table"), t.get("w_table"),
                t.get("p_primary_field"), t.get("a_primary_field"), t.get("w_primary_field")]):
        raise HTTPException(400, "Target table mapping is incomplete — finish step 2 first")

    # Silently drop any extra fields whose type isn't in the writable set
    def safe_extras(fields: list[ExtraField]) -> list[ExtraField]:
        return [f for f in fields if f.type in _WRITABLE_TYPES]

    token   = decrypt_credentials(t["token_enc"])["token"]
    base_id = t["base_id"]

    p_names = [f"{random.choice(_NOUNS)} {i+1:03d}"   for i in range(body.p_count)]
    a_names = [f"{random.choice(_VERBS)} {i+1:03d}"   for i in range(body.a_count)]
    w_names = [f"{random.choice(_ADVERBS)} {i+1:03d}" for i in range(body.w_count)]

    written: dict = {"products": 0, "assets": 0, "work": 0}

    try:
        p_ids = await _create_all(
            base_id, t["p_table"], p_names, token, t["p_primary_field"],
            extra_fields=safe_extras(body.extra_fields_p),
        )
        written["products"] = len(p_ids)

        ap_field = t.get("a_link_field") if body.link_a_to_p else None
        a_ids = await _create_all(
            base_id, t["a_table"], a_names, token, t["a_primary_field"],
            ap_field, p_ids or None,
            extra_fields=safe_extras(body.extra_fields_a),
        )
        written["assets"] = len(a_ids)

        wa_field = t.get("w_link_field") if body.link_w_to_a else None
        w_ids = await _create_all(
            base_id, t["w_table"], w_names, token, t["w_primary_field"],
            wa_field, a_ids or None,
            extra_fields=safe_extras(body.extra_fields_w),
        )
        written["work"] = len(w_ids)

    except HTTPException as exc:
        return JSONResponse(status_code=207, content={**written, "error": exc.detail})

    return written
