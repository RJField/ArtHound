import { useState, useEffect, useCallback, useMemo } from 'react'
import { apiFetch } from '../lib/api'

export const STEPS = ['mode', 'rhythm', 'shapes', 'generate']
export const STEP_LABELS = ['Mode', 'Rhythm', 'Release shape', 'Generate']

let _shapeId = 1
const newShapeId = () => String(_shapeId++)

function defaultShape(profiles) {
  return {
    id:                newShapeId(),
    name:              'Release',
    count_per_release: 1,
    every_n_releases:  1,   // appears in every release by default
    profiles:          Object.fromEntries((profiles ?? []).map(p => [p, 0])),
  }
}

const DEFAULT_FORM = {
  // Step 1 — mode
  scenario_category: 'target_date',
  target_date: '',

  // Step 2 — rhythm
  is_single_release:       false,
  release_interval_value:  2,
  release_interval_unit:   'weeks',   // 'weeks' | 'months'
  horizon_value:           12,
  horizon_unit:            'months',  // 'months' | 'years'

  // Step 3 — release shapes (populated after profiles load)
  shapes: [],
}

// ── Derived calculations ──────────────────────────────────────────────────────

export function computeNumReleases(form) {
  if (form.is_single_release) return 1

  const intervalDays =
    form.release_interval_value *
    (form.release_interval_unit === 'weeks' ? 7 : 30.44)

  let durationDays
  if (form.scenario_category === 'target_date' && form.target_date) {
    durationDays = Math.max(0,
      (new Date(form.target_date) - new Date()) / 86_400_000
    )
  } else {
    const mult = form.horizon_unit === 'years' ? 365.25 : 30.44
    durationDays = form.horizon_value * mult
  }

  return Math.max(1, Math.floor(durationDays / Math.max(intervalDays, 1)))
}

export function computePerReleaseCounts(shapes) {
  // Returns effective per-release asset counts averaged across each shape's cadence.
  // e.g. "1 per release every 2 releases" → 0.5 effective per release on average.
  const counts = {}
  for (const shape of shapes) {
    const qty   = Math.max(shape.count_per_release || 0, 0)
    const every = Math.max(shape.every_n_releases  || 1, 1)
    for (const [profile, n] of Object.entries(shape.profiles || {})) {
      if (n > 0) counts[profile] = (counts[profile] || 0) + (n * qty) / every
    }
  }
  return counts
}

function computeScale(shapes, numReleases) {
  // Total assets across all releases, respecting each shape's occurrence cadence.
  // occurrences = ceil(numReleases / every_n_releases)
  const scale = {}
  for (const shape of shapes) {
    const qty         = Math.max(shape.count_per_release || 0, 0)
    const every       = Math.max(shape.every_n_releases  || 1, 1)
    const occurrences = Math.ceil(numReleases / every)
    for (const [profile, n] of Object.entries(shape.profiles || {})) {
      if (n > 0) scale[profile] = (scale[profile] || 0) + n * qty * occurrences
    }
  }
  return Object.fromEntries(Object.entries(scale).filter(([, n]) => n > 0))
}


