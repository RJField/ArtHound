"""
Jira connector — Cloud (OAuth 2.0 3LO) and Data Center.

Cloud:  hits api.atlassian.com/ex/jira/{cloud_id}/rest/api/3
DC:     hits {instance_url}/rest/api/2  (v2 for broadest DC compatibility)

Delta sync uses JQL updated >= cursor; full sync fetches all matching issues.
Deletion detection relies on the caller comparing returned IDs against the DB
(full sync) or on webhook events (delta) — see runner.py.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx

from lib.connectors.adapters.jira import JIRA_ARRAY_ITEM_CATEGORY, JIRA_FIELD_CATEGORY
from lib.sync.connector import BaseConnector, RawRecord, SchemaField

log = logging.getLogger(__name__)

_MAX_RESULTS   = 100
_MAX_RETRIES   = 3
_DEFAULT_RETRY_WAIT = 10  # seconds — used when Retry-After header is absent


def _iso_to_jql_datetime(iso: str) -> str:
    """
    Convert an ISO 8601 cursor timestamp to Jira JQL datetime format.
    Subtracts 1 minute as a buffer for clock skew and JQL minute-level precision.
    JQL format: 'yyyy-MM-dd HH:mm'
    """
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    dt = dt.astimezone(timezone.utc) - timedelta(minutes=1)
    return dt.strftime("%Y-%m-%d %H:%M")


def _normalize_field(f: dict) -> dict:
    """Convert a raw Jira field descriptor to ArtHound schema shape."""
    schema = f.get("schema") or {}
    field_type = schema.get("type", "string")
    items_type = schema.get("items")

    if field_type == "array" and items_type:
        category = JIRA_ARRAY_ITEM_CATEGORY.get(items_type, "other")
    else:
        category = JIRA_FIELD_CATEGORY.get(field_type, "other")

    return {
        "id":       f["id"],
        "name":     f.get("name", f["id"]),
        "type":     field_type,
        "category": category,
        "options": {
            "items":  items_type,
            "custom": schema.get("custom"),
            "system": schema.get("system"),
        },
    }


class JiraConnector(BaseConnector):
    def __init__(
        self,
        access_token: str,
        client: httpx.AsyncClient,
        cloud_id: str | None = None,
        deployment: str = "cloud",
        instance_url: str | None = None,
    ):
        self._token = access_token
        self._client = client
        self._deployment = deployment

        if deployment == "datacenter":
            if not instance_url:
                raise ValueError("instance_url is required for Data Center deployment")
            self._base = f"{instance_url.rstrip('/')}/rest/api/2"
            self._search_endpoint = "search"          # v2 still uses /search
        else:
            if not cloud_id:
                raise ValueError("cloud_id is required for Cloud deployment")
            self._base = f"https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3"
            self._search_endpoint = "search/jql"      # v3 removed /search; use /search/jql

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept":        "application/json",
        }

    async def _get_with_retry(self, url: str, **kwargs) -> httpx.Response:
        """GET with exponential back-off on 429. Used for single-resource endpoints."""
        for attempt in range(_MAX_RETRIES):
            r = await self._client.get(url, headers=self._headers(), **kwargs)
            if r.status_code != 429:
                return r
            wait = int(r.headers.get("Retry-After", _DEFAULT_RETRY_WAIT))
            log.warning("Jira 429 on GET %s — retrying in %ds (attempt %d)", url, wait, attempt + 1)
            await asyncio.sleep(wait)
        return r  # return last response; caller raises on error

    # ── internal search ────────────────────────────────────────────────────────

    async def _post_search(self, body: dict) -> httpx.Response:
        """POST to the search endpoint with 429 retry."""
        for attempt in range(_MAX_RETRIES):
            r = await self._client.post(
                f"{self._base}/{self._search_endpoint}",
                headers=self._headers(),
                json=body,
            )
            if r.status_code != 429:
                return r
            wait = int(r.headers.get("Retry-After", _DEFAULT_RETRY_WAIT))
            log.warning("Jira 429 on search — retrying in %ds (attempt %d)", wait, attempt + 1)
            await asyncio.sleep(wait)
        return r

    async def _search(
        self,
        jql: str,
        since: str | None = None,
        max_records: int | None = None,
    ) -> list[dict]:
        """
        Paginated JQL search. Appends updated >= cursor when since is provided.

        Cloud (v3 /search/jql): cursor-based pagination via nextPageToken.
        DC    (v2 /search):     offset-based pagination via startAt + total.
        """
        if since:
            jql = f"({jql}) AND updated >= \"{_iso_to_jql_datetime(since)}\" ORDER BY updated ASC"

        issues: list[dict] = []

        if self._search_endpoint == "search/jql":
            # Cloud v3 — cursor-based pagination
            next_page_token: str | None = None
            while True:
                body: dict = {"jql": jql, "maxResults": _MAX_RESULTS, "fields": ["*all"]}
                if next_page_token:
                    body["nextPageToken"] = next_page_token

                r = await self._post_search(body)
                r.raise_for_status()
                data  = r.json()
                batch = data.get("issues", [])
                issues.extend(batch)

                next_page_token = data.get("nextPageToken")
                if not batch or not next_page_token:
                    break
                if max_records and len(issues) >= max_records:
                    break
        else:
            # DC v2 — offset-based pagination
            start = 0
            while True:
                r = await self._post_search({
                    "jql":        jql,
                    "startAt":    start,
                    "maxResults": _MAX_RESULTS,
                    "fields":     ["*all"],
                })
                r.raise_for_status()
                data  = r.json()
                batch = data.get("issues", [])
                issues.extend(batch)

                total  = data.get("total", 0)
                start += len(batch)
                if not batch or start >= total:
                    break
                if max_records and len(issues) >= max_records:
                    break

        if max_records and len(issues) > max_records:
            issues = issues[:max_records]
        return issues

    def _to_raw_record(
        self, issue: dict, excluded_field_ids: set[str] | None = None
    ) -> RawRecord:
        fields = issue.get("fields") or {}
        merged = {
            **fields,
            "_jira_key":  issue.get("key"),
            "_jira_self": issue.get("self"),
        }
        if excluded_field_ids:
            merged = {k: v for k, v in merged.items() if k not in excluded_field_ids}
        return RawRecord(
            source_record_id=str(issue["id"]),
            fields=merged,
            source_last_modified_at=fields.get("updated"),
        )

    # ── BaseConnector interface ────────────────────────────────────────────────

    async def fetch_single_asset(
        self,
        source_record_id: str,
        table_id: str | None = None,
        excluded_field_ids: set[str] | None = None,
    ) -> RawRecord | None:
        r = await self._get_with_retry(
            f"{self._base}/issue/{source_record_id}",
            params={"fields": "*all"},
        )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return self._to_raw_record(r.json(), excluded_field_ids)

    async def fetch_assets(self, since: str | None = None) -> list[RawRecord]:
        """Fallback: fetch all issues across all projects. Use fetch_entity when entity defs exist."""
        log.warning("JiraConnector.fetch_assets called without entity defs — no project filter applied")
        issues = await self._search("ORDER BY updated ASC", since)
        return [self._to_raw_record(i) for i in issues]

    async def fetch_products(self) -> list[RawRecord]:
        """Fetch all Jira projects as product records."""
        r = await self._get_with_retry(
            f"{self._base}/project/search",
            params={"maxResults": 100, "expand": "description"},
        )
        r.raise_for_status()
        projects = r.json().get("values", [])
        return [
            RawRecord(
                source_record_id=p["id"],
                fields={
                    "name":        p.get("name", ""),
                    "key":         p.get("key", ""),
                    "description": p.get("description") or "",
                    "projectType": p.get("projectTypeKey", ""),
                },
            )
            for p in projects
        ]

    async def fetch_item_types(self) -> list[RawRecord]:
        """Fetch all Jira issue types as item-type records."""
        r = await self._get_with_retry(f"{self._base}/issuetype")
        r.raise_for_status()
        return [
            RawRecord(
                source_record_id=t["id"],
                fields={
                    "name":           t.get("name", ""),
                    "description":    t.get("description") or "",
                    "subtask":        t.get("subtask", False),
                    "hierarchyLevel": t.get("hierarchyLevel"),
                },
            )
            for t in r.json()
        ]

    async def fetch_entity(
        self,
        table_id: str,
        filter_formula: str | None = None,
        since: str | None = None,
        max_records: int | None = None,
        excluded_field_ids: set[str] | None = None,
    ) -> list[RawRecord]:
        """
        Fetch issues by JQL. filter_formula is treated as a JQL expression.
        table_id is used only as a fallback project filter when filter_formula is absent.

        excluded_field_ids: field IDs/names to strip from returned records (v1: client-side
        filter; v2 will push these to the Jira fields= request parameter instead).
        """
        jql = filter_formula or f'project = "{table_id}"'
        issues = await self._search(jql, since, max_records)
        return [self._to_raw_record(i, excluded_field_ids) for i in issues]

    async def fetch_base_schema(self) -> list[dict]:
        """
        Return all Jira projects, each with the full global field list and available
        issue types. Shape mirrors Airtable's [{id, name, fields, issue_types}].
        """
        fields_r, projects_r, types_r = await asyncio.gather(
            self._get_with_retry(f"{self._base}/field"),
            self._get_with_retry(
                f"{self._base}/project/search",
                params={"maxResults": 100},
            ),
            self._get_with_retry(f"{self._base}/issuetype"),
        )
        fields_r.raise_for_status()
        projects_r.raise_for_status()
        types_r.raise_for_status()

        normalized_fields = [_normalize_field(f) for f in fields_r.json()]
        issue_types = [{"id": t["id"], "name": t["name"]} for t in types_r.json()]

        return [
            {
                "id":          p["key"],   # key used as ID for JQL compatibility
                "name":        p["name"],
                "fields":      normalized_fields,
                "issue_types": issue_types,
            }
            for p in projects_r.json().get("values", [])
        ]

    async def fetch_asset_schema(self, table_id: str | None = None) -> list[SchemaField]:
        """
        Return schema for all Jira fields. table_id is accepted but unused —
        Jira fields are global across an instance.
        """
        r = await self._get_with_retry(f"{self._base}/field")
        r.raise_for_status()
        return [
            SchemaField(
                id=n["id"],
                name=n["name"],
                type=n["type"],
                category=n["category"],
                options=n["options"],
            )
            for n in (_normalize_field(f) for f in r.json())
        ]

    async def create_issue_link(
        self,
        link_type: str,
        inward_key: str,
        outward_key: str,
    ) -> None:
        """Create a named link between two issues (e.g. 'Relates' inward←outward).
        Raises RuntimeError on failure."""
        r = await self._client.post(
            f"{self._base}/issueLink",
            headers={**self._headers(), "Content-Type": "application/json"},
            json={
                "type":         {"name": link_type},
                "inwardIssue":  {"key": inward_key},
                "outwardIssue": {"key": outward_key},
            },
        )
        if not r.is_success:
            raise RuntimeError(f"Jira create_issue_link failed ({r.status_code}): {r.text}")

    async def fetch_project_issue_types(self, project_key: str) -> list[str]:
        """Return non-subtask issue type names available for the given project."""
        r = await self._get_with_retry(f"{self._base}/project/{project_key}")
        if not r.is_success:
            log.warning("Jira: could not fetch issue types for project %s (%s)", project_key, r.status_code)
            return []
        return [
            it["name"]
            for it in r.json().get("issueTypes", [])
            if not it.get("subtask", False)
        ]

    async def create_issue(self, fields: dict, qualifier_defaults: dict) -> str:
        """
        Create a Jira issue and return the new issue ID (numeric string).

        qualifier_defaults (from lib.sync.qualifiers.jira_write_defaults) are merged
        under fields so explicit field values always win:
            effective = {**qualifier_defaults, **fields}

        Callers must NOT pre-merge qualifier_defaults into fields — this method is the
        sole merge site. Pass raw fields and the defaults dict separately.
        """
        _SERVER_ERROR = {500, 502, 503, 504}
        effective_fields = {**qualifier_defaults, **fields}
        r = None
        for attempt in range(_MAX_RETRIES):
            try:
                r = await self._client.post(
                    f"{self._base}/issue",
                    headers={**self._headers(), "Content-Type": "application/json"},
                    json={"fields": effective_fields},
                )
            except httpx.TransportError as exc:
                log.warning("Jira create_issue network error (attempt %d/%d): %s", attempt + 1, _MAX_RETRIES, exc)
                r = None
                if attempt + 1 < _MAX_RETRIES:
                    await asyncio.sleep(_DEFAULT_RETRY_WAIT)
                continue
            if r.status_code == 429:
                wait = int(r.headers.get("Retry-After", _DEFAULT_RETRY_WAIT))
                log.warning("Jira 429 on create_issue — retrying in %ds (attempt %d)", wait, attempt + 1)
                await asyncio.sleep(wait)
                continue
            if r.status_code in _SERVER_ERROR:
                log.warning("Jira %s on create_issue — retrying in %ds (attempt %d)", r.status_code, _DEFAULT_RETRY_WAIT, attempt + 1)
                await asyncio.sleep(_DEFAULT_RETRY_WAIT)
                continue
            break

        if r is None:
            raise RuntimeError("Jira create_issue failed: exhausted retries on network error")
        if not r.is_success:
            raise RuntimeError(f"Jira create_issue failed ({r.status_code}): {r.text}")
        return r.json()["id"]

    def build_entity_filter(self, entity_def: dict) -> str | None:
        """
        Return a JQL string for this entity definition.
        Prefers jql_filter (set by init wizard) over a basic project filter.
        """
        if not entity_def:
            return None
        jql = entity_def.get("jql_filter")
        if jql:
            return jql
        table_id = entity_def.get("table_id")
        if table_id:
            return f'project = "{table_id}"'
        return None
