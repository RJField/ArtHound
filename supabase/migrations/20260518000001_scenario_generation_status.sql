-- Add generation_status text column to scenario_sessions.
-- Written by the generation engine at each major step so the frontend can show
-- per-step progress during the generating stage.
ALTER TABLE scenario_sessions ADD COLUMN IF NOT EXISTS generation_status TEXT;
