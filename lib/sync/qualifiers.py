import logging
import re

log = logging.getLogger(__name__)

_ISSUETYPE_RE = re.compile(r'issuetype\s*=\s*["\']?([^"\')\s,]+)["\']?', re.IGNORECASE)


def airtable_write_defaults(filters: list[dict]) -> dict:
    """
    Derive {field_name: value} injection pairs from an entity's eq-operator filters.

    Pass the returned dict as qualifier_defaults to create_record() — the connector
    merges it under explicit fields so user-mapped values always win. Do NOT
    pre-merge into fields before calling; the connector is the sole merge site.

    Non-eq operators (neq, contains) are logged and skipped — no safe default to
    inject. Use airtable_qualifier_gaps() to surface skipped filters in API responses.

    Gracefully skips any filter entry missing a field_name key.
    """
    defaults = {}
    for f in filters or []:
        name = f.get("field_name")
        if not name:
            log.warning("qualifiers: filter entry missing field_name — skipping: %s", f)
            continue
        op = f.get("operator", "eq")
        if op == "eq":
            defaults[name] = f.get("value", "")
        else:
            log.warning(
                "qualifiers: skipping non-eq filter '%s %s %s' — no safe write default",
                name, op, f.get("value"),
            )
    return defaults


def airtable_qualifier_gaps(
    filters: list[dict],
    source_tool: str = "your source tool",
) -> list[str]:
    """
    Return actionable warning strings for filters that cannot be auto-injected on write.

    Include these in API response bodies — studio admins won't read server logs.
    An empty list means all qualifiers will be satisfied on the created record.
    """
    gaps = []
    for f in filters or []:
        name = f.get("field_name")
        if not name:
            continue
        op = f.get("operator", "eq")
        if op != "eq":
            gaps.append(
                f"'{name}' uses a '{op}' filter and cannot be auto-set on new records. "
                f"Set '{name}' manually in {source_tool} after the record is created, "
                f"or switch this filter to an 'eq' rule so ArtHound can inject it."
            )
    return gaps


def jira_write_defaults(
    jql_filter: str | None,
    filters: list[dict] | None = None,
) -> dict:
    """
    Derive Jira issue field defaults from a JQL string, with JSONB filters as fallback.

    Resolution order:
      1. 'issuetype = X' pattern in jql_filter
      2. JSONB filters entry where field_name/field_id contains 'issuetype' and operator = 'eq'
      3. Empty dict (logged as warning if jql_filter was provided but unparseable)

    project.key is always set separately from table_id by callers — not returned here.

    Pass the returned dict as qualifier_defaults to create_issue(). The connector
    merges it under explicit fields so caller-set values always win. Do NOT
    pre-merge into fields before calling; the connector is the sole merge site.
    """
    m = _ISSUETYPE_RE.search(jql_filter or "")
    if m:
        return {"issuetype": {"name": m.group(1)}}

    for f in filters or []:
        field_ref = (f.get("field_name") or f.get("field_id") or "").lower()
        if f.get("operator") == "eq" and "issuetype" in field_ref:
            return {"issuetype": {"name": f.get("value")}}

    if jql_filter:
        log.warning(
            "qualifiers: could not extract issuetype from jql_filter '%s' — skipping",
            jql_filter,
        )
    return {}
