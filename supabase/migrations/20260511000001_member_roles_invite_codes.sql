-- Migration: member roles + invite codes
-- Adds per-member privilege level (owner/admin/user) to studio_members and vendor_members,
-- and a unique invite code to each org used for the join-request flow.

-- ── Invite code generator ────────────────────────────────────────────────────
-- Uses pg's random() seeded per-call. Not cryptographically perfect but
-- collision probability is negligible at org counts we'll ever reach.
CREATE OR REPLACE FUNCTION generate_invite_code() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(
    substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ceil(random() * 36)::int, 1),
    ''
  )
  FROM generate_series(1, 8);
$$;

-- ── studios ──────────────────────────────────────────────────────────────────
ALTER TABLE studios ADD COLUMN IF NOT EXISTS invite_code text UNIQUE;
UPDATE studios SET invite_code = generate_invite_code() WHERE invite_code IS NULL;
ALTER TABLE studios ALTER COLUMN invite_code SET NOT NULL;

-- ── vendors ──────────────────────────────────────────────────────────────────
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS invite_code text UNIQUE;
UPDATE vendors SET invite_code = generate_invite_code() WHERE invite_code IS NULL;
ALTER TABLE vendors ALTER COLUMN invite_code SET NOT NULL;

-- ── studio_members ───────────────────────────────────────────────────────────
ALTER TABLE studio_members
  ADD COLUMN IF NOT EXISTS member_role text NOT NULL DEFAULT 'user'
  CHECK (member_role IN ('owner', 'admin', 'user'));

-- All existing members were the founding user — backfill as owner.
UPDATE studio_members SET member_role = 'owner';

-- ── vendor_members ───────────────────────────────────────────────────────────
ALTER TABLE vendor_members
  ADD COLUMN IF NOT EXISTS member_role text NOT NULL DEFAULT 'user'
  CHECK (member_role IN ('owner', 'admin', 'user'));

UPDATE vendor_members SET member_role = 'owner';

-- ── RLS: expose invite_code only to org members ──────────────────────────────
-- studios and vendors currently have RLS enabled (from rls_expand migration).
-- invite_code is a named column — existing policies allow authenticated reads
-- for members. No additional policy needed; service role handles all backend writes.

-- ── Ownership transfer — atomic RPC ─────────────────────────────────────────
-- Called by PATCH /api/org/members/{user_id}/role when {role: "owner"}.
-- Single transaction: promotes target to owner, demotes current owner to admin.
CREATE OR REPLACE FUNCTION transfer_org_ownership(
  p_org_type   text,
  p_org_id     uuid,
  p_current_owner_id uuid,
  p_new_owner_id     uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_org_type = 'studio' THEN
    UPDATE studio_members SET member_role = 'owner'
      WHERE studio_id = p_org_id AND user_id = p_new_owner_id;
    UPDATE studio_members SET member_role = 'admin'
      WHERE studio_id = p_org_id AND user_id = p_current_owner_id;
  ELSIF p_org_type = 'vendor' THEN
    UPDATE vendor_members SET member_role = 'owner'
      WHERE vendor_id = p_org_id AND user_id = p_new_owner_id;
    UPDATE vendor_members SET member_role = 'admin'
      WHERE vendor_id = p_org_id AND user_id = p_current_owner_id;
  ELSE
    RAISE EXCEPTION 'Unknown org type: %', p_org_type;
  END IF;
END;
$$;
