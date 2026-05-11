-- On write-phase failure the cursor is not advanced, so the next sync retries
-- from the same point. This flag forces that retry to run as a full sync
-- (bypasses the hash-based differ entirely) so partial writes can't persist
-- through a stale hash comparison edge case.
ALTER TABLE sync_cursors
    ADD COLUMN IF NOT EXISTS force_full_resync BOOLEAN NOT NULL DEFAULT FALSE;
