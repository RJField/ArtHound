import os
import httpx

db_client = httpx.AsyncClient(
    timeout=30.0,
    limits=httpx.Limits(max_keepalive_connections=10, max_connections=25, keepalive_expiry=30.0),
)

_PAGE = 200


async def drain_pages(url: str, params: dict, page: int = _PAGE) -> list[dict]:
    """Collect all rows from a PostgREST endpoint using limit/offset pagination."""
    rows: list[dict] = []
    offset = 0
    while True:
        r = await db_client.get(
            url,
            params={**params, "limit": page, "offset": offset},
            headers=_headers(),
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < page:
            break
        offset += len(batch)
    return rows


def _url(path: str) -> str:
    return f"{os.environ['SUPABASE_URL']}{path}"


def _headers(extra: dict = {}) -> dict:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
        **extra,
    }


def _user_headers(jwt: str, extra: dict = {}) -> dict:
    anon_key = os.environ["SUPABASE_ANON_KEY"]
    return {
        "Authorization": f"Bearer {jwt}",
        "apikey": anon_key,
        "Content-Type": "application/json",
        **extra,
    }
