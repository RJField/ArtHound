-- Migration: Scenario Planner
-- Five ephemeral tables for AI-powered scenario planning.
-- Fully isolated from the canonical layer — no FK or reference to canonical_assets.
-- Ghost data stays here until a future P→A→W write wizard decides otherwise.

-- ── scenario_sessions ────────────────────────────────────────────────────────
CREATE TABLE scenario_sessions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  studio_id     uuid        NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  user_id       uuid        NOT NULL,
  name          text,                          -- NULL = ephemeral; non-null = future saved scenario
  status        text        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'dismissed')),
  ai_stage      text        NOT NULL DEFAULT 'scoping'
                            CHECK (ai_stage IN (
                              'scoping',
                              'pending_generation',
                              'generating',
                              'discussion',
                              'generation_failed'
                            )),
  scope_json    jsonb,                         -- resolved submit_scope tool output
  message_count int         NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX scenario_sessions_studio_idx      ON scenario_sessions (studio_id);
CREATE INDEX scenario_sessions_stage_idx       ON scenario_sessions (ai_stage)
  WHERE status = 'active';                     -- loop only queries active sessions
CREATE INDEX scenario_sessions_expires_idx     ON scenario_sessions (expires_at);

-- ── scenario_messages ─────────────────────────────────────────────────────────
CREATE TABLE scenario_messages (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid        NOT NULL REFERENCES scenario_sessions(id) ON DELETE CASCADE,
  studio_id     uuid        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('user', 'assistant')),
  content       text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scenario_messages_session_idx ON scenario_messages (session_id, created_at);

-- ── scenario_products ─────────────────────────────────────────────────────────
CREATE TABLE scenario_products (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid        NOT NULL REFERENCES scenario_sessions(id) ON DELETE CASCADE,
  studio_id           uuid        NOT NULL,
  name                text        NOT NULL,
  target_release_date date,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scenario_products_session_idx ON scenario_products (session_id);

-- ── scenario_assets ───────────────────────────────────────────────────────────
-- variable_values keys must match estimate_config.variable_fields for the studio.
-- Validated at insert time in lib/scenario/generator.py — JSONB won't enforce this.
CREATE TABLE scenario_assets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES scenario_sessions(id) ON DELETE CASCADE,
  studio_id       uuid        NOT NULL,
  product_id      uuid        NOT NULL REFERENCES scenario_products(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  variable_values jsonb       NOT NULL DEFAULT '{}',
  priority        text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scenario_assets_session_idx  ON scenario_assets (session_id);
CREATE INDEX scenario_assets_product_idx  ON scenario_assets (product_id);

-- ── scenario_work ─────────────────────────────────────────────────────────────
CREATE TABLE scenario_work (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid        NOT NULL REFERENCES scenario_sessions(id) ON DELETE CASCADE,
  studio_id       uuid        NOT NULL,
  asset_id        uuid        NOT NULL REFERENCES scenario_assets(id) ON DELETE CASCADE,
  step_name       text        NOT NULL,
  craft           text,
  estimate_days   numeric,
  start_date      date,
  end_date        date,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX scenario_work_session_idx ON scenario_work (session_id);
CREATE INDEX scenario_work_asset_idx   ON scenario_work (asset_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE scenario_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_assets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_work     ENABLE ROW LEVEL SECURITY;

-- Studio members can access their own studio's scenario data.
-- Service role bypasses RLS for all backend writes.
CREATE POLICY "studio members" ON scenario_sessions FOR ALL TO authenticated
  USING (studio_id IN (
    SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "studio members" ON scenario_messages FOR ALL TO authenticated
  USING (studio_id IN (
    SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "studio members" ON scenario_products FOR ALL TO authenticated
  USING (studio_id IN (
    SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "studio members" ON scenario_assets FOR ALL TO authenticated
  USING (studio_id IN (
    SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "studio members" ON scenario_work FOR ALL TO authenticated
  USING (studio_id IN (
    SELECT studio_id FROM studio_members WHERE user_id = auth.uid()
  ));
