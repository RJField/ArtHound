"""
Phase 0 backfill — patch app_metadata for all existing studio/vendor users.

Sets studio_id (for studio members) or vendor_id (for vendor members) so that
RLS policies can read these values from auth.jwt()->'app_metadata'.

Run once before enabling any RLS policies:
    python scripts/backfill_jwt_claims.py

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
"""

import asyncio
import os
import sys

from dotenv import load_dotenv
load_dotenv()

import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

db = httpx.AsyncClient(timeout=30.0)

HEADERS = {
    "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
    "apikey": SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
}


def _url(path: str) -> str:
    return f"{SUPABASE_URL}{path}"


async def fetch_all(table: str, select: str) -> list[dict]:
    r = await db.get(
        _url(f"/rest/v1/{table}"),
        params={"select": select},
        headers=HEADERS,
    )
    r.raise_for_status()
    return r.json()


async def patch_user(user_id: str, metadata: dict) -> None:
    r = await db.put(
        _url(f"/auth/v1/admin/users/{user_id}"),
        json={"app_metadata": metadata},
        headers=HEADERS,
    )
    if r.status_code not in (200, 204):
        print(f"  ERROR patching {user_id}: {r.status_code} {r.text}")
    else:
        print(f"  OK {user_id} → {metadata}")


async def main() -> None:
    studio_members = await fetch_all("studio_members", "user_id,studio_id")
    vendor_members = await fetch_all("vendor_members", "user_id,vendor_id")

    print(f"Found {len(studio_members)} studio member(s), {len(vendor_members)} vendor member(s)")

    # Users in multiple studios is not a supported case — last one wins.
    # Warn loudly if we see duplicates.
    studio_map: dict[str, str] = {}
    for row in studio_members:
        uid = row["user_id"]
        if uid in studio_map:
            print(f"  WARN: user {uid} appears in multiple studios — using last")
        studio_map[uid] = row["studio_id"]

    vendor_map: dict[str, str] = {}
    for row in vendor_members:
        uid = row["user_id"]
        if uid in vendor_map:
            print(f"  WARN: user {uid} appears in multiple vendors — using last")
        vendor_map[uid] = row["vendor_id"]

    print("\nPatching studio users...")
    for user_id, studio_id in studio_map.items():
        await patch_user(user_id, {"role": "studio", "studio_id": studio_id})

    print("\nPatching vendor users...")
    for user_id, vendor_id in vendor_map.items():
        await patch_user(user_id, {"role": "vendor", "vendor_id": vendor_id})

    print("\nDone. Decode a live JWT to verify claims before writing RLS policies.")


if __name__ == "__main__":
    asyncio.run(main())
