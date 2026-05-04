import os
import httpx

db_client = httpx.AsyncClient(
    timeout=10.0,
    limits=httpx.Limits(max_keepalive_connections=5, max_connections=10),
)


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
