-- Migration: studio_join_requests + vendor_join_requests
-- Stores pending membership requests created when a user signs up with an invite code.
-- Partial unique index on (org_id, user_id) WHERE status='pending' means a declined
-- user can re-request without manual DB intervention.

CREATE TABLE studio_join_requests (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id   uuid        NOT NULL REFERENCES studios(id)     ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid        REFERENCES auth.users(id)
  -- resolved_by records the auth user ID of the admin who accepted/declined.
  -- If that admin is later removed from the org the audit record is preserved.
  -- The role held at resolution time is NOT recorded (known limitation, P4 work).
);

CREATE UNIQUE INDEX studio_join_requests_pending_unique
  ON studio_join_requests (studio_id, user_id)
  WHERE status = 'pending';

CREATE INDEX studio_join_requests_studio_idx ON studio_join_requests (studio_id, status);
CREATE INDEX studio_join_requests_user_idx   ON studio_join_requests (user_id);


CREATE TABLE vendor_join_requests (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   uuid        NOT NULL REFERENCES vendors(id)     ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES auth.users(id)  ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid        REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX vendor_join_requests_pending_unique
  ON vendor_join_requests (vendor_id, user_id)
  WHERE status = 'pending';

CREATE INDEX vendor_join_requests_vendor_idx ON vendor_join_requests (vendor_id, status);
CREATE INDEX vendor_join_requests_user_idx   ON vendor_join_requests (user_id);


-- ── RLS ──────────────────────────────────────────────────────────────────────
-- All backend writes use the service role and bypass RLS.
-- These policies cover direct PostgREST client access (e.g. future mobile clients).

ALTER TABLE studio_join_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_join_requests ENABLE ROW LEVEL SECURITY;

-- Users can see their own requests.
CREATE POLICY "sjr_own_select" ON studio_join_requests
  FOR SELECT USING (auth.uid() = user_id);

-- Studio admins/owners can see all requests for their studio.
CREATE POLICY "sjr_admin_select" ON studio_join_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM studio_members sm
      WHERE sm.studio_id = studio_join_requests.studio_id
        AND sm.user_id = auth.uid()
        AND sm.member_role IN ('owner', 'admin')
    )
  );

-- Users may insert their own join request (backend enforces invite code validity).
CREATE POLICY "sjr_user_insert" ON studio_join_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Admins/owners may update (accept or decline) requests for their studio.
CREATE POLICY "sjr_admin_update" ON studio_join_requests
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM studio_members sm
      WHERE sm.studio_id = studio_join_requests.studio_id
        AND sm.user_id = auth.uid()
        AND sm.member_role IN ('owner', 'admin')
    )
  );

-- Mirror policies for vendor_join_requests.
CREATE POLICY "vjr_own_select" ON vendor_join_requests
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "vjr_admin_select" ON vendor_join_requests
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM vendor_members vm
      WHERE vm.vendor_id = vendor_join_requests.vendor_id
        AND vm.user_id = auth.uid()
        AND vm.member_role IN ('owner', 'admin')
    )
  );

CREATE POLICY "vjr_user_insert" ON vendor_join_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "vjr_admin_update" ON vendor_join_requests
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM vendor_members vm
      WHERE vm.vendor_id = vendor_join_requests.vendor_id
        AND vm.user_id = auth.uid()
        AND vm.member_role IN ('owner', 'admin')
    )
  );
