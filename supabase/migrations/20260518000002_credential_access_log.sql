-- Audit log for source credential access.
-- Records every call to _get_credentials / get_studio_airtable_creds.
-- user_id is NULL for background/system access (sync runner, attachment drain, etc.).

CREATE TABLE credential_access_log (
    id          uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id     uuid,                           -- NULL = background/system
    owner_type  text        NOT NULL,           -- 'studio' | 'vendor'
    owner_id    uuid        NOT NULL,
    source_type text        NOT NULL,           -- 'airtable' | 'jira'
    accessed_at timestamptz NOT NULL DEFAULT now()
);

-- "Who accessed studio X's credentials recently?"
CREATE INDEX credential_access_log_owner_idx
    ON credential_access_log (owner_type, owner_id, accessed_at DESC);

-- "What credentials has user Y accessed?"
CREATE INDEX credential_access_log_user_idx
    ON credential_access_log (user_id, accessed_at DESC)
    WHERE user_id IS NOT NULL;