export function useScenarioWizard({ onGenerate }) {
  const [step,       setStep]       = useState(0)
  const [form,       setForm]       = useState(DEFAULT_FORM)
  const [profiles,   setProfiles]   = useState([])
  const [crafts,     setCrafts]     = useState([])
  const [loading,    setLoading]    = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState(null)
  const [genMode,    setGenMode]    = useState('rule_based')
  // craft caps: { craftName: number }
  const [craftCaps,  setCraftCaps]  = useState({})

  // ── Fetch profiles + crafts ───────────────────────────────────────────────
  useEffect(() => {
    apiFetch('/api/scenario/wizard-data')
      .then(data => {
        const p = data.profiles ?? []
        setProfiles(p)
        setCrafts(data.crafts ?? [])
        // Seed one default shape with all profiles at 0.
        setForm(f => ({
          ...f,
          shapes: f.shapes.length ? f.shapes : [defaultShape(p)],
        }))
      })
      .catch(err => setError(err.message ?? 'Failed to load matrix data'))
      .finally(() => setLoading(false))
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────────
  const numReleases      = useMemo(() => computeNumReleases(form), [form])
  const perReleaseCounts = useMemo(() => computePerReleaseCounts(form.shapes), [form.shapes])
  const totalAssets      = useMemo(
    () => Object.values(perReleaseCounts).reduce((s, n) => s + n, 0) * numReleases,
    [perReleaseCounts, numReleases]
  )

  // ── Form setters ──────────────────────────────────────────────────────────
  const set = useCallback((key, value) => {
    setForm(f => ({ ...f, [key]: value }))
  }, [])

  const setShapeField = useCallback((shapeId, field, value) => {
    setForm(f => ({
      ...f,
      shapes: f.shapes.map(s => s.id === shapeId ? { ...s, [field]: value } : s),
    }))
  }, [])

  const setShapeProfile = useCallback((shapeId, profile, count) => {
    setForm(f => ({
      ...f,
      shapes: f.shapes.map(s =>
        s.id === shapeId
          ? { ...s, profiles: { ...s.profiles, [profile]: Math.max(0, count) } }
          : s
      ),
    }))
  }, [])

  const addShape = useCallback(() => {
    setForm(f => ({
      ...f,
      shapes: [...f.shapes, defaultShape(profiles)],
    }))
  }, [profiles])

  const removeShape = useCallback((shapeId) => {
    setForm(f => ({ ...f, shapes: f.shapes.filter(s => s.id !== shapeId) }))
  }, [])

  const setCap = useCallback((craft, value) => {
    setCraftCaps(prev => {
      const next = { ...prev }
      if (value === '' || value === null || value === undefined) {
        delete next[craft]
      } else {
        next[craft] = Number(value)
      }
      return next
    })
  }, [])

  // ── Navigation ────────────────────────────────────────────────────────────
  const next = useCallback(() => setStep(s => Math.min(s + 1, STEPS.length - 1)), [])
  const back = useCallback(() => setStep(s => Math.max(s - 1, 0)), [])
  const goTo = useCallback((i) => setStep(i), [])

  // ── Step validation ───────────────────────────────────────────────────────
  const stepValid = useCallback((i) => {
    const s = STEPS[i ?? step]
    if (s === 'mode') {
      return form.scenario_category === 'earliest_ship' || !!form.target_date
    }
    if (s === 'rhythm') {
      return form.is_single_release || (form.release_interval_value >= 1 && numReleases >= 1)
    }
    if (s === 'shapes') {
      return form.shapes.length > 0 &&
        form.shapes.some(sh => Object.values(sh.profiles).some(n => n > 0))
    }
    return true
  }, [step, form, numReleases])

  // ── Submit ────────────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const scale = computeScale(form.shapes, numReleases)
      if (Object.keys(scale).length === 0) {
        setError('Add at least one asset to a product shape before generating.')
        return
      }

      const intervalDays = form.is_single_release ? null
        : Math.round(form.release_interval_value * (form.release_interval_unit === 'weeks' ? 7 : 30.44))

      const scope = {
        scenario_category:    form.scenario_category,
        release_cadence:      numReleases === 1 ? 'single_launch' : 'regular_releases',
        num_products:         numReleases,
        release_interval_days: intervalDays,
        distribution:         'even',
        scale,
      }
      if (form.scenario_category === 'target_date' && form.target_date) {
        scope.target_date = form.target_date
      }
      if (Object.keys(craftCaps).length > 0) {
        scope.craft_caps = craftCaps
      }

      const res = await apiFetch('/api/scenario/generate', {
        method: 'POST',
        body: JSON.stringify({ mode: genMode, scope }),
      })
      onGenerate(res.session_id)
    } catch (err) {
      setError(err.message ?? 'Failed to start generation')
    } finally {
      setSubmitting(false)
    }
  }, [form, numReleases, craftCaps, genMode, onGenerate])

  return {
    step, steps: STEPS, stepLabels: STEP_LABELS,
    form, set, setShapeField, setShapeProfile, addShape, removeShape,
    profiles, crafts, loading,
    genMode, setGenMode,
    craftCaps, setCap,
    submitting, error,
    next, back, goTo, stepValid,
    submit,
    // Derived
    numReleases,
    perReleaseCounts,
    totalAssets,
  }
}
