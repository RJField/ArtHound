import { useScenarioWizard, STEPS, STEP_LABELS, computeNumReleases } from '../../hooks/useScenarioWizard'

export default function ScenarioWizard({ onGenerate }) {
  const wiz = useScenarioWizard({ onGenerate })

  if (wiz.loading) {
    return (
      <div className="flex flex-col flex-1 items-center justify-center gap-2 text-muted text-sm">
        <div className="w-4 h-4 border-2 border-border border-t-accent rounded-full animate-spin" />
        Loading matrix…
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-xl w-full mx-auto px-6 py-8 flex flex-col gap-8">

        <StepBar step={wiz.step} labels={STEP_LABELS} goTo={wiz.goTo} stepValid={wiz.stepValid} />

        {wiz.step === 0 && <StepMode form={wiz.form} set={wiz.set} />}
        {wiz.step === 1 && <StepRhythm form={wiz.form} set={wiz.set} numReleases={wiz.numReleases} />}
        {wiz.step === 2 && (
          <StepShapes
            form={wiz.form}
            profiles={wiz.profiles}
            numReleases={wiz.numReleases}
            perReleaseCounts={wiz.perReleaseCounts}
            totalAssets={wiz.totalAssets}
            setShapeField={wiz.setShapeField}
            setShapeProfile={wiz.setShapeProfile}
            addShape={wiz.addShape}
            removeShape={wiz.removeShape}
          />
        )}
        {wiz.step === 3 && (
          <StepGenerate
            form={wiz.form}
            numReleases={wiz.numReleases}
            perReleaseCounts={wiz.perReleaseCounts}
            totalAssets={wiz.totalAssets}
            crafts={wiz.crafts}
            craftCaps={wiz.craftCaps}
            setCap={wiz.setCap}
            genMode={wiz.genMode}
            setGenMode={wiz.setGenMode}
            submitting={wiz.submitting}
            error={wiz.error}
            onSubmit={wiz.submit}
          />
        )}

        {/* Navigation */}
        <div className="flex justify-between items-center pt-2">
          {wiz.step > 0 ? (
            <button onClick={wiz.back} className="text-sm text-muted hover:text-foreground transition-colors">
              Back
            </button>
          ) : <span />}
          {wiz.step < STEPS.length - 1 && (
            <button
              onClick={wiz.next}
              disabled={!wiz.stepValid(wiz.step)}
              className="text-sm bg-accent text-white rounded px-5 py-2 hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          )}
        </div>

      </div>
    </div>
  )
}


// ── Step bar ──────────────────────────────────────────────────────────────────

function StepBar({ step, labels, goTo, stepValid }) {
  return (
    <div className="flex items-center gap-1">
      {labels.map((label, i) => {
        const active    = i === step
        const done      = i < step
        const clickable = done || (i === step + 1 && stepValid(step))
        return (
          <div key={i} className="flex items-center gap-1 flex-1">
            <button
              onClick={() => clickable && goTo(i)}
              className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                active ? 'text-accent' : done ? 'text-muted hover:text-foreground' : 'text-border cursor-default'
              }`}
            >
              <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] border shrink-0 ${
                active
                  ? 'border-accent text-accent bg-accent/10'
                  : done
                  ? 'border-muted text-muted bg-surface-2'
                  : 'border-border text-border'
              }`}>
                {done ? '✓' : i + 1}
              </span>
              <span className="hidden sm:inline">{label}</span>
            </button>
            {i < labels.length - 1 && (
              <div className={`flex-1 h-px ${done ? 'bg-muted' : 'bg-border'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}


// ── Step 1: Mode ──────────────────────────────────────────────────────────────

function StepMode({ form, set }) {
  const options = [
    {
      value: 'target_date',
      icon: '◎',
      title: 'Launch by target date',
      desc: "Set a ship date — the engine schedules backwards from it and flags anything that can't finish in time.",
    },
    {
      value: 'earliest_ship',
      icon: '→',
      title: 'Find earliest ship date',
      desc: 'Let the engine schedule everything forward and tell you the earliest possible completion date.',
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader>Planning mode</SectionHeader>
      <div className="flex flex-col gap-3">
        {options.map(opt => (
          <button
            key={opt.value}
            onClick={() => set('scenario_category', opt.value)}
            className={`flex items-start gap-4 text-left p-4 rounded-xl border transition-all ${
              form.scenario_category === opt.value ? 'border-accent bg-accent/5' : 'border-border hover:border-muted'
            }`}
          >
            <span className={`text-xl mt-0.5 shrink-0 ${form.scenario_category === opt.value ? 'text-accent' : 'text-muted'}`}>
              {opt.icon}
            </span>
            <div className="flex flex-col gap-0.5">
              <span className={`text-sm font-semibold ${form.scenario_category === opt.value ? 'text-accent' : 'text-foreground'}`}>
                {opt.title}
              </span>
              <span className="text-xs text-muted leading-relaxed">{opt.desc}</span>
            </div>
          </button>
        ))}
      </div>

      {form.scenario_category === 'target_date' && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-muted font-medium">Target ship date</label>
          <input
            type="date"
            value={form.target_date}
            onChange={e => set('target_date', e.target.value)}
            min={new Date().toISOString().split('T')[0]}
            className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-foreground focus:outline-none focus:border-accent"
          />
        </div>
      )}
    </div>
  )
}


// ── Step 2: Rhythm ────────────────────────────────────────────────────────────

const INTERVAL_UNITS = [
  { value: 'weeks',  label: 'weeks'  },
  { value: 'months', label: 'months' },
]

const HORIZON_UNITS = [
  { value: 'months', label: 'months' },
  { value: 'years',  label: 'years'  },
]

function StepRhythm({ form, set, numReleases }) {
  const isTargetDate  = form.scenario_category === 'target_date'
  const isSingle      = form.is_single_release

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader>Release rhythm</SectionHeader>

      {/* Single vs recurring */}
      <div className="flex gap-2">
        {[
          { single: false, label: 'Regular releases' },
          { single: true,  label: 'Single release'   },
        ].map(opt => (
          <button
            key={String(opt.single)}
            onClick={() => set('is_single_release', opt.single)}
            className={`flex-1 px-3 py-2.5 rounded-lg border text-sm text-center transition-all ${
              isSingle === opt.single
                ? 'border-accent bg-accent/5 text-foreground font-medium'
                : 'border-border text-muted hover:border-muted'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {!isSingle && (
        <>
          {/* Release interval */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-muted font-medium">Release every</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={52}
                value={form.release_interval_value}
                onChange={e => set('release_interval_value', Math.max(1, parseInt(e.target.value) || 1))}
                className="w-20 border border-border rounded-lg px-3 py-2 text-sm bg-surface text-foreground text-center focus:outline-none focus:border-accent"
              />
              <select
                value={form.release_interval_unit}
                onChange={e => set('release_interval_unit', e.target.value)}
                className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-foreground focus:outline-none focus:border-accent"
              >
                {INTERVAL_UNITS.map(u => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Horizon — only shown for earliest_ship; target_date derives from the date */}
          {!isTargetDate && (
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-muted font-medium">Planning horizon</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={120}
                  value={form.horizon_value}
                  onChange={e => set('horizon_value', Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-20 border border-border rounded-lg px-3 py-2 text-sm bg-surface text-foreground text-center focus:outline-none focus:border-accent"
                />
                <select
                  value={form.horizon_unit}
                  onChange={e => set('horizon_unit', e.target.value)}
                  className="border border-border rounded-lg px-3 py-2 text-sm bg-surface text-foreground focus:outline-none focus:border-accent"
                >
                  {HORIZON_UNITS.map(u => (
                    <option key={u.value} value={u.value}>{u.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Derived release count */}
          <p className="text-xs text-muted">
            {isTargetDate && form.target_date
              ? `From today to ${form.target_date}: `
              : 'Over this horizon: '}
            <span className="text-foreground font-medium">{numReleases} release{numReleases !== 1 ? 's' : ''}</span>
          </p>
        </>
      )}
    </div>
  )
}


// ── Step 3: Release shape ─────────────────────────────────────────────────────

function StepShapes({ form, profiles, numReleases, perReleaseCounts, totalAssets, setShapeField, setShapeProfile, addShape, removeShape }) {
  const perReleaseTotal = Object.values(perReleaseCounts).reduce((s, n) => s + n, 0)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-baseline justify-between">
        <SectionHeader>Release shape</SectionHeader>
        <span className="text-xs text-muted">
          {perReleaseTotal > 0
            ? `${perReleaseTotal}/release · ${totalAssets} total`
            : 'Define what each release contains'}
        </span>
      </div>

      {form.shapes.map((shape) => (
        <ShapeCard
          key={shape.id}
          shape={shape}
          profiles={profiles}
          canRemove={form.shapes.length > 1}
          onNameChange={v  => setShapeField(shape.id, 'name', v)}
          onCountChange={v => setShapeField(shape.id, 'count_per_release', Math.max(1, parseInt(v) || 1))}
          onEveryChange={v => setShapeField(shape.id, 'every_n_releases',  Math.max(1, parseInt(v) || 1))}
          onProfileChange={(p, n) => setShapeProfile(shape.id, p, n)}
          onRemove={() => removeShape(shape.id)}
        />
      ))}

      <button
        onClick={addShape}
        className="flex items-center gap-1.5 text-xs text-muted hover:text-foreground border border-dashed border-border rounded-lg px-4 py-2.5 transition-colors w-full justify-center"
      >
        + Add product type
      </button>

      {/* Per-release summary */}
      {perReleaseTotal > 0 && (
        <div className="text-xs text-muted space-y-0.5 pt-1 border-t border-border">
          <p className="font-medium text-foreground mb-1">Per release:</p>
          {Object.entries(perReleaseCounts).map(([p, n]) => (
            <div key={p} className="flex gap-3">
              <span className="flex-1">{p}</span>
              <span className="text-foreground">{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ShapeCard({ shape, profiles, canRemove, onNameChange, onCountChange, onEveryChange, onProfileChange, onRemove }) {
  const shapeTotal = Object.values(shape.profiles).reduce((s, n) => s + n, 0)
  const every      = Math.max(shape.every_n_releases || 1, 1)

  return (
    <div className="flex flex-col gap-4 p-4 border border-border rounded-xl bg-surface">
      {/* Shape header */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <input
          value={shape.name}
          onChange={e => onNameChange(e.target.value)}
          placeholder="Product type name"
          className="flex-1 min-w-[120px] border border-border rounded px-2.5 py-1.5 text-sm bg-transparent text-foreground focus:outline-none focus:border-accent"
        />
        <span className="text-xs text-muted shrink-0">×</span>
        <input
          type="number"
          min={1}
          max={99}
          value={shape.count_per_release}
          onChange={e => onCountChange(e.target.value)}
          className="w-14 border border-border rounded px-2 py-1.5 text-sm bg-transparent text-foreground text-center focus:outline-none focus:border-accent"
        />
        <span className="text-xs text-muted shrink-0">per release, every</span>
        <input
          type="number"
          min={1}
          max={999}
          value={every}
          onChange={e => onEveryChange(e.target.value)}
          className="w-14 border border-border rounded px-2 py-1.5 text-sm bg-transparent text-foreground text-center focus:outline-none focus:border-accent"
        />
        <span className="text-xs text-muted shrink-0">release{every !== 1 ? 's' : ''}</span>
        {canRemove && (
          <button onClick={onRemove} className="text-xs text-muted hover:text-red-400 transition-colors ml-auto shrink-0">
            Remove
          </button>
        )}
      </div>

      {/* Profile counts */}
      {profiles.length === 0 ? (
        <p className="text-xs text-muted italic">No profiles in estimation matrix.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {profiles.map(profile => (
            <div key={profile} className="flex items-center gap-2">
              <span className="flex-1 text-xs text-muted font-mono bg-surface-2 border border-border rounded px-2 py-1">
                {profile}
              </span>
              <input
                type="number"
                min={0}
                max={9999}
                value={shape.profiles[profile] ?? 0}
                onChange={e => onProfileChange(profile, parseInt(e.target.value) || 0)}
                className="w-20 border border-border rounded px-2 py-1.5 text-sm bg-transparent text-foreground text-right focus:outline-none focus:border-accent"
              />
            </div>
          ))}
        </div>
      )}

      {shapeTotal > 0 && (
        <p className="text-xs text-muted">
          {shapeTotal} asset{shapeTotal !== 1 ? 's' : ''} per instance
          {every > 1 && ` · appears every ${every} releases`}
        </p>
      )}
    </div>
  )
}


// ── Step 4: Generate ──────────────────────────────────────────────────────────

function StepGenerate({ form, numReleases, perReleaseCounts, totalAssets, crafts, craftCaps, setCap, genMode, setGenMode, submitting, error, onSubmit }) {
  const perReleaseTotal = Object.values(perReleaseCounts).reduce((s, n) => s + n, 0)
  const modeLabel = form.scenario_category === 'earliest_ship'
    ? 'Find earliest ship date'
    : `Target date ${form.target_date || '—'}`

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader>Generate</SectionHeader>

      {/* Summary */}
      <div className="flex flex-col gap-3 p-4 bg-surface-2 border border-border rounded-xl text-sm">
        <SummaryRow label="Mode">{modeLabel}</SummaryRow>
        <SummaryRow label="Releases">{numReleases}</SummaryRow>
        <SummaryRow label="Per release">
          {perReleaseTotal > 0
            ? Object.entries(perReleaseCounts).map(([p, n]) => `${n} ${p}`).join(', ')
            : '—'}
        </SummaryRow>
        <SummaryRow label="Total assets">{totalAssets}</SummaryRow>
      </div>

      {/* Craft caps */}
      {crafts.length > 0 && (
        <div className="flex flex-col gap-3">
          <div>
            <label className="text-xs text-muted font-medium">Craft caps <span className="font-normal">(optional)</span></label>
            <p className="text-[11px] text-muted mt-0.5">Max assets of each craft active simultaneously. Leave blank for uncapped.</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {crafts.map(craft => (
              <div key={craft} className="flex items-center gap-2">
                <span className="flex-1 text-xs text-muted">{craft}</span>
                <input
                  type="number"
                  min={1}
                  placeholder="∞"
                  value={craftCaps[craft] ?? ''}
                  onChange={e => setCap(craft, e.target.value)}
                  className="w-16 border border-border rounded px-2 py-1 text-sm bg-surface text-foreground text-right focus:outline-none focus:border-accent"
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Engine */}
      <div className="flex flex-col gap-2">
        <label className="text-xs text-muted font-medium">Generation engine</label>
        <div className="flex gap-2">
          {[
            { value: 'rule_based', label: 'Rule-based', hint: 'Fast, deterministic' },
            { value: 'ai',         label: 'AI',          hint: 'Flexible, uses Claude' },
          ].map(opt => (
            <button
              key={opt.value}
              onClick={() => setGenMode(opt.value)}
              className={`flex-1 px-3 py-2.5 rounded-lg border text-xs text-left transition-all ${
                genMode === opt.value
                  ? 'border-accent bg-accent/5 text-foreground'
                  : 'border-border text-muted hover:border-muted'
              }`}
            >
              <div className="font-medium">{opt.label}</div>
              <div className="text-[11px] opacity-75">{opt.hint}</div>
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={onSubmit}
        disabled={submitting || totalAssets === 0}
        className="w-full py-3 rounded-xl bg-accent text-white font-semibold text-sm hover:bg-accent/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting ? 'Starting…' : 'Generate scenario'}
      </button>
    </div>
  )
}


// ── Shared ────────────────────────────────────────────────────────────────────

function SectionHeader({ children }) {
  return <h2 className="text-base font-semibold text-foreground">{children}</h2>
}

function SummaryRow({ label, children }) {
  return (
    <div className="flex gap-3">
      <span className="text-muted w-28 shrink-0">{label}</span>
      <span className="text-foreground">{children}</span>
    </div>
  )
}
