import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any, List, Optional

logger = logging.getLogger(__name__)

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from lib.airtable import select_all, update_records, http_client
from lib.auth import CurrentUser, require_studio
from lib.db import db_client, _url, _headers
from lib.utils import link_id
import config

router = APIRouter()

ESTIMATES_CONFIG_PATH = Path(__file__).parent.parent / "estimates.config.json"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_RESERVED_KEYS = {"_variableFields", "_fieldIds"}


def read_estimates_config() -> dict:
    try:
        return json.loads(ESTIMATES_CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"_variableFields": []}


def sanitize(s: str) -> str:
    return "".join(c for c in str(s) if c.isalnum())[:25] or "unknown"


def to_column_name(combo: dict, variable_fields: list) -> str:
    return "_".join(
        sanitize(combo["values"].get(f, {}).get("name", "unknown")) for f in variable_fields
    )


def to_config_key(combo: dict, variable_fields: list) -> str:
    return "|".join(combo["values"].get(f, {}).get("name", "") for f in variable_fields)


async def fetch_base_schema() -> list:
    token = os.environ.get("AIRTABLE_TOKEN")
    base_id = os.environ.get("AIRTABLE_BASE_ID")
    r = await http_client.get(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not r.is_success:
        body = r.json()
        raise ValueError(
            body.get("error", {}).get("message") or f"Schema API returned {r.status_code}"
        )
    return r.json().get("tables", [])


async def fetch_records_direct(table_id: str, fields: list = []) -> list:
    token = os.environ.get("AIRTABLE_TOKEN")
    base_id = os.environ.get("AIRTABLE_BASE_ID")
    records = []
    offset = None
    while True:
        params: list[tuple[str, Any]] = [("fields[]", f) for f in fields]
        if offset:
            params.append(("offset", offset))
        r = await http_client.get(
            f"https://api.airtable.com/v0/{base_id}/{table_id}",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
        )
        r.raise_for_status()
        data = r.json()
        records.extend(data.get("records", []))
        offset = data.get("offset")
        if not offset:
            break
    return records


async def patch_records(table_id: str, updates: list) -> None:
    token = os.environ.get("AIRTABLE_TOKEN")
    base_id = os.environ.get("AIRTABLE_BASE_ID")
    for i in range(0, len(updates), 10):
        if i > 0:
            await asyncio.sleep(0.3)
        batch = updates[i : i + 10]
        print(f"[patch_records] batch {i}–{i + len(batch) - 1} of {len(updates)}")
        r = await http_client.patch(
            f"https://api.airtable.com/v0/{base_id}/{table_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"records": batch},
        )
        r.raise_for_status()


async def delete_field(table_id: str, field_id: str) -> None:
    token = os.environ.get("AIRTABLE_TOKEN")
    base_id = os.environ.get("AIRTABLE_BASE_ID")
    r = await http_client.delete(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables/{table_id}/fields/{field_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not r.is_success:
        try:
            body = r.json()
        except Exception:
            body = r.text
        raise ValueError(f"Delete field failed (HTTP {r.status_code}): {body}")


async def add_field_to_table(
    table_id: str, name: str, field_type: str = "number", options: dict = {"precision": 1}
) -> dict:
    token = os.environ.get("AIRTABLE_TOKEN")
    base_id = os.environ.get("AIRTABLE_BASE_ID")
    r = await http_client.post(
        f"https://api.airtable.com/v0/meta/bases/{base_id}/tables/{table_id}/fields",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={"name": name, "type": field_type, "options": options},
    )
    body = r.json()
    if not r.is_success:
        err = body.get("error", {})
        raise ValueError(
            (err.get("message") if isinstance(err, dict) else str(err))
            or f'Failed to add field "{name}": {r.status_code}'
        )
    return body


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/fields")
async def get_fields():
    tables = await fetch_base_schema()
    assets_table = next((t for t in tables if t["name"] == config.tables["assets"]), None)
    if not assets_table:
        raise ValueError(f'Assets table "{config.tables["assets"]}" not found')

    eligible_types = {
        "singleSelect", "multipleSelects", "multipleRecordLinks",
        "number", "rating", "lookup", "multipleLookupValues", "rollup",
    }
    fields = [
        {"id": f["id"], "name": f["name"], "type": f["type"]}
        for f in assets_table["fields"]
        if f["type"] in eligible_types
    ]
    return {"fields": fields}


@router.get("/field-values")
async def get_field_values(field: str = Query(...)):
    tables = await fetch_base_schema()
    assets_table = next((t for t in tables if t["name"] == config.tables["assets"]), None)
    if not assets_table:
        raise ValueError(f'Assets table "{config.tables["assets"]}" not found')

    field_def = next((f for f in assets_table["fields"] if f["name"] == field), None)
    if not field_def:
        raise ValueError(f'Field "{field}" not found')

    values = []
    ftype = field_def["type"]

    if ftype in ("singleSelect", "multipleSelects"):
        values = [
            {"id": c["name"], "name": c["name"]}
            for c in field_def.get("options", {}).get("choices", [])
        ]
    elif ftype == "multipleRecordLinks":
        linked_table_id = field_def.get("options", {}).get("linkedTableId")
        linked_table = next((t for t in tables if t["id"] == linked_table_id), None)
        if not linked_table:
            raise ValueError(f'Linked table not found for field "{field}"')
        primary = linked_table["fields"][0]["name"] if linked_table["fields"] else "Name"
        records = await select_all(linked_table["name"], {"fields": [primary]})
        values = [{"id": r["id"], "name": r["fields"].get(primary, r["id"])} for r in records]
    else:
        records = await select_all(config.tables["assets"], {"fields": [field]})
        seen: dict = {}
        for r in records:
            raw = r["fields"].get(field)
            v = raw[0] if isinstance(raw, list) else raw
            if v is not None:
                seen[str(v)] = v
        values = [
            {"id": k, "name": str(v)}
            for k, v in sorted(seen.items(), key=lambda x: x[1])
        ]

    return {"field": field, "type": ftype, "values": values}


@router.get("/asset-combinations")
async def get_asset_combinations(field: List[str] = Query(default=[])):
    field_names = [f.strip() for f in field if f.strip()]
    if not field_names:
        raise HTTPException(status_code=400, detail="at least one field param required")

    tables = await fetch_base_schema()
    assets_table = next((t for t in tables if t["name"] == config.tables["assets"]), None)
    if not assets_table:
        raise ValueError(f'Assets table "{config.tables["assets"]}" not found')

    field_defs = {f["name"]: f for f in assets_table["fields"] if f["name"] in field_names}

    linked_maps: dict = {}
    for name in field_names:
        fd = field_defs.get(name)
        if not fd or fd["type"] != "multipleRecordLinks":
            continue
        linked_table = next(
            (t for t in tables if t["id"] == fd.get("options", {}).get("linkedTableId")), None
        )
        if not linked_table:
            continue
        primary = linked_table["fields"][0]["name"] if linked_table["fields"] else "Name"
        recs = await select_all(linked_table["name"], {"fields": [primary]})
        linked_maps[name] = {r["id"]: r["fields"].get(primary, r["id"]) for r in recs}

    records = await select_all(config.tables["assets"], {"fields": field_names})

    def resolve_value(name: str, raw) -> Optional[str]:
        if raw is None:
            return None
        fd = field_defs.get(name)
        if not fd:
            return str(raw)
        t = fd["type"]
        if t == "singleSelect":
            return raw
        if t == "multipleSelects":
            return (raw[0] if isinstance(raw, list) else raw) if raw else None
        if t == "multipleRecordLinks":
            rid = raw[0] if isinstance(raw, list) else raw
            return linked_maps.get(name, {}).get(rid, rid) if rid else None
        v = raw[0] if isinstance(raw, list) else raw
        return str(v) if v is not None else None

    combo_counts: dict = {}
    for r in records:
        combo: dict = {}
        complete = True
        for name in field_names:
            val = resolve_value(name, r["fields"].get(name))
            if val is None:
                complete = False
                break
            combo[name] = val
        if not complete:
            continue
        key = "\x00".join(combo[f] for f in field_names)
        if key in combo_counts:
            combo_counts[key]["count"] += 1
        else:
            combo_counts[key] = {"values": combo, "count": 1}

    combinations = sorted(
        combo_counts.values(),
        key=lambda x: tuple(x["values"].get(f, "") for f in field_names),
    )
    return {"combinations": combinations}


@router.get("/matrix-table-pg")
async def get_matrix_table_pg(current_user: CurrentUser = Depends(require_studio)):
    studio_id = current_user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this user")

    # Fetch config, steps, dependencies, and matrix rows in parallel
    r_cfg, r_steps, r_matrix = await asyncio.gather(
        db_client.get(
            _url("/rest/v1/estimate_config"),
            params={"studio_id": f"eq.{studio_id}", "select": "variable_fields"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/workflow_steps"),
            params={"studio_id": f"eq.{studio_id}", "select": "id,name,craft"},
            headers=_headers(),
        ),
        db_client.get(
            _url("/rest/v1/estimate_matrix"),
            params={
                "studio_id": f"eq.{studio_id}",
                "select": "workflow_step_id,variable_values,estimate_days",
                "limit": "10000",
            },
            headers=_headers(),
        ),
    )

    cfg_rows = r_cfg.json()
    if not cfg_rows:
        return {"variableFields": [], "combinations": [], "tasks": [], "attributeFields": []}
    variable_fields = cfg_rows[0]["variable_fields"]

    steps = r_steps.json()
    step_by_id = {s["id"]: s for s in steps}

    # Dependencies (fetch only if steps exist)
    dep_names: dict = {s["id"]: [] for s in steps}
    if steps:
        ids_csv = ",".join(s["id"] for s in steps)
        r_deps = await db_client.get(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"step_id": f"in.({ids_csv})", "select": "step_id,depends_on_step_id"},
            headers=_headers(),
        )
        dep_graph = {s["id"]: [] for s in steps}
        for d in r_deps.json():
            dep_graph[d["step_id"]].append(d["depends_on_step_id"])
            dep_on = step_by_id.get(d["depends_on_step_id"])
            if dep_on:
                dep_names[d["step_id"]].append(dep_on["name"])
    else:
        dep_graph = {}

    # Topological sort (iterative post-order DFS)
    visited: set = set()
    sorted_ids: list = []
    for start in dep_graph:
        if start in visited:
            continue
        stack = [(start, False)]
        while stack:
            node, post = stack.pop()
            if post:
                sorted_ids.append(node)
                continue
            if node in visited:
                continue
            visited.add(node)
            stack.append((node, True))
            for nxt in dep_graph.get(node, []):
                if nxt not in visited:
                    stack.append((nxt, False))

    # Build step estimates: step_id → {combo_key → days}
    _DEFAULT_COL = "__default__"
    matrix_rows = r_matrix.json()
    step_estimates: dict = {}
    all_combo_keys: set = set()
    for row in matrix_rows:
        sid = row["workflow_step_id"]
        vv = row["variable_values"]
        key = _DEFAULT_COL if not vv else "|".join(str(vv.get(f, "")) for f in variable_fields)
        all_combo_keys.add(key)
        step_estimates.setdefault(sid, {})[key] = row["estimate_days"]

    regular_keys = sorted(k for k in all_combo_keys if k != _DEFAULT_COL)
    combinations = [
        {"key": k, "colName": k, "label": " | ".join(k.split("|"))}
        for k in regular_keys
    ]
    if _DEFAULT_COL in all_combo_keys:
        combinations.append({"key": "Default", "colName": _DEFAULT_COL, "label": "Default"})

    tasks = []
    for idx, step_id in enumerate(sorted_ids):
        s = step_by_id.get(step_id)
        if not s:
            continue
        linked_values = {}
        if s.get("craft"):
            linked_values["Craft"] = [s["craft"]]
        tasks.append({
            "id": step_id,
            "step": idx + 1,
            "name": s["name"],
            "linkedValues": linked_values,
            "dependsOn": dep_names.get(step_id, []),
            "estimates": step_estimates.get(step_id, {}),
        })

    attribute_fields = ["Craft"] if any(s.get("craft") for s in steps) else []
    return {
        "variableFields": variable_fields,
        "combinations": combinations,
        "tasks": tasks,
        "attributeFields": attribute_fields,
    }


@router.get("/matrix-table")
async def get_matrix_table():
    estimates_config = read_estimates_config()
    variable_fields = estimates_config.get("_variableFields", [])
    config_col_map = {
        col_name: key.replace("|", " | ")
        for key, col_name in estimates_config.items()
        if key not in _RESERVED_KEYS
    }

    DEP_FIELDS = {"Depends upon", "Depended upon"}
    tables = await fetch_base_schema()
    templates_schema = next((t for t in tables if t["name"] == config.tables["templates"]), None)
    linked_name_maps: dict = {}
    attribute_fields: list = []

    if templates_schema:
        for field in templates_schema["fields"]:
            if field["type"] != "multipleRecordLinks":
                continue
            linked_table = next(
                (t for t in tables if t["id"] == field.get("options", {}).get("linkedTableId")), None
            )
            if not linked_table:
                continue
            primary = linked_table["fields"][0]["name"] if linked_table["fields"] else "Name"
            recs = await select_all(linked_table["name"], {"fields": [primary]})
            linked_name_maps[field["name"]] = {r["id"]: r["fields"].get(primary, r["id"]) for r in recs}
            if field["name"] not in DEP_FIELDS:
                attribute_fields.append(field["name"])

    templates = await select_all(config.tables["templates"])
    template_name_map = {t["id"]: t["fields"].get("Task", t["id"]) for t in templates}

    def resolve_linked(raw, name_map: dict) -> list:
        if not raw or not isinstance(raw, list):
            return []
        result = []
        for l in raw:
            rid = l if isinstance(l, str) else (l.get("id") if isinstance(l, dict) else None)
            if rid:
                name = name_map.get(rid)
                if name:
                    result.append(name)
        return result

    task_graph: dict = {}
    for t in templates:
        followers = [
            (l if isinstance(l, str) else l.get("id"))
            for l in (t["fields"].get("Depended upon") or [])
            if (l if isinstance(l, str) else l.get("id"))
        ]
        task_graph[t["id"]] = followers

    visited: set = set()
    sorted_ids: list = []

    def visit(tid):
        if tid in visited:
            return
        visited.add(tid)
        for dep in task_graph.get(tid, []):
            visit(dep)
        sorted_ids.append(tid)

    for tid in task_graph:
        visit(tid)
    sorted_ids.reverse()

    SKIP_FIELDS = {"Task"} | DEP_FIELDS | set(attribute_fields)
    combinations = []
    if templates_schema:
        for field in templates_schema["fields"]:
            if field["name"] in SKIP_FIELDS:
                continue
            if field["type"] != "number" and field["name"] not in config_col_map:
                continue
            label = config_col_map.get(field["name"], field["name"])
            combinations.append({"key": label, "colName": field["name"], "label": label})
    if not combinations:
        for col_name, label in config_col_map.items():
            combinations.append({"key": label, "colName": col_name, "label": label})

    template_entries = {t["id"]: t for t in templates}
    col_names = [c["colName"] for c in combinations]

    tasks = []
    for idx, tid in enumerate(sorted_ids):
        t = template_entries.get(tid)
        if not t:
            continue
        depends_on = resolve_linked(t["fields"].get("Depends upon"), template_name_map)
        linked_values = {
            fname: resolve_linked(t["fields"].get(fname), linked_name_maps.get(fname, {}))
            for fname in attribute_fields
        }
        estimates = {
            col: t["fields"][col]
            for col in col_names
            if col in t["fields"] and t["fields"][col] is not None
        }
        tasks.append(
            {
                "id": tid,
                "step": idx + 1,
                "name": t["fields"].get("Task", "Untitled"),
                "linkedValues": linked_values,
                "dependsOn": depends_on,
                "estimates": estimates,
            }
        )

    return {
        "variableFields": variable_fields,
        "combinations": combinations,
        "tasks": tasks,
        "attributeFields": attribute_fields,
    }


class VariableFieldItem(BaseModel):
    field: str
    type: str


class CreateMatrixBody(BaseModel):
    variables: List[VariableFieldItem]
    combinations: List[dict]
    prefillCol: str = ""
    clearExisting: bool = False


@router.post("/create-matrix")
async def create_matrix(
    body: CreateMatrixBody,
    background_tasks: BackgroundTasks,
    _: CurrentUser = Depends(require_studio),
):
    variable_fields = sorted(v.field for v in body.variables)

    tables = await fetch_base_schema()
    templates_table = next((t for t in tables if t["name"] == config.tables["templates"]), None)
    if not templates_table:
        raise ValueError(f'Templates table "{config.tables["templates"]}" not found')

    existing_fields = {f["name"]: f for f in templates_table["fields"]}
    deleted = []

    if body.clearExisting:
        prev_config = read_estimates_config()
        prev_col_names = [v for k, v in prev_config.items() if k not in _RESERVED_KEYS]
        # Always resolve to current IDs from the live schema — stored _fieldIds can go stale
        # if fields were manually deleted/recreated since the last wizard run.
        for col_name in prev_col_names:
            field = existing_fields.get(col_name)
            if not field or not isinstance(field, dict) or "id" not in field:
                logger.info("clearExisting: %r not found in schema, skipping", col_name)
                continue
            try:
                await delete_field(templates_table["id"], field["id"])
                del existing_fields[col_name]
                deleted.append(col_name)
            except ValueError as e:
                logger.warning("delete_field(%s / %s) failed: %s", col_name, field["id"], e)

    created = []
    skipped = []
    config_map: dict = {}
    field_ids: list = []

    for combo in body.combinations:
        col_name = to_column_name(combo, variable_fields)
        config_key = to_config_key(combo, variable_fields)

        if col_name in existing_fields:
            existing = existing_fields[col_name]
            if isinstance(existing, dict) and "id" in existing:
                field_ids.append(existing["id"])
            skipped.append(col_name)
        else:
            new_field = await add_field_to_table(templates_table["id"], col_name, "number", {"precision": 1})
            field_ids.append(new_field["id"])
            created.append(col_name)
            existing_fields[col_name] = new_field

        config_map[config_key] = col_name

    config_obj = {"_variableFields": variable_fields, "_fieldIds": field_ids, **config_map}
    ESTIMATES_CONFIG_PATH.write_text(json.dumps(config_obj, indent=2), encoding="utf-8")

    target_cols = created + skipped
    has_prefill = bool(body.prefillCol and target_cols)

    if has_prefill:
        table_id = templates_table["id"]
        prefill_col = body.prefillCol
        delay_s = 2.0 if created else 0.0

        async def run_prefill():
            try:
                if delay_s:
                    await asyncio.sleep(delay_s)
                templates = await fetch_records_direct(table_id, [prefill_col])
                print(
                    f'[prefill] source="{prefill_col}" targets={len(target_cols)} templates={len(templates)}'
                )
                updates = []
                for tmpl in templates:
                    src_val = tmpl["fields"].get(prefill_col)
                    if src_val is None:
                        continue
                    fields = {col: src_val for col in target_cols}
                    updates.append({"id": tmpl["id"], "fields": fields})
                print(f"[prefill] sending {len(updates)} record updates")
                if updates:
                    await patch_records(table_id, updates)
                print("[prefill] done")
            except Exception as e:
                print(f"[prefill error] {e}")

        background_tasks.add_task(run_prefill)

    return {
        "templatesTable": templates_table["name"],
        "created": len(created),
        "skipped": len(skipped),
        "deleted": len(deleted),
        "prefillPending": has_prefill,
        "columns": created,
    }


@router.post("/create-matrix-pg")
async def create_matrix_pg(
    body: CreateMatrixBody,
    background_tasks: BackgroundTasks,
    current_user: CurrentUser = Depends(require_studio),
):
    """ArtHound-native estimation matrix stored in Postgres instead of Airtable columns."""
    studio_id = current_user.studio_id
    if not studio_id:
        raise HTTPException(status_code=403, detail="No studio linked to this user")

    variable_fields = sorted(v.field for v in body.variables)

    # 1. Clear existing matrix rows for this studio if requested (trivial in Postgres)
    if body.clearExisting:
        await db_client.delete(
            _url("/rest/v1/estimate_matrix"),
            params={"studio_id": f"eq.{studio_id}"},
            headers=_headers(),
        )

    # 2. Upsert estimate_config for this studio
    await db_client.post(
        _url("/rest/v1/estimate_config"),
        params={"on_conflict": "studio_id"},
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
        json={"studio_id": studio_id, "variable_fields": variable_fields},
    )

    # 3. Fetch Airtable templates (with string cell format for craft names)
    templates, templates_str = await asyncio.gather(
        select_all(config.tables["templates"]),
        select_all(config.tables["templates"], {
            "cellFormat": "string",
            "timeZone": "America/Los_Angeles",
            "userLocale": "en-us",
        }),
    )
    craft_name_by_template = {
        r["id"]: (r["fields"].get("Crafts") or "").split(",")[0].strip()
        for r in templates_str
    }

    # 4. Upsert workflow_steps from Airtable templates
    step_rows = [
        {
            "studio_id": studio_id,
            "name": t["fields"].get("Task") or "Untitled",
            "craft": craft_name_by_template.get(t["id"], ""),
            "airtable_template_id": t["id"],
        }
        for t in templates
    ]
    r = await db_client.post(
        _url("/rest/v1/workflow_steps"),
        params={"on_conflict": "studio_id,airtable_template_id"},
        headers=_headers({"Prefer": "resolution=merge-duplicates,return=representation"}),
        json=step_rows,
    )
    if not r.is_success:
        raise HTTPException(status_code=500, detail=f"Failed to upsert workflow_steps: {r.text}")

    workflow_steps = r.json()
    template_to_step_id = {row["airtable_template_id"]: row["id"] for row in workflow_steps}

    # 5. Sync workflow_step_dependencies from Airtable "Depends upon" field
    step_ids = [row["id"] for row in workflow_steps]
    if step_ids:
        # Clear stale deps for this studio's steps before reinserting
        ids_csv = ",".join(step_ids)
        await db_client.delete(
            _url("/rest/v1/workflow_step_dependencies"),
            params={"step_id": f"in.({ids_csv})"},
            headers=_headers(),
        )
        dep_rows = []
        for t in templates:
            step_id = template_to_step_id.get(t["id"])
            if not step_id:
                continue
            for l in (t["fields"].get("Depends upon") or []):
                dep_template_id = link_id(l)
                if not dep_template_id:
                    continue
                dep_step_id = template_to_step_id.get(dep_template_id)
                if dep_step_id:
                    dep_rows.append({"step_id": step_id, "depends_on_step_id": dep_step_id})
        if dep_rows:
            await db_client.post(
                _url("/rest/v1/workflow_step_dependencies"),
                params={"on_conflict": "step_id,depends_on_step_id"},
                headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
                json=dep_rows,
            )

    # 6. Upsert estimate_matrix rows: one per (workflow_step × active combo)
    active_combos = body.combinations
    matrix_rows = []
    for t in templates:
        step_id = template_to_step_id.get(t["id"])
        if not step_id:
            continue
        for combo in active_combos:
            variable_values = {f: combo["values"].get(f, {}).get("name", "") for f in variable_fields}
            matrix_rows.append({
                "studio_id": studio_id,
                "workflow_step_id": step_id,
                "variable_values": variable_values,
                "estimate_days": 0,
            })

    if matrix_rows:
        r = await db_client.post(
            _url("/rest/v1/estimate_matrix"),
            params={"on_conflict": "studio_id,workflow_step_id,variable_values"},
            headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            json=matrix_rows,
        )
        if not r.is_success:
            raise HTTPException(status_code=500, detail=f"Failed to upsert estimate_matrix: {r.text}")

    # Always upsert a Default row (variable_values={}) for every step — used as fallback
    # when no specific combination matches an asset. Existing values are preserved.
    default_rows = [
        {"studio_id": studio_id, "workflow_step_id": sid, "variable_values": {}, "estimate_days": 0}
        for sid in template_to_step_id.values()
    ]
    if default_rows:
        await db_client.post(
            _url("/rest/v1/estimate_matrix"),
            params={"on_conflict": "studio_id,workflow_step_id,variable_values"},
            headers=_headers({"Prefer": "resolution=ignore-duplicates,return=minimal"}),
            json=default_rows,
        )

    # 7. Prefill from existing Airtable column if requested
    prefill_pending = False
    if body.prefillCol and templates:
        prefill_pending = True

        async def run_pg_prefill():
            try:
                await asyncio.sleep(1.0)
                # Read Airtable template records with the prefill column value
                records = await select_all(config.tables["templates"], {"fields": ["Task", body.prefillCol]})
                updates = []
                for rec in records:
                    val = rec["fields"].get(body.prefillCol)
                    if val is None:
                        continue
                    step_id = template_to_step_id.get(rec["id"])
                    if not step_id:
                        continue
                    try:
                        days = float(val)
                    except (TypeError, ValueError):
                        continue
                    # Update all matrix rows for this step to the prefill value
                    await db_client.patch(
                        _url("/rest/v1/estimate_matrix"),
                        params={"studio_id": f"eq.{studio_id}", "workflow_step_id": f"eq.{step_id}"},
                        headers=_headers(),
                        json={"estimate_days": days},
                    )
                print(f"[pg-prefill] done, updated {len(records)} steps")
            except Exception as e:
                print(f"[pg-prefill error] {e}")

        background_tasks.add_task(run_pg_prefill)

    return {
        "stepsUpserted": len(step_rows),
        "matrixRows": len(matrix_rows),
        "cleared": body.clearExisting,
        "prefillPending": prefill_pending,
    }


class ImportCSVBody(BaseModel):
    headers: List[str]
    rows: List[List[str]]


@router.post("/import-csv")
async def import_csv(body: ImportCSVBody, _: CurrentUser = Depends(require_studio)):
    if not body.headers or not body.rows:
        raise HTTPException(status_code=400, detail="headers and rows are required")

    try:
        task_col_idx = body.headers.index("Task")
    except ValueError:
        raise HTTPException(status_code=400, detail='CSV must have a "Task" column')

    estimates_config = read_estimates_config()
    valid_cols = {v for k, v in estimates_config.items() if k not in _RESERVED_KEYS}

    col_map = [
        {"idx": i, "colName": h}
        for i, h in enumerate(body.headers)
        if i != task_col_idx and h in valid_cols
    ]

    templates = await select_all(config.tables["templates"])
    name_to_id = {
        t["fields"]["Task"]: t["id"] for t in templates if "Task" in t["fields"]
    }

    updates = []
    not_found = []
    cells_written = 0

    for row in body.rows:
        task_name = (row[task_col_idx] if task_col_idx < len(row) else "").strip()
        if not task_name:
            continue
        record_id = name_to_id.get(task_name)
        if not record_id:
            not_found.append(task_name)
            continue

        fields: dict = {}
        for item in col_map:
            raw = (row[item["idx"]] if item["idx"] < len(row) else "").strip()
            if not raw:
                continue
            try:
                fields[item["colName"]] = float(raw)
                cells_written += 1
            except ValueError:
                pass

        if fields:
            updates.append({"id": record_id, "fields": fields})

    if updates:
        await update_records(config.tables["templates"], updates)

    return {"updated": len(updates), "cellsWritten": cells_written, "notFound": not_found}


@router.get("/export-csv")
async def export_csv():
    estimates_config = read_estimates_config()
    col_entries = [(k, v) for k, v in estimates_config.items() if k not in _RESERVED_KEYS]
    if not col_entries:
        raise HTTPException(
            status_code=400,
            detail="No estimate columns configured — run the setup wizard first.",
        )

    col_names = [v for _, v in col_entries]
    templates = await select_all(config.tables["templates"])

    def cell(val) -> str:
        if val is None:
            return ""
        s = str(val)
        if "," in s or '"' in s or "\n" in s:
            return f'"{s.replace(chr(34), chr(34) + chr(34))}"'
        return s

    headers = ["Task"] + col_names
    rows = [
        [t["fields"].get("Task", "")] + [t["fields"].get(col, "") for col in col_names]
        for t in templates
        if t["fields"].get("Task")
    ]

    csv_content = "\r\n".join(",".join(cell(v) for v in row) for row in [headers] + rows)

    return Response(
        content=csv_content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="estimate-matrix.csv"'},
    )
