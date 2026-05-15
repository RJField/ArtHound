# Scenario Planner

_Last updated: 2026-05-14_

The Scenario Planner lets studios model hypothetical production schedules — answering "when can we ship?" or "what if we aim for date X?" — without touching their source tool. It combines a scope-gathering conversation with Claude Haiku, a high-fidelity generation engine, and an interactive viewer for the resulting product/asset/work plan.

---

## Concepts

**Session** — the container for one planning run. Scoped to a user+studio pair. Only one active session per user at a time; starting a new one dismisses the previous.

**Scope** — the set of planning parameters that drive generation:

| Parameter | Type | Description |
|---|---|---|
| `scenario_category` | `earliest_ship` \| `target_date` | Schedule forward from today (derive completion) or backward from a target date |
| `target_date` | date string | Required for `target_date` category — the desired ship date for the final product |
| `release_cadence` | enum | `single_launch`, `regular_releases`, or `milestone_batched` |
| `num_products` | integer | Exact number of products/releases to generate |
| `distribution` | enum | How assets are spread: `even`, `front_loaded`, `back_loaded`, `milestone_batched` |
| `scale` | object | Exact asset count per classification profile (e.g. `{"Hero | High": 30, "Support | Low": 60}`) |
| `constraints` | string[] | Optional hard constraints (e.g. "no character work before March") |
| `craft_caps` | object | Optional per-craft concurrent-asset caps |

**Classification profile** — a label derived from the estimate matrix's variable value combinations (e.g. `Hero | High`). The scoping agent presents these using the studio's actual matrix profiles.

**Generation mode** — `ai` (Claude Sonnet multi-pass) or `rule_based` (deterministic, no AI calls). Both modes write to the same tables and produce the same output format.

**Scenario category — earliest_ship** — the engine schedules forward from today. Product release dates are computed and written back to `scenario_products` after work items are placed.

**Scenario category — target_date** — the engine schedules backward from the given target date. Feasibility is checked pre-generation and infeasible scenarios produce preflight warnings.

**Preflight warnings** — surface conditions that make a scenario unlikely to succeed before generation runs: sparse matrix cells, unreachable target dates given the work volume.

---

## Session Lifecycle

```
POST /api/scenario/start
  ├── Gate: estimate_matrix must exist
  ├── If active session exists → return it (resume)
  └── Create new session (ai_stage = "scoping")
            │
      User sends messages via POST /api/scenario/{id}/message
      Haiku asks clarifying questions, refines scope
            │
      Haiku calls submit_scope tool → ai_stage = "pending_generation"
            │
      Background loop (_scenario_generation_loop in main.py) picks up the session
      Runs generation (AI or rule-based) → writes scenario_products, scenario_assets, scenario_work
      ai_stage → "discussion"
            │
      User sends messages → discussion mode (Haiku answers questions about the generated plan)
            │
      DELETE /api/scenario/{id} → dismissed
```

**Force-generate escape hatch** — after turn 5, the frontend shows a "Generate with what I have" button. `POST /api/scenario/{id}/force-generate` extracts a partial scope from the conversation history (using a Haiku tool-forced call) and immediately advances to `pending_generation`. Useful when the user has given enough context but doesn't want to answer more questions.

**Retry** — if generation fails, `ai_stage = "generation_failed"`. `POST /api/scenario/{id}/retry-generation` resets to `pending_generation` without re-running the scoping phase.

---

## AI Scoping (Haiku)

During the `scoping` stage, Claude Haiku is prompted with:
- A full matrix summary (step × variable combination × estimate days) from the studio's data
- The list of profiles (unique classification combinations with at least one estimate > 0)
- The list of crafts from `workflow_steps`
- The chosen `scenario_category` (shapes the questions asked)

The model has a single tool available: `submit_scope` — a structured tool call that captures all required scope fields. Once the model calls it, the session advances to `pending_generation`.

At turn 8, the route forces `tool_choice = {type: "tool", name: "submit_scope"}` regardless of whether the model would have chosen it naturally, ensuring the scoping phase always terminates.

Prompt caching (`cache_control: {type: "ephemeral"}`) is applied to the system prompt to reduce latency on subsequent turns within the same scoping conversation.

---

## Generation Engine

Two engines, same output tables.

### Rule-based engine (`lib/scenario/deterministic.py`)

No AI calls. Four steps:

1. **Products** — generate product records from `num_products`, `release_cadence`, and `distribution` in scope
2. **Asset profiles** — map `scale` keys to estimate matrix profiles; resolve each profile's variable values; distribute assets across products per `distribution`
3. **Work templates** — for each profile, look up estimates per workflow step from the matrix; topologically sort steps; compute start/end dates respecting dependencies and optional `craft_caps`
4. **Product dates** (`earliest_ship` only) — derive and write back product release dates as the maximum work end date per product

**Craft caps** — `craft_caps: {"3D": 5}` means no more than 5 assets can have concurrent active 3D work. The engine uses a greedy scheduler that respects these caps when assigning work dates.

