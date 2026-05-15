-- Add generation_mode and preflight_warnings to scenario_sessions.
-- generation_mode: 'ai' (default) or 'rule_based'
-- preflight_warnings: JSON array of warning objects written before generation,
--   e.g. [{"profile": "Hero|High", "issue": "no_steps"}]
-- craft_caps stays in scope_json — no extra column needed.

alter table scenario_sessions
  add column if not exists generation_mode text not null default 'ai'
    check (generation_mode in ('ai', 'rule_based')),
  add column if not exists preflight_warnings jsonb;
