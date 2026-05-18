# Scenario Planner

_Last updated: 2026-05-17_

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
| `release_interval_days` | integer | Explicit spacing between releases (overrides horizon-derived spacing) |
| `distribution` | enum | How assets are spread: `even`, `front_loaded`, `back_loaded`, `milestone_batched` |
| `scale` | object | Exact asset count per classification profile (e.g. `{"Hero | High": 30, "Support | Low": 60}`) |
| `craft_caps` | object | Optional per-craft concurrent-asset caps (e.g. `{"3D": 5, "2D": 8}`) |
| `constraints` | string[] | Optional hard constraints (e.g. "no character work before March") |

**Classification profile** — a label derived from the estimate matrix's variable value combinations (e.g. `Hero | High`). The scoping agent presents these using the studio's actual matrix profiles.

**Generation mode** — `ai` (Claude Sonnet multi-pass) or `rule_based` (deterministic, no AI calls). Both modes write to the same tables and produce the same output format.

**Scenario category — earliest_ship** — the engine schedules forward from today. Product release dates are computed and written back to `scenario_products` after work items are placed.

**Scenario category — target_date** — the engine schedules backward from the given target date. Feasibility is checked pre-generation and infeasible profiles produce preflight warnings.

**Preflight warnings** — conditions surfaced before generation that make a scenario unlikely to succeed: sparse matrix cells (a profile has no steps with estimates), or unreachable target dates given the critical-path length of a profile's workflow.

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

## Generation Engines

Two engines, same output tables.

### Rule-based engine (`lib/scenario/deterministic.py`)

No AI calls. Every planning decision is a pure function of `(scope, matrix, workflow_graph)`. Fully reproducible given the same inputs.

**Entry point:** `run_rule_based_generation(session_id, studio_id, scope)`

**Step 1 — Products**

Generates `num_products` records with cadence-aware names and release dates spaced by `release_interval_days` (or derived from `horizon_months` / `target_date`):

- `single_launch` → "Launch"
- `regular_releases`, interval ≥80 days → quarterly labels ("Q3 '26")
- `regular_releases`, interval ≥25 days → monthly labels ("Jun '26")
- `regular_releases`, shorter → "Sprint N"
- `milestone_batched`, n=3 → "Alpha / Beta / Gold"; n=4 → adds "Live"

For `earliest_ship` with no interval, product dates are left `NULL` and written back after scheduling.

**Step 2 — Asset profiles**

Maps each `scope.scale` label (e.g. `"Hero | High"`) to its matrix combo key, reconstructs `variable_values` from the key, and validates against known combo keys. A count normalisation pass corrects rounding drift so total asset count matches exactly.

**Step 2.5 — Preflight checks**

Two checks before any assets or work are written:

- **Matrix sparsity** — if a requested profile has no steps with `estimate_days > 0`, a warning is appended to `scenario_sessions.preflight_warnings`.
- **Target date feasibility** — for `target_date` mode, the critical path length of each profile's workflow DAG is computed and compared against the available days. Profiles whose critical path exceeds the window produce an `infeasible_timeline` warning with day counts.

**Step 2b — Asset expansion**

Assets are distributed across products according to `scope.distribution` (even / front-loaded / back-loaded / milestone-batched) and inserted in batches of 500.

**Step 3 — Work templates**

One template is built per distinct primary-variable value (the first `variable_field`). Each template lists the workflow steps that have a non-zero estimate for a representative combo key from that group, sorted in topological order.

**Step 4 — Work scheduling**

Two paths based on whether `release_interval_days` is set in an `earliest_ship` scenario:

- **Single-launch** (`expand_and_insert_work`) — processes one product at a time; each asset's work block is placed relative to that product's release date (backward) or a rolling cursor (forward).
- **Cadence** (`expand_and_insert_work_cadence`) — forward-schedules all assets in a single global pass; sprint release dates are then derived by working backwards from the last sprint's actual completion date, keeping the requested interval unless a sprint slips.

---

## Scheduling Algorithm

### Asset-at-a-time placement

The scheduler processes one complete asset at a time — placing all of an asset's workflow steps before moving on to the next asset. This is a deliberate design choice aligned with the PAW principle: the asset is the most important entity, and its work is a property of that asset's journey through the pipeline. Step-level interleaving (classic RCPSP) would pack craft capacity more tightly but would fragment individual asset timelines into disconnected bursts, which is operationally unworkable for art teams.

### Uncapped scheduling

**Backward (target_date):** terminal steps (no successors) are anchored to the product release date. Each predecessor's end date is `min(successor.start) - 1`. The DAG is traversed in reverse topological order.

**Forward (earliest_ship):** each step starts at `max(deps finish) + 1`, or the product cursor if it has no dependencies. Independent branches execute in parallel.

**Uncapped schedule cache:** within a single generation run, all assets sharing the same `(combo_key, product_id)` pair receive identical dates (same steps, same anchor). The result is computed once and cloned, skipping redundant DAG traversal for duplicate asset types within the same product.

### Capped scheduling

When `craft_caps` are set, the scheduler uses a two-pass approach:

**Pass 1 — forward cap-push:** the chain starts at `_batch_chain_start`, which pre-computes how far back the product window must open to fit all assets given their total cap-constrained workload. Within that window, steps are forward-scheduled with cap enforcement. Each capped step's start date is pushed forward until the craft's concurrent-asset count drops below its cap.

