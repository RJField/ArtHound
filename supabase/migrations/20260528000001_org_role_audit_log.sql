-- Audit log for org-level privilege changes.
-- Records role changes, membership additions/removals, and invite code regenerations.
-- Access is service-role only; the API layer enforces admin-only reads.

CREATE TABLE org_role_audit_log (
    id              uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    org_type        text        NOT NULL CHECK (org_type IN ('studio', 'vendor')),
    org_id          uuid        NOT NULL,
    actor_id        uuid        NOT NULL,   -- user who performed the action
    target_user_id  uuid,                   -- affected member; NULL for invite_code_regenerated
    action          text        NOT NULL,   -- see values below
    old_role        text,                   -- previous role; NULL if not applicable
    new_role        text,                   -- new role; NULL for removals/declines
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- Action values:
--   member_accepted          join request accepted; new_role = 'user'
--   member_declined          join request declined
--   role_changed             admin <-> user promotion/demotion
--   ownership_transferred    ownership transferred to target
--   member_removed           member removed from org; old_role = their previous role
--   invite_code_regenerated  invite code regenerated; no target_user_id

-- "Recent activity for this org"
CREATE INDEX org_role_audit_log_org_idx
    ON org_role_audit_log (org_type, org_id, created_at DESC);

-- "What did actor X do?"
CREATE INDEX org_role_audit_log_actor_idx
    ON org_role_audit_log (actor_id, created_at DESC);