**Dependency-aware scheduling** — work start dates are pushed out to the latest end date of all prerequisite workflow steps, computed via a topological sort from `workflow_step_dependencies`.

### AI engine (`lib/scenario/generator.py`)

Uses Claude Sonnet (model configured in `generator.py`). Three generation passes:

1. **Products pass** — generates the product list with dates from scope
2. **Asset profiles pass** — generates classification profiles and their work templates
3. **Asset expansion** — expands profiles into individual assets and places them onto products

The AI engine is more flexible for unusual scope configurations; the rule-based engine is faster and fully deterministic.

Both engines use the same `shared.py` helpers for DB writes, profile normalization, and work date calculation.

---

## Session Stages

| Stage | Description |
|---|---|
| `scoping` | Haiku is gathering scope parameters |
| `pending_generation` | Scope locked; awaiting generation worker pick-up |
| `generating` | Generation worker is running |
| `discussion` | Generation complete; Haiku can answer questions about the plan |
| `generation_failed` | Generation threw an exception; retryable |
| `dismissed` | Session ended; returns 410 on access |

---

## Ephemeral Data Tables

Scenario data is ephemeral — it lives only for the life of the session. Dismissing a session doesn't immediately delete the rows; they remain queryable until a purge (future: background cleanup).

### `scenario_sessions`

```
id                uuid PK
studio_id         uuid → studios
user_id           uuid → auth.users
status            text (active | dismissed)
ai_stage          text (scoping | pending_generation | generating | discussion | generation_failed)
generation_mode   text (ai | rule_based)
scope_json        jsonb     (locked once pending_generation is set)
message_count     int
preflight_warnings jsonb[]  (array of {code, message} objects)
created_at, updated_at
```

### `scenario_messages`

```
session_id  uuid → scenario_sessions
studio_id   uuid → studios
role        text (user | assistant)
content     text
created_at
```

### `scenario_products`

```
session_id      uuid
studio_id       uuid
name            text
release_date    date
order_index     int
created_at
```

### `scenario_assets`

```
session_id      uuid
studio_id       uuid
product_id      uuid → scenario_products
name            text
profile_key     text (the matrix combo key)
variable_values jsonb
created_at
```

### `scenario_work`

```
session_id       uuid
studio_id        uuid
asset_id         uuid → scenario_assets
step_name        text
craft            text
estimate_days    numeric
start_date       date
end_date         date
created_at
```

---

## Wizard Mode (Rule-Based)

`POST /api/scenario/generate` is a separate direct-to-generation path: the wizard form (`ScenarioWizard.jsx`) collects scope parameters from the user directly (no chat), then posts a fully-formed scope body. Any active session for the user is dismissed first. The session is created in `pending_generation` immediately, bypassing the scoping stage.

`GET /api/scenario/wizard-data` returns the profiles and crafts the wizard needs to populate its dropdowns.

---

## Frontend

`ScenarioPlanner.jsx` routes between three components based on session state:

- **No session** → `ScenarioWizard` — form-based scope input; direct generation path
- **Session with scoping/generating stage** → `ScenarioChat` — conversation interface
- **Session with discussion/failed stage** → `ScenarioChat` (discussion) + `ScenarioViewer` (data)

`ScenarioViewer.jsx` renders a three-table read-only view of the generated plan: products list, assets list, and work list with timeline data.

**Deferred actions** — "Export to CSV" and "Write to Source" buttons appear in the action bar but are disabled (grey). Both are planned future features.

---

## API Reference

All endpoints are under `/api/scenario`. Studio-only.

| Method | Path | Description |
|---|---|---|
| POST | `/start` | Create or resume active session |
| GET | `/wizard-data` | Profiles + crafts for wizard form |
| POST | `/generate` | Direct generation with fully-formed scope (wizard path) |
| POST | `/{id}/message` | Send a message in scoping or discussion stage |
| POST | `/{id}/force-generate` | Skip remaining scoping; generate with partial scope |
| POST | `/{id}/retry-generation` | Retry after `generation_failed` |
| GET | `/{id}/data` | Session state, scope, and all generated rows |
| GET | `/{id}/messages` | Full message history |
| DELETE | `/{id}` | Dismiss session |

---

## Known Gaps

**Export and write-back deferred** — "Export to CSV" and "Write to Source" in the action bar are disabled. Exporting the scenario plan to a spreadsheet and writing it back to the studio's source tool are both planned but not yet built.

**No session history or comparison** — each session produces a fresh plan with no link to prior scenarios. Comparing two plan alternatives (what if we increase complexity? what if we add a product?) requires manually running two sessions and mentally diffing them.

**Discussion mode context** — the Haiku discussion prompt loads the generated data from the session tables. On very large scenarios (thousands of work rows), the context summary may be truncated.

**Rule-based craft cap implementation** — craft caps are applied greedily (first asset scheduled wins) without backtracking. A sub-optimal scheduling order early in the run can make some assets miss their target windows even when a valid schedule exists.
