// Single source of truth for status / priority / craft colors.
// Components must resolve colors here — never hardcode hex values in JSX.

// Tones map to the theme's status CSS variables (index.css @theme).
export const TONES = {
  success: { fg: 'var(--color-success)', tint: 'var(--color-success-tint)' },
  info:    { fg: 'var(--color-info)',    tint: 'var(--color-info-tint)' },
  warning: { fg: 'var(--color-warning)', tint: 'var(--color-warning-tint)' },
  error:   { fg: 'var(--color-error)',   tint: 'var(--color-error-tint)' },
  accent:  { fg: 'var(--color-accent-hover)', tint: 'var(--color-accent-tint)' },
  neutral: { fg: 'var(--color-muted)',   tint: 'var(--color-surface-2)' },
}

// Keyword heuristic for arbitrary, studio-defined status labels.
// Order matters: first match wins.
const STATUS_PATTERNS = [
  [/(approved|done|complete|shipped|final|accepted|live|pass)/i, 'success'],
  [/(blocked|fail|reject|changes\s*requested|overdue|error|cancel)/i, 'error'],
  [/(pending|review|waiting|hold|paused|qa)/i, 'warning'],
  [/(progress|active|wip|started|generating|running|sync)/i, 'info'],
  [/(draft|todo|backlog|new|idea|not\s*started)/i, 'neutral'],
]

export function statusTone(label) {
  if (!label) return 'neutral'
  for (const [re, tone] of STATUS_PATTERNS) {
    if (re.test(String(label))) return tone
  }
  return 'neutral'
}

export function statusColor(label) {
  return TONES[statusTone(label)].fg
}

// Priority P1 (highest) → P5, matching the --color-p* theme scale.
export const PRIORITY_COLORS = {
  1: 'var(--color-p1)',
  2: 'var(--color-p2)',
  3: 'var(--color-p3)',
  4: 'var(--color-p4)',
  5: 'var(--color-p5)',
}

export function priorityColor(priority) {
  const n = parseInt(String(priority).replace(/\D/g, ''), 10)
  return PRIORITY_COLORS[n] || TONES.neutral.fg
}

// Crafts are studio-defined; assign stable colors from a fixed palette.
const CRAFT_PALETTE = [
  '#a78bfa', '#60a5fa', '#34d399', '#fbbf24', '#f97316',
  '#f472b6', '#2dd4bf', '#a3e635', '#f87171', '#94a3b8',
]
const CRAFT_PRESETS = {
  '3d': '#a78bfa',
  '2d': '#60a5fa',
  animation: '#34d399',
  vfx: '#fbbf24',
}

export function craftColor(name) {
  if (!name) return CRAFT_PALETTE[CRAFT_PALETTE.length - 1]
  const key = String(name).trim().toLowerCase()
  if (CRAFT_PRESETS[key]) return CRAFT_PRESETS[key]
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return CRAFT_PALETTE[hash % CRAFT_PALETTE.length]
}
