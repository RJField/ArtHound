-- Job queue for copy-on-dispatch attachment processing.
-- Worker drains this table; dispatch endpoint inserts pending rows.
CREATE TABLE attachment_copy_jobs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID        NOT NULL REFERENCES payload_dispatches(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts    INT         NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX attachment_copy_jobs_status_created
  ON attachment_copy_jobs(status, created_at);

-- Reverse index: which dispatches reference each content-addressed blob.
-- Used for lifecycle: revoke dispatch → delete its refs → delete orphaned hashes.
CREATE TABLE attachment_refs (
  content_hash TEXT NOT NULL,
  dispatch_id  UUID NOT NULL REFERENCES payload_dispatches(id) ON DELETE CASCADE,
  PRIMARY KEY (content_hash, dispatch_id)
);

CREATE INDEX attachment_refs_dispatch
  ON attachment_refs(dispatch_id);