**Pass 2 — backward pullback (backward mode only):** uncapped steps (prep, polish, review) are pulled backwards to sit just before their successors' actual start dates. Only steps with zero capped ancestry are eligible — steps downstream of any capped step keep their forward-computed positions. This keeps each asset's work block compact rather than frontloading unconstrained steps against the chain start while capped production steps land weeks later.

### Sweep-line craft-window placement

Craft occupancy is tracked as two sorted lists per craft: start dates and end dates. The overlap count for a proposed span `[s, s+D-1]` is computed in `O(log W)` via bisect:

```
overlap = bisect_right(starts, s+D-1) - bisect_left(ends, s)
```

When the proposed start is over-cap, candidate starts are `(window_end + 1)` for each existing window — the only dates where concurrency can drop. This eliminates the day-by-day stepping that made the original implementation `O(N²)` in the number of work items, reducing capped scheduling to `O(N log N)`.

---

## AI Engine (`lib/scenario/generator.py`)

Uses Claude Sonnet. Three generation passes:

1. **Products pass** — generates the product list with names and dates from scope
2. **Asset profiles pass** — generates `{profiles: [{variable_values, total_count, priority}]}`; server-side distributes totals across products
3. **Work templates pass** — generates `{templates: [{match_when, step_names}]}`; server-side looks up `estimate_days` from the matrix and schedules

Variable values keys returned by the AI are normalized against the studio's actual field names (exact → case-insensitive → starts-with → contains) before validation, handling abbreviated field names.

Both engines use `lib/scenario/shared.py` for all DB writes, profile normalization, and date computation.

---

## Session Stages

| Stage | Description |
|---|---|
| `scoping` | Haiku is gathering scope parameters |
| `pending_generation` | Scope locked; awaiting generation worker pick-up |
| `generating` | Generation worker is running |
| `discussion` | Generation complete; Haiku can answer questions about the plan |
| `generation_failed` | Generation threw an exception; retryable |

---

## Ephemeral Data Tables

Scenario data is fully isolated from the canonical layer — no foreign keys to `canonical_assets` or any production tables. Dismissing a session cascades deletes through all five tables.

### `scenario_sessions`

```
id                  uuid PK
studio_id           uuid → studios
user_id             uuid → auth.users
name                text        (NULL = ephemeral; reserved for future saved scenarios)
status              text        (active | dismissed)
ai_stage            text        (scoping | pending_generation | generating | discussion | generation_failed)
generation_mode     text        (ai | rule_based)
scope_json          jsonb       (locked once pending_generation is set)
message_count       int
preflight_warnings  jsonb       (array of {profile, issue, ...} objects)
created_at, expires_at          (24h TTL; nightly cleanup deletes expired rows)
```

### `scenario_messages`

```
session_id  uuid → scenario_sessions (CASCADE)
studio_id   uuid
role        text (user | assistant)
content     text
created_at
```

### `scenario_products`

```
session_id          uuid → scenario_sessions (CASCADE)
studio_id           uuid
name                text
target_release_date date    (NULL for earliest_ship until post-scheduling write-back)
created_at
```

### `scenario_assets`

```
session_id      uuid → scenario_sessions (CASCADE)
studio_id       uuid
product_id      uuid → scenario_products (CASCADE)
name            text
variable_values jsonb   (must match estimate_config.variable_fields keys)
priority        text
created_at
```

### `scenario_work`

```
session_id       uuid → scenario_sessions (CASCADE)
studio_id        uuid
asset_id         uuid → scenario_assets (CASCADE)
step_name        text
craft            text
estimate_days    numeric
start_date       date
end_date         date
created_at
```

---

## Wizard Mode (Rule-Based)

`POST /api/scenario/generate` is a direct-to-generation path: the wizard form (`ScenarioWizard.jsx`) collects scope parameters from the user directly (no chat), then posts a fully-formed scope body. Any active session for the user is dismissed first. The session is created in `pending_generation` immediately, bypassing the scoping stage.

`GET /api/scenario/wizard-data` returns the profiles and crafts the wizard needs to populate its dropdowns.

---

## Frontend

`ScenarioPlanner.jsx` routes between three components based on session state:

- **No session** → `ScenarioWizard` — form-based scope input; direct generation path
- **Session with scoping/generating stage** → `ScenarioChat` — conversation interface
- **Session with discussion/failed stage** → `ScenarioChat` (discussion) + `ScenarioViewer` (data)

`ScenarioViewer.jsx` renders a three-tab read-only view of the generated plan: Products list, Assets list, and Work list with Gantt timeline view. All three datasets are paginated server-side via `drain_pages` so there is no display cap regardless of scenario size.

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
| GET | `/{id}/data` | Session state, scope, and all generated rows (paginated, no row limit) |
| GET | `/{id}/messages` | Full message history |
| DELETE | `/{id}` | Dismiss session |

---

## Known Gaps

**Export and write-back deferred** — "Export to CSV" and "Write to Source" in the action bar are disabled. Exporting the scenario plan to a spreadsheet and writing it back to the studio's source tool are both planned but not yet built.

**No session history or comparison** — each session produces a fresh plan with no link to prior scenarios. Comparing two plan alternatives requires running two sessions manually.

**Discussion mode context on large scenarios** — the Haiku discussion prompt loads aggregated data from the session tables. On very large scenarios (thousands of work rows), the context summary may be truncated.

**Craft caps are greedy without backtracking** — assets are placed in priority order and each asset claims the earliest available cap slot. A sub-optimal early placement can push later assets past their target window even when a valid schedule exists. The sweep-line placement ensures the earliest feasible slot for each step is found efficiently, but the overall asset ordering is not optimised.
