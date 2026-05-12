-- Singleton row for platform-level system settings.
-- RLS is enabled with no permissive policies, so anon/user JWTs cannot
-- access this table via PostgREST. The backend always reads/writes via
-- the service role key, which bypasses RLS.

CREATE TABLE IF NOT EXISTS system_settings (
  id                             boolean  PRIMARY KEY DEFAULT true CHECK (id = true),
  registration_invite_required   boolean  NOT NULL DEFAULT false,
  registration_invite_code       text,
  updated_at                     timestamptz DEFAULT now(),
  updated_by                     uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Insert the singleton row if it doesn't exist yet.
INSERT INTO system_settings DEFAULT VALUES ON CONFLICT DO NOTHING;

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION system_settings_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TRIGGER system_settings_updated_at
  BEFORE UPDATE ON system_settings
  FOR EACH ROW EXECUTE FUNCTION system_settings_touch_updated_at();
