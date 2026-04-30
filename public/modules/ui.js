// Dependency injection setters — app.js calls these after Supabase bootstrap to
// avoid a circular import between apiFetch→navigate and the module graph.
let _authFailHandler = null;
let _supabaseClient = null;

export function setAuthFailHandler(fn) { _authFailHandler = fn; }
export function setSupabaseClient(client) { _supabaseClient = client; }

export const $ = id => document.getElementById(id);

// -- Utilities --

export function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export async function apiFetch(path, opts = {}) {
  const { data: { session } } = await _supabaseClient.auth.getSession();
  if (!session) {
    if (_authFailHandler) _authFailHandler();
    throw new Error('Not authenticated');
  }
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
      'Authorization': `Bearer ${session.access_token}`,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// -- Toast --

const $toast = $('toast');
let toastTimer;
export function showToast(msg, type = 'info') {
  $toast.textContent = msg;
  $toast.className = `toast toast-${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 4000);
}

// -- Detail Modal --
//
// openDetailModal({ title, badge?, fields, image?, actions? })
//   fields:  [{ label, value }] — value is text-escaped automatically
//            [{ label, html }]  — html is injected raw (use for links/badges)
//   actions: [{ label, style?, onClick(closeFn) }]

const $detailOverlay = $('detail-overlay');
const $detailTitle   = $('detail-title');
const $detailBadge   = $('detail-badge');
const $detailBody    = $('detail-body');
const $detailFooter  = $('detail-footer');

$('detail-close').addEventListener('click', closeDetailModal);
$detailOverlay.addEventListener('click', e => {
  if (e.target === $detailOverlay) closeDetailModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $detailOverlay.classList.contains('open')) closeDetailModal();
});

export function openDetailModal({ title, badge, fields = [], image, actions = [] }) {
  $detailTitle.textContent = title;

  if (badge) {
    $detailBadge.textContent = badge;
    $detailBadge.style.display = '';
  } else {
    $detailBadge.style.display = 'none';
  }

  $detailBody.innerHTML = '';
  if (image) {
    const img = document.createElement('img');
    img.className = 'dm-image';
    img.src = image;
    img.alt = 'Preview';
    $detailBody.appendChild(img);
  }
  if (fields.length) {
    const fieldsEl = document.createElement('div');
    $detailBody.appendChild(fieldsEl);
    renderFieldGrid(fieldsEl, fields, { layout: 'list' });
  }

  $detailFooter.innerHTML = '';
  if (actions.length) {
    $detailFooter.style.display = '';
    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.className = `btn btn-${a.style || 'secondary'} btn-sm`;
      btn.textContent = a.label;
      btn.addEventListener('click', () => a.onClick(closeDetailModal));
      $detailFooter.appendChild(btn);
    });
  } else {
    $detailFooter.style.display = 'none';
  }

  $detailOverlay.classList.add('open');
}

export function closeDetailModal() {
  $detailOverlay.classList.remove('open');
}

// -- Field Grid --
//
// renderFieldGrid(container, fields, opts?)
//   container — DOM element or element ID string
//   fields    — array of FieldDef:
//     { label, value, type?, span?, badgeColor?, href?, onClick?, action?, resolve? }
//     type:    'text' (default) | 'badge' | 'link' | 'linked-record'
//     span:    'full' — tile spans all grid columns (grid layout only)
//     onClick: fn(field) — custom click; default copies value to clipboard
//     action:  { label, onClick(field) } — button rendered inside the tile
//     resolve: async fn(field) → { title, badge?, fields[] }
//              Required when type='linked-record'. Called on click; opens the
//              detail modal with the resolved record. DB-agnostic: the caller
//              decides where/how to fetch (Airtable, Postgres, cache, etc.).
//   opts:
//     layout: 'grid' (default) | 'list' — list renders label/value rows, grid renders tiles

export function renderFieldGrid(container, fields, opts = {}) {
  const el = typeof container === 'string' ? $(container) : container;
  const layout = opts.layout || 'grid';
  el.className = el.className.replace(/\bfg-(?:grid|list)\b/g, '').trim();
  el.classList.add(layout === 'list' ? 'fg-list' : 'fg-grid');
  el.innerHTML = '';

  for (const f of fields) {
    const hasValue = f.value != null && f.value !== '';
    const display  = hasValue ? String(f.value) : '—';

    function buildValueNode(cls) {
      const valueEl = document.createElement('div');
      valueEl.className = cls + (hasValue ? '' : ' fg-tile-empty');
      if (f.type === 'badge') {
        const badge = document.createElement('span');
        badge.className = 'fg-badge';
        badge.textContent = display;
        if (f.badgeColor) badge.style.color = f.badgeColor;
        valueEl.appendChild(badge);
      } else if (f.type === 'link' && f.href) {
        const a = document.createElement('a');
        a.href = f.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'fg-link';
        a.textContent = display;
        valueEl.appendChild(a);
      } else if (f.type === 'linked-record') {
        valueEl.textContent = display;
        if (f.resolve) {
          const indicator = document.createElement('span');
          indicator.className = 'fg-record-indicator';
          indicator.textContent = ' ↗';
          valueEl.appendChild(indicator);
        }
      } else {
        valueEl.textContent = display;
      }
      return valueEl;
    }

    function attachLinkedRecordClick(elem) {
      elem.classList.add('fg-tile-clickable');
      elem.addEventListener('click', async () => {
        openDetailModal({ title: 'Loading…', fields: [{ label: '', value: 'Fetching record…' }] });
        try {
          const resolved = await f.resolve(f);
          openDetailModal(resolved);
        } catch (err) {
          closeDetailModal();
          showToast(err.message, 'error');
        }
      });
    }

    if (layout === 'list') {
      const row = document.createElement('div');
      row.className = 'fg-row';

      const labelEl = document.createElement('div');
      labelEl.className = 'fg-row-label';
      labelEl.textContent = f.label;
      row.appendChild(labelEl);
      row.appendChild(buildValueNode('fg-row-value'));

      if (f.type === 'linked-record' && f.resolve) {
        attachLinkedRecordClick(row);
      } else if (f.onClick) {
        row.classList.add('fg-tile-clickable');
        row.addEventListener('click', () => f.onClick(f));
      } else if (hasValue && f.type !== 'link') {
        row.classList.add('fg-tile-copyable');
        row.addEventListener('click', () => {
          navigator.clipboard.writeText(String(f.value)).then(() => {
            row.classList.add('fg-tile-copied');
            setTimeout(() => row.classList.remove('fg-tile-copied'), 1200);
          });
        });
      }

      el.appendChild(row);
    } else {
      const tile = document.createElement('div');
      tile.className = 'fg-tile' + (f.span === 'full' ? ' fg-tile-full' : '');

      const labelEl = document.createElement('div');
      labelEl.className = 'fg-tile-label';
      labelEl.textContent = f.label;
      tile.appendChild(labelEl);
      tile.appendChild(buildValueNode('fg-tile-value'));

      if (f.action) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm fg-tile-action';
        btn.textContent = f.action.label;
        btn.addEventListener('click', e => { e.stopPropagation(); f.action.onClick(f); });
        tile.appendChild(btn);
      }

      if (f.type === 'linked-record' && f.resolve) {
        attachLinkedRecordClick(tile);
      } else if (f.onClick) {
        tile.classList.add('fg-tile-clickable');
        tile.addEventListener('click', () => f.onClick(f));
      } else if (hasValue && f.type !== 'link') {
        tile.classList.add('fg-tile-copyable');
        tile.addEventListener('click', () => {
          navigator.clipboard.writeText(String(f.value)).then(() => {
            tile.classList.add('fg-tile-copied');
            setTimeout(() => tile.classList.remove('fg-tile-copied'), 1200);
          });
        });
      }

      el.appendChild(tile);
    }
  }
}

// Maps field names that hold record references to the table key used in /api/records/{key}/{id}.
// Extend this as new linked entities are added. When migrating to Postgres, update
// the resolve functions that call /api/records — the map itself stays the same.
export const LINKED_TABLE_MAP = {
  'Asset':  'assets',
  'Assets': 'assets',
};

// Converts a raw field value dict into a FieldDef array for renderFieldGrid.
// Handles dates, arrays, and primitive types. Does not attempt link resolution —
// callers wire resolve() separately for known reference fields.
export function formatRawFields(rawFields) {
  return Object.entries(rawFields)
    .filter(([, v]) => v != null && v !== '')
    .flatMap(([k, v]) => {
      if (Array.isArray(v)) {
        // Attachment array: [{url, filename}] — expand each into its own link field
        if (v.length && typeof v[0] === 'object' && v[0] !== null && 'url' in v[0]) {
          return v.map((att, i) => ({
            label: v.length === 1 ? k : `${k} [${i + 1}]`,
            value: att.filename || att.url,
            type: 'link',
            href: att.url,
          }));
        }
        const allRecIds = v.every(x => typeof x === 'string' && x.startsWith('rec'));
        return [{ label: k, value: allRecIds ? `${v.length} linked record${v.length !== 1 ? 's' : ''}` : v.join(', ') }];
      }
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        return [{ label: k, value: fmtDate(v.slice(0, 10)) }];
      }
      return [{ label: k, value: String(v) }];
    });
}

// Builds the resolve function for a single linked-record reference.
export function makeRecordResolver(tableKey, recordId, fallbackTitle) {
  return async () => {
    const { fields } = await apiFetch(`/api/records/${tableKey}/${encodeURIComponent(recordId)}`);
    const title = fields.Name || fields.name
      || Object.values(fields).find(v => typeof v === 'string' && v.length > 0)
      || fallbackTitle;
    return { title, fields: formatRawFields(fields) };
  };
}
