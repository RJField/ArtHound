"""
Quick smoke test for the sync engine.
Run from the project root: python scripts/test_sync.py

Does NOT require the server to be running.
Reads credentials from .env (AIRTABLE_TOKEN, AIRTABLE_BASE_ID, SUPABASE_* vars).
"""
import asyncio
import sys
sys.path.insert(0, '.')

from dotenv import load_dotenv
load_dotenv()

from lib.canonical import get_studio_id
from lib.sync.runner import run_sync


async def main():
    print("--- ArtHound Sync Test ---\n")

    studio_id = await get_studio_id()
    print(f"Studio ID : {studio_id}")

    print("Running full sync (full=True ignores cursor, fetches everything)...\n")
    result = await run_sync(
        owner_type="studio",
        owner_id=studio_id,
        source_type="airtable",
        trigger="manual",
        full=True,
    )

    print(f"Result    : {result}")
    print("\nDone. Check Supabase Table Editor:")
    print("  • replicated_assets     — should have your assets")
    print("  • replicated_products   — should have your products")
    print("  • replicated_item_types — should have your item types")
    print("  • source_field_mappings — should have auto-generated slot mapping")
    print("  • sync_log              — should have one row with status=success")
    print("  • sync_cursors          — should have one row with last_synced_at set")


asyncio.run(main())
