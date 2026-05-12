# Estimation Engine

_Last updated: 2026-05-11_

The estimation engine lets studios define a matrix of expected work durations keyed on studio-specific production variables. When the scheduler generates work for an asset, it looks up the asset's field values against this matrix to produce day-count estimates for each workflow step.

---

## Concepts

**Workflow step** — a named production task (e.g., "Concept Art", "Rigging", "QA") with an optional craft label and zero or more dependency steps. Defined per studio in `workflow_steps`. Steps have a topological ordering enforced by `workflow_step_dependencies`.

**Variable fields** — the source-tool fields whose values drive the estimate matrix. A studio chooses which fields are variables (e.g., "Asset Type", "Complexity"). The combination of all variable field values for a given asset determines which matrix row applies.

**Estimate matrix** — a table of `(workflow_step × variable_values) → estimate_days`. Each cell holds the number of working days expected for that step on an asset with those variable values. Cells can be null (unknown) or 0 (this step doesn't apply).

**Combination** — a unique ordered set of variable field values (e.g., `{Asset Type: "Character", Complexity: "High"}`). Each distinct combination becomes a column group in the matrix UI.

---

## Data Model

### `workflow_steps`

```
id           uuid PK
studio_id    uuid → studios
name         text NOT NULL
craft        text        (optional grouping label, e.g., "Art", "Tech")
created_at, updated_at
```

Unique constraint: `(studio_id, name)`.

### `workflow_step_dependencies`

```
step_id         uuid → workflow_steps (PK)
depends_on_step_id  uuid → workflow_steps (PK)
```

ON DELETE CASCADE. The Workflows UI and the topological sort in `routes/matrix.py` enforce no cycles.

### `estimate_config`

```
studio_id       uuid PK → studios
variable_fields text[]      (ordered list of source field names)
updated_at
```

One row per studio. `variable_fields` determines which source asset fields are used as matrix axes.

### `estimate_matrix`

```
id               uuid PK
studio_id        uuid → studios
workflow_step_id uuid → workflow_steps
variable_values  jsonb   ({field_name: value, ...})
estimate_days    numeric
```

Unique constraint: `(studio_id, workflow_step_id, variable_values)`. GIN index on `variable_values` for fast lookup.

---

## Setup Flow

### 1. Define workflow steps

Studios build their step library on the Workflows page (`frontend/src/pages/Workflows.jsx`):
- Add/edit/delete steps with name, craft, and dependency checkboxes
- Steps are displayed grouped by craft, with "Needs" dependency pills
- A topological sort (`topoSort()`) enforces ordering — cycles are detected and blocked
- CSV export available for bulk review

### 2. Create the matrix

`POST /api/setup/create-matrix-pg` initialises the matrix for a studio:
1. Takes `variable_fields` (list of source field names the studio has chosen)
2. Scans synced assets to enumerate all unique value combinations for those fields
3. Creates an `estimate_config` row
4. Creates one `estimate_matrix` row per `(step × combination)` with `estimate_days = null`

A "Default" combination is always included for assets whose field values don't match any explicit combination.

### 3. Fill in estimates

The Estimates page (`frontend/src/pages/Estimates.jsx`) renders the matrix as a spreadsheet:
- **Rows** — workflow steps, sorted topologically, with step name, craft, and dependency labels in sticky left columns
- **Columns** — one column group per variable combination; a header row shows the field name, a second header row shows the value
- **Cells** — numeric inputs (min 0, step 0.5 days); editable inline

Cell saves happen on blur or Enter: `PATCH /api/setup/matrix-cell` upserts the single `(step, variable_values)` row. Keyboard shortcut: Escape reverts a cell to its saved value without saving.

---

## Estimate Resolution

When the scheduler generates work for an asset, it looks up the asset's variable field values from `replicated_assets.meta`, builds a `variable_values` dict, and queries `estimate_matrix` for a matching row per workflow step.

Lookup priority:
1. Exact match on `variable_values`
2. `Default` combination (always present as a fallback)
3. `null` — no estimate (step is generated but with no day count)

The `null` vs `0` distinction is meaningful: `null` means the estimate is unknown or not yet entered; `0` means the step genuinely has zero duration for this combination (e.g., a simple prop that skips rigging).

---

## API Reference

All endpoints are under `/api/setup`. Studio-only.

| Method | Path | Description |
|---|---|---|
| GET | `/workflow-steps` | List workflow steps with dependencies |
| POST | `/workflow-steps` | Create a step |
| PATCH | `/workflow-steps/{id}` | Update name, craft, or dependencies |
| DELETE | `/workflow-steps/{id}` | Delete step and its matrix rows |
| GET | `/matrix-table-pg` | Fetch formatted matrix (steps × combinations × estimates) |
| POST | `/create-matrix-pg` | Initialize matrix from variable fields + asset combinations |
| PATCH | `/matrix-cell` | Upsert a single estimate cell |

---

## Known Gaps

**No cycle detection at the API level** — the Workflows UI runs a client-side `topoSort()` to prevent cycles, but `POST /workflow-steps` does not validate the dependency graph server-side. A malformed API call could insert a cycle that breaks topological ordering in the matrix and scheduler.

**No admin random-fill** — there is no endpoint to bulk-populate null cells with a random or heuristic estimate (useful for demo/testing purposes). Each cell must be entered manually.

**Variable fields are not linked to source_field_mappings** — `estimate_config.variable_fields` stores raw field names. If a studio renames a field in their source tool and re-syncs, the variable field names in the matrix may become stale without detection.
