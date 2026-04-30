const state = {
  products:          [],
  selectedProductId: null,
  assets:            [],
  selectedAssetIds:  new Set(),
  focusedAssetId:    null,
  focusedAsset:      null,
  homeView:          'home',
  taskView:          'list',
  lastTasks:         null,
};

// Supabase client — populated after /api/config loads
let supabaseClient = null;

const $ = id => document.getElementById(id);

const $toast = $('toast');

// -- Navigation --

function navigate(view) {
  document.querySelectorAll('.view').forEach(v => { v.style.display = 'none'; });
  const el = document.getElementById(`view-${view}`);
  el.style.display = 'flex';
  if (view === 'assets') loadProducts();
  if (view === 'reviews') loadReviews();
  if (view === 'incoming-scope') loadVendorInbox();
  if (view === 'matrix-table') loadMatrixTable();
  if (view === 'pg-matrix-table') loadPgMatrixTable();
  if (view === 'workflow-steps') loadWorkflowSteps();
}

// ── Auth ──

const $loginError = $('login-error');

function setLoginError(msg) {
  $loginError.textContent = msg || '';
}

function navigateByRole(role) {
  if (role === 'studio') {
    state.homeView = 'home';
    navigate('home');
  } else if (role === 'vendor') {
    state.homeView = 'vendor-home';
    navigate('vendor-home');
  } else {
    setLoginError('Account has no role assigned. Contact your administrator.');
  }
}

document.getElementById('login-btn').addEventListener('click', async () => {
  if (!supabaseClient) { setLoginError('App not ready — please wait.'); return; }
  setLoginError('');
  const email    = $('login-username').value.trim();
  const password = $('login-password').value;
  if (!email || !password) { setLoginError('Email and password are required.'); return; }

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) { setLoginError(error.message); return; }

  const role = data.user?.app_metadata?.role;
  if (!role) {
    await supabaseClient.auth.signOut();
    setLoginError('Account has no role assigned. Contact your administrator.');
    return;
  }
  navigateByRole(role);
});

document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('login-btn').click();
});

async function handleLogout() {
  if (supabaseClient) await supabaseClient.auth.signOut();
  navigate('login');
}
document.getElementById('logout-btn').addEventListener('click', handleLogout);
document.getElementById('vendor-logout-btn').addEventListener('click', handleLogout);

// Studio home nav
document.getElementById('nav-assets').addEventListener('click', () => navigate('assets'));
document.getElementById('nav-estimates').addEventListener('click', () => navigate('estimates'));
document.getElementById('nav-workflows').addEventListener('click', () => navigate('workflows'));
document.getElementById('nav-reviews').addEventListener('click', () => navigate('reviews'));
document.getElementById('nav-todos').addEventListener('click', () => navigate('todos'));

// Vendor home nav
document.getElementById('vendor-nav-assets').addEventListener('click', () => navigate('assets'));
document.getElementById('vendor-nav-estimates').addEventListener('click', () => navigate('estimates'));
document.getElementById('vendor-nav-incoming-scope').addEventListener('click', () => navigate('incoming-scope'));
document.getElementById('vendor-nav-todos').addEventListener('click', () => navigate('todos'));

fetch('/api/config')
  .then(r => r.json())
  .then(async ({ airtableUrl, supabaseUrl, supabaseAnonKey }) => {
    // Bootstrap Supabase
    supabaseClient = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

    // Redirect to login on sign-out (handles token expiry)
    supabaseClient.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') navigate('login');
    });

    // Resume an existing session without requiring re-login
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      navigateByRole(session.user?.app_metadata?.role);
    }

    // Wire Airtable deep-link buttons (available to both roles)
    const wireAirtable = (id) => {
      const btn = document.getElementById(id);
      if (airtableUrl) {
        btn.addEventListener('click', () => window.open(airtableUrl, '_blank', 'noopener'));
      } else {
        btn.disabled = true;
        btn.title = 'AIRTABLE_BASE_ID not configured';
      }
    };
    wireAirtable('nav-airtable');
    wireAirtable('vendor-nav-airtable');
  })
  .catch(() => setLoginError('Failed to load app config. Is the server running?'));

document.getElementById('home-btn').addEventListener('click', () => navigate(state.homeView));
document.getElementById('estimates-home-btn').addEventListener('click', () => navigate(state.homeView));
document.getElementById('workflows-home-btn').addEventListener('click', () => navigate(state.homeView));
document.getElementById('reviews-home-btn').addEventListener('click', () => navigate(state.homeView));
document.getElementById('todos-home-btn').addEventListener('click', () => navigate(state.homeView));
document.getElementById('incoming-scope-home-btn').addEventListener('click', () => navigate(state.homeView));
document.getElementById('wfs-manage-btn').addEventListener('click', () => navigate('workflow-steps'));
document.getElementById('wf-steps-back-btn').addEventListener('click', () => navigate('workflows'));

// -- Utilities --

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function apiFetch(path, opts = {}) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { navigate('login'); throw new Error('Not authenticated'); }
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

let toastTimer;
function showToast(msg, type = 'info') {
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

function openDetailModal({ title, badge, fields = [], image, actions = [] }) {
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

function closeDetailModal() {
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

function renderFieldGrid(container, fields, opts = {}) {
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

// -- Asset Manager --

const $amProductList   = $('am-product-list');
const $amNoProduct     = $('am-no-product');
const $amAssetsContent = $('am-assets-content');
const $amProductName   = $('am-product-name');
const $amSelectAll     = $('am-select-all');
const $amAssetList     = $('am-asset-list');
const $amSelCount      = $('am-sel-count');
const $amGenerateBtn   = $('am-generate-btn');
const $amSendVendorBtn = $('am-send-vendor-btn');
const $amGenStatus     = $('am-gen-status');

async function loadProducts() {
  $amProductList.innerHTML = '<div class="list-state">Loading…</div>';
  try {
    state.products = await apiFetch('/api/assets/products');
    renderProductList();
  } catch (err) {
    $amProductList.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderProductList() {
  if (!state.products.length) {
    $amProductList.innerHTML = '<div class="list-state">No products found</div>';
    return;
  }
  $amProductList.innerHTML = state.products.map(p => `
    <div class="am-product-item${state.selectedProductId === p.id ? ' active' : ''}" data-id="${esc(p.id)}">
      ${esc(p.name)}
    </div>
  `).join('');
  $amProductList.querySelectorAll('.am-product-item').forEach(el => {
    el.addEventListener('click', () => selectProduct(el.dataset.id));
  });
}

async function selectProduct(productId) {
  state.selectedProductId = productId;
  state.selectedAssetIds.clear();
  state.focusedAssetId = null;
  renderProductList();
  updateGenerateBar();
  $('am-tasks-content').innerHTML = '<div class="list-state">Select an asset to view its tasks</div>';
  $('am-meta-content').innerHTML  = '<div class="list-state">Select an asset to view details</div>';

  const product = state.products.find(p => p.id === productId);
  $amProductName.textContent = product?.name ?? '';
  $amSelectAll.checked = false;
  $amAssetList.innerHTML = '<div class="list-state">Loading…</div>';
  $amNoProduct.style.display = 'none';
  $amAssetsContent.style.display = 'flex';

  try {
    state.assets = await apiFetch(`/api/assets?productId=${encodeURIComponent(productId)}`);
    renderAssetList();
  } catch (err) {
    $amAssetList.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderAssetList() {
  if (!state.assets.length) {
    $amAssetList.innerHTML = '<div class="list-state">No assets for this product</div>';
    return;
  }
  $amAssetList.innerHTML = state.assets.map(a => `
    <div class="am-asset-row${state.focusedAssetId === a.id ? ' am-asset-focused' : ''}" data-id="${esc(a.id)}">
      <input type="checkbox" class="am-asset-check" data-id="${esc(a.id)}"
             ${state.selectedAssetIds.has(a.id) ? 'checked' : ''}>
      <div class="am-asset-info">
        <div class="am-asset-name" title="${esc(a.name)}">${esc(a.name || '—')}</div>
        <div class="am-asset-meta">
          <span class="tag">${esc(a.itemType || '—')}</span>
          ${a.priority != null ? `<span class="prio prio-${a.priority}">P${a.priority}</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  $amAssetList.querySelectorAll('.am-asset-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.type === 'checkbox') return;
      focusAsset(row.dataset.id);
    });
    row.querySelector('.am-asset-check').addEventListener('change', e => {
      toggleAsset(row.dataset.id, e.target.checked);
    });
  });
}

function toggleAsset(id, force) {
  const checked = force !== undefined ? force : !state.selectedAssetIds.has(id);
  if (checked) state.selectedAssetIds.add(id);
  else state.selectedAssetIds.delete(id);

  const row = $amAssetList.querySelector(`.am-asset-row[data-id="${id}"]`);
  if (row) row.querySelector('.am-asset-check').checked = checked;
  $amSelectAll.checked = state.assets.length > 0 && state.assets.every(a => state.selectedAssetIds.has(a.id));
  updateGenerateBar();
}

async function focusAsset(id) {
  state.focusedAssetId = id;
  renderAssetList();

  const asset = state.assets.find(a => a.id === id);
  state.focusedAsset = asset;
  renderAssetMeta(asset);

  $('am-tasks-content').innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const tasks = await apiFetch(`/api/schedule/tasks?assetId=${encodeURIComponent(id)}`);
    renderAssetTasks(tasks);
  } catch (err) {
    $('am-tasks-content').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderAssetTasks(tasks) {
  state.lastTasks = tasks;
  if (!tasks.length) {
    $('am-tasks-content').innerHTML = '<div class="list-state">No tasks yet — use Generate Work to create them.</div>';
    return;
  }
  if (state.taskView === 'timeline') {
    renderAssetTasksTimeline(tasks);
  } else {
    renderAssetTasksList(tasks);
  }
}

function renderAssetTasksList(tasks) {
  $('am-tasks-content').innerHTML = tasks.map(t => `
    <div class="am-task-row" data-task-id="${esc(t.id)}" data-task-name="${esc(t.task)}">
      <div>
        <div class="am-task-name">${esc(t.task)}</div>
        <div class="am-task-dates">${esc(t.startDate ? fmtDate(t.startDate) : '—')} → ${esc(t.endDate ? fmtDate(t.endDate) : '—')}</div>
      </div>
      <div class="am-task-estimate">${t.estimate != null ? t.estimate + 'd' : '—'}</div>
    </div>
  `).join('');
}

function renderAssetTasksTimeline(tasks) {
  const dated = tasks
    .filter(t => t.startDate && t.endDate)
    .map(t => ({ ...t, start: new Date(t.startDate), end: new Date(t.endDate) }));

  if (!dated.length) {
    $('am-tasks-content').innerHTML = '<div class="list-state">No dated tasks to display.</div>';
    return;
  }

  const minMs = Math.min(...dated.map(t => t.start.getTime()));
  const maxMs = Math.max(...dated.map(t => t.end.getTime()));
  const rangeMs = maxMs - minMs || 1;

  const pct  = ms    => ((ms - minMs) / rangeMs * 100).toFixed(2);
  const wPct = (s, e) => ((e - s) / rangeMs * 100).toFixed(2);

  const now = Date.now();
  const todayMarker = (now >= minMs && now <= maxMs)
    ? `<div class="am-timeline-today" style="left:${pct(now)}%"></div>`
    : '';

  // Month boundary labels
  const months = [];
  const cursor = new Date(new Date(minMs).getFullYear(), new Date(minMs).getMonth(), 1);
  while (cursor.getTime() <= maxMs) {
    const p = Math.max(0, pct(cursor.getTime()));
    months.push(`<span class="am-timeline-month" style="left:${p}%">${cursor.toLocaleString('default', { month: 'short' })} ${cursor.getFullYear()}</span>`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  const rows = dated.map(t => `
    <div class="am-timeline-row am-task-row" data-task-id="${esc(t.id)}" data-task-name="${esc(t.task)}">
      <div class="am-timeline-label" title="${esc(t.task)}">${esc(t.task)}</div>
      <div class="am-timeline-track">
        ${todayMarker}
        <div class="am-timeline-bar" style="left:${pct(t.start.getTime())}%;width:${wPct(t.start, t.end)}%">
          ${t.estimate != null ? `<span>${t.estimate}d</span>` : ''}
        </div>
      </div>
    </div>
  `).join('');

  $('am-tasks-content').innerHTML = `
    <div class="am-timeline">
      <div class="am-timeline-header-row">
        <div class="am-timeline-label"></div>
        <div class="am-timeline-track am-timeline-months">
          ${months.join('')}
          ${todayMarker}
        </div>
      </div>
      ${rows}
    </div>
  `;
}

// Event delegation — wired once, survives re-renders
$('am-tasks-content').addEventListener('click', e => {
  const row = e.target.closest('.am-task-row[data-task-id]');
  if (row) openTaskDetail(row.dataset.taskId, row.dataset.taskName);
});

// Task view toggle
function setTaskView(view) {
  state.taskView = view;
  $('am-tasks-list-btn').classList.toggle('active', view === 'list');
  $('am-tasks-timeline-btn').classList.toggle('active', view === 'timeline');
  if (state.lastTasks) renderAssetTasks(state.lastTasks);
}
$('am-tasks-list-btn').addEventListener('click', () => setTaskView('list'));
$('am-tasks-timeline-btn').addEventListener('click', () => setTaskView('timeline'));

// Maps field names that hold record references to the table key used in /api/records/{key}/{id}.
// Extend this as new linked entities are added. When migrating to Postgres, update
// the resolve functions that call /api/records — the map itself stays the same.
const LINKED_TABLE_MAP = {
  'Asset':  'assets',
  'Assets': 'assets',
};

// Converts a raw field value dict into a FieldDef array for renderFieldGrid.
// Handles dates, arrays, and primitive types. Does not attempt link resolution —
// callers wire resolve() separately for known reference fields.
function formatRawFields(rawFields) {
  return Object.entries(rawFields)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      let display;
      if (Array.isArray(v)) {
        const allRecIds = v.every(x => typeof x === 'string' && x.startsWith('rec'));
        display = allRecIds
          ? `${v.length} linked record${v.length !== 1 ? 's' : ''}`
          : v.join(', ');
      } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        display = fmtDate(v.slice(0, 10));
      } else {
        display = String(v);
      }
      return { label: k, value: display };
    });
}

// Builds the resolve function for a single linked-record reference.
function makeRecordResolver(tableKey, recordId, fallbackTitle) {
  return async () => {
    const { fields } = await apiFetch(`/api/records/${tableKey}/${encodeURIComponent(recordId)}`);
    // Try common primary-field names, then fall back to the first string value, then fallbackTitle
    const title = fields.Name || fields.name
      || Object.values(fields).find(v => typeof v === 'string' && v.length > 0)
      || fallbackTitle;
    return { title, fields: formatRawFields(fields) };
  };
}

async function openTaskDetail(taskId, taskName) {
  openDetailModal({ title: taskName, fields: [{ label: '', value: 'Loading…' }] });
  try {
    const { fields, displayFields = {} } = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}`);
    const SKIP = new Set(['Task']);
    const entries = [];

    for (const [k, v] of Object.entries(fields)) {
      if (SKIP.has(k) || v == null || v === '') continue;

      const isRecArray = Array.isArray(v) && v.length > 0 &&
        v.every(x => typeof x === 'string' && x.startsWith('rec'));

      if (isRecArray) {
        const tableKey = LINKED_TABLE_MAP[k];
        if (tableKey && v.length === 1) {
          // Single reference to a known entity — make it navigable
          const displayName = displayFields[k] || v[0];
          entries.push({
            label: k,
            value: displayName,
            type: 'linked-record',
            resolve: makeRecordResolver(tableKey, v[0], displayName),
          });
        } else {
          // Multiple references or unknown table — show display string
          const display = displayFields[k] ||
            (tableKey ? `${v.length} linked record${v.length !== 1 ? 's' : ''}` : v.join(', '));
          entries.push({ label: k, value: display });
        }
      } else {
        // Regular field — prefer display string (resolves lookups, formats dates)
        const display = (displayFields[k] != null && displayFields[k] !== '')
          ? displayFields[k]
          : (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v))
            ? fmtDate(v.slice(0, 10))
            : String(v);
        entries.push({ label: k, value: display });
      }
    }

    openDetailModal({
      title: taskName,
      fields: entries.length ? entries : [{ label: 'No fields', value: null }],
    });
  } catch (err) {
    closeDetailModal();
    showToast(err.message, 'error');
  }
}

const FIELD_SETTINGS_KEY = 'arthound:assetDetailFields';

const BUILTIN_FIELDS = [
  { key: 'name',        label: 'Name' },
  { key: 'devName',     label: 'Dev Name' },
  { key: 'itemType',    label: 'Item Type' },
  { key: 'product',     label: 'Product' },
  { key: 'team',        label: 'Team' },
  { key: 'priority',    label: 'Priority' },
  { key: 'projectDate', label: 'Project Date' },
  { key: 'assetNumber', label: 'Asset #' },
];

const DEFAULT_BUILTINS = BUILTIN_FIELDS.map(f => f.key);

function loadFieldSettings() {
  try {
    const raw = localStorage.getItem(FIELD_SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

function saveFieldSettings(settings) {
  localStorage.setItem(FIELD_SETTINGS_KEY, JSON.stringify(settings));
}

function getBuiltinValue(asset, key) {
  if (key === 'priority') return asset.priority != null ? `P${asset.priority}` : null;
  if (key === 'projectDate') return asset.projectDate ? fmtDate(asset.projectDate.slice(0, 10)) : null;
  return asset[key] ?? null;
}

function renderAssetMeta(asset) {
  if (!asset) return;
  const settings = loadFieldSettings();
  const enabledBuiltins = settings ? settings.builtins : DEFAULT_BUILTINS;
  const extras = settings ? (settings.extras || []) : [];

  const fields = [
    ...BUILTIN_FIELDS
      .filter(f => enabledBuiltins.includes(f.key))
      .map(f => {
        const value = getBuiltinValue(asset, f.key);
        if (f.key === 'product' && asset.productId && value) {
          return {
            label: f.label, value,
            type: 'linked-record',
            resolve: makeRecordResolver('products', asset.productId, value),
          };
        }
        return { label: f.label, value };
      })
      .filter(f => f.value != null && f.value !== ''),
    ...extras
      .map(fname => ({ label: fname, value: asset.rawFields?.[fname] ?? null }))
      .filter(f => f.value != null && f.value !== ''),
  ];

  renderFieldGrid('am-meta-content', fields);
}

// -- Field settings modal --

const $fieldSettingsOverlay = $('field-settings-overlay');
const $fieldSettingsBody    = $('field-settings-body');
const $fieldSettingsBtn     = $('am-detail-fields-btn');
const $fieldSettingsClose   = $('field-settings-close');
const $fieldSettingsSave    = $('field-settings-save');

const BUILTIN_AIRTABLE_NAMES = new Set([
  'Name', 'Dev Name', 'ID', 'Product', 'Item Type',
  'Team (from Product)', 'Priority', 'Milestone 4 [Dates]',
]);

$fieldSettingsBtn.addEventListener('click', openFieldSettings);
$fieldSettingsClose.addEventListener('click', () => $fieldSettingsOverlay.classList.remove('open'));
$fieldSettingsOverlay.addEventListener('click', e => {
  if (e.target === $fieldSettingsOverlay) $fieldSettingsOverlay.classList.remove('open');
});

async function openFieldSettings() {
  $fieldSettingsOverlay.classList.add('open');
  $fieldSettingsBody.innerHTML = '<div class="list-state">Loading fields…</div>';

  const settings = loadFieldSettings() || { builtins: [...DEFAULT_BUILTINS], extras: [] };

  let additionalFields = [];
  try {
    const fields = await apiFetch('/api/assets/fields');
    additionalFields = fields.filter(f => !BUILTIN_AIRTABLE_NAMES.has(f.name));
  } catch (_) {
    // Fallback: derive from rawFields already present on loaded assets
    const allRawNames = new Set();
    state.assets.forEach(a => Object.keys(a.rawFields || {}).forEach(k => allRawNames.add(k)));
    additionalFields = [...allRawNames]
      .filter(name => !BUILTIN_AIRTABLE_NAMES.has(name))
      .sort()
      .map(name => ({ name }));
  }

  $fieldSettingsBody.innerHTML = `
    <div class="field-settings-section">
      <div class="field-settings-section-title">Default Fields</div>
      ${BUILTIN_FIELDS.map(f => `
        <label class="field-settings-item">
          <input type="checkbox" name="builtin" value="${esc(f.key)}"
                 ${settings.builtins.includes(f.key) ? 'checked' : ''}>
          <span>${esc(f.label)}</span>
        </label>
      `).join('')}
    </div>
    ${additionalFields.length ? `
      <div class="field-settings-section">
        <div class="field-settings-section-title">Additional Airtable Fields</div>
        ${additionalFields.map(f => `
          <label class="field-settings-item">
            <input type="checkbox" name="extra" value="${esc(f.name)}"
                   ${settings.extras.includes(f.name) ? 'checked' : ''}>
            <span>${esc(f.name)}</span>
          </label>
        `).join('')}
      </div>
    ` : '<p class="field-settings-hint">No additional fields found.</p>'}
  `;
}

$fieldSettingsSave.addEventListener('click', () => {
  const builtins = [...$fieldSettingsBody.querySelectorAll('input[name="builtin"]:checked')].map(el => el.value);
  const extras   = [...$fieldSettingsBody.querySelectorAll('input[name="extra"]:checked')].map(el => el.value);
  saveFieldSettings({ builtins, extras });
  $fieldSettingsOverlay.classList.remove('open');
  if (state.focusedAsset) renderAssetMeta(state.focusedAsset);
});

$amSelectAll.addEventListener('change', () => {
  const checked = $amSelectAll.checked;
  state.assets.forEach(a => {
    if (checked) state.selectedAssetIds.add(a.id);
    else state.selectedAssetIds.delete(a.id);
  });
  renderAssetList();
  updateGenerateBar();
});

function updateGenerateBar() {
  const n = state.selectedAssetIds.size;
  $amSelCount.textContent = n === 0 ? 'No assets selected' : `${n} asset${n !== 1 ? 's' : ''} selected`;
  $amGenerateBtn.disabled = n === 0;
  $amSendVendorBtn.disabled = n === 0;
  $amGenStatus.innerHTML = '';
}

$amSendVendorBtn.addEventListener('click', openSendVendorModal);

$amGenerateBtn.addEventListener('click', async () => {
  const assetIds = [...state.selectedAssetIds];
  if (!assetIds.length) return;

  $amGenerateBtn.disabled = true;
  $amGenerateBtn.textContent = 'Generating…';
  $amGenStatus.innerHTML = '';

  try {
    const result = await apiFetch('/api/schedule/generate-bulk', {
      method: 'POST',
      body: JSON.stringify({ assetIds }),
    });
    const failMsg = result.failed?.length ? ` · ${result.failed.length} failed` : '';
    const warnMsg = result.warnings?.length ? ` · ${result.warnings.length} steps skipped (no estimate)` : '';
    $amGenStatus.innerHTML = `<span class="status-ok">✓ ${result.created} tasks written${failMsg}${warnMsg}</span>`
      + (result.warnings?.length ? `<ul class="gen-warnings">${result.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : '');
    showToast(`${result.created} tasks created for ${assetIds.length} assets`, 'success');
    // Refresh task panel if the focused asset was part of this batch
    if (state.focusedAssetId && assetIds.includes(state.focusedAssetId)) {
      const tasks = await apiFetch(`/api/schedule/tasks?assetId=${encodeURIComponent(state.focusedAssetId)}`);
      renderAssetTasks(tasks);
    }
  } catch (err) {
    $amGenStatus.innerHTML = `<span class="status-err">✗ ${esc(err.message)}</span>`;
    showToast(err.message, 'error');
  } finally {
    $amGenerateBtn.disabled = false;
    $amGenerateBtn.textContent = 'Generate Work';
  }
});

// -- Vendor Inbox (Incoming Scope) --

async function loadVendorInbox() {
  $('is-inbox-list').innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const dispatches = await apiFetch('/api/payloads/vendor-inbox');
    renderVendorInbox(dispatches);
  } catch (err) {
    $('is-inbox-list').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderVendorInbox(dispatches) {
  if (!dispatches.length) {
    $('is-inbox-list').innerHTML = '<div class="list-state">No incoming assets yet</div>';
    return;
  }
  $('is-inbox-list').innerHTML = dispatches.map(d => {
    const data        = d.payload_data?.data ?? {};
    const name        = data['Name'] || data['name'] || '—';
    const itemType    = data['Item Type'] || data['item_type'] || '';
    const priority    = data['Priority'];
    const studioName  = d.payload_data?.sender_studio_name || 'Unknown Studio';
    const date        = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—';
    return `
      <div class="is-inbox-card">
        <div class="am-asset-info">
          <div class="am-asset-name">${esc(name)}</div>
          <div class="am-asset-meta">
            ${itemType ? `<span class="tag">${esc(itemType)}</span>` : ''}
            ${priority != null ? `<span class="prio prio-${priority}">P${priority}</span>` : ''}
          </div>
        </div>
        <div class="is-inbox-meta">
          <span class="is-inbox-from">${esc(studioName)}</span>
          <span class="is-inbox-date">${esc(date)}</span>
        </div>
      </div>
    `;
  }).join('');
}

$('is-refresh-btn').addEventListener('click', loadVendorInbox);

// -- Send to Vendor wizard --

const sendVendorState = { step: 1, vendorId: null, vendorName: null, vendors: [], existingShares: [] };
const $svOverlay = $('send-vendor-overlay');

function svWizardSteps(active) {
  return ['Vendor', 'Review', 'Send'].map((label, i) => {
    const n   = i + 1;
    const cls = n < active ? 'wstep done' : n === active ? 'wstep active' : 'wstep';
    const num = n < active ? '✓' : String(n);
    const sep = i < 2 ? '<div class="wstep-connector"></div>' : '';
    return `<div class="${cls}"><span class="wstep-num">${num}</span>${label}</div>${sep}`;
  }).join('');
}

function renderSvStep1() {
  $('sv-steps').innerHTML = svWizardSteps(1);

  const sharesHtml = sendVendorState.existingShares.length ? `
    <div class="sv-shares-section">
      <div class="sv-shares-label">Currently shared with</div>
      ${sendVendorState.existingShares.map(d => {
        const vendor = sendVendorState.vendors.find(v => v.id === d.recipient_vendor_id);
        const vName  = vendor?.name ?? 'Unknown Vendor';
        const date   = d.created_at ? new Date(d.created_at).toLocaleDateString() : '—';
        return `
          <div class="sv-share-row">
            <div class="sv-share-info">
              <span class="sv-share-vendor">${esc(vName)}</span>
              <span class="sv-share-date">${esc(date)}</span>
            </div>
            <button class="btn btn-danger btn-sm sv-revoke-btn" data-id="${esc(d.id)}">Revoke</button>
          </div>`;
      }).join('')}
    </div>` : '';

  $('sv-body').innerHTML = `
    <div class="wfs-form-field">
      <label class="wfs-form-label">Send to Vendor</label>
      <select class="wfs-form-input" id="sv-vendor-select">
        <option value="">— Choose a vendor —</option>
        ${sendVendorState.vendors.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('')}
      </select>
    </div>
    <p style="color:var(--text-muted);font-size:13px;margin:8px 0 0">
      ${state.selectedAssetIds.size} asset${state.selectedAssetIds.size !== 1 ? 's' : ''} selected
    </p>
    ${sharesHtml}
  `;
  $('sv-footer').innerHTML = `
    <button class="btn btn-secondary" id="sv-cancel">Cancel</button>
    <button class="btn btn-primary" id="sv-next" disabled>Next</button>
  `;
  $('sv-cancel').addEventListener('click', closeSendVendorModal);
  $('sv-vendor-select').addEventListener('change', e => {
    const v = sendVendorState.vendors.find(v => v.id === e.target.value);
    sendVendorState.vendorId   = v?.id   ?? null;
    sendVendorState.vendorName = v?.name ?? null;
    $('sv-next').disabled = !sendVendorState.vendorId;
  });
  $('sv-next').addEventListener('click', () => { sendVendorState.step = 2; renderSvStep2(); });
  $('sv-body').querySelectorAll('.sv-revoke-btn').forEach(btn => {
    btn.addEventListener('click', () => revokeShare(btn.dataset.id, btn));
  });
}

async function revokeShare(dispatchId, btn) {
  btn.disabled = true;
  btn.textContent = 'Revoking…';
  try {
    await apiFetch(`/api/payloads/dispatch/${encodeURIComponent(dispatchId)}`, { method: 'DELETE' });
    sendVendorState.existingShares = sendVendorState.existingShares.filter(d => d.id !== dispatchId);
    renderSvStep1();
    showToast('Share revoked', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Revoke';
  }
}

function renderSvStep2() {
  $('sv-steps').innerHTML = svWizardSteps(2);
  const selected = state.assets.filter(a => state.selectedAssetIds.has(a.id));
  $('sv-body').innerHTML = `
    <p style="color:var(--text-muted);font-size:13px;margin:0 0 10px">
      Sending to <strong style="color:var(--text)">${esc(sendVendorState.vendorName)}</strong>:
    </p>
    <div class="sv-asset-list">
      ${selected.map(a => `
        <div class="am-asset-row">
          <div class="am-asset-info">
            <div class="am-asset-name">${esc(a.name || '—')}</div>
            <div class="am-asset-meta">
              <span class="tag">${esc(a.itemType || '—')}</span>
              ${a.priority != null ? `<span class="prio prio-${a.priority}">P${a.priority}</span>` : ''}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  $('sv-footer').innerHTML = `
    <button class="btn btn-secondary" id="sv-back">Back</button>
    <button class="btn btn-primary" id="sv-send">Send ${selected.length} Asset${selected.length !== 1 ? 's' : ''}</button>
  `;
  $('sv-back').addEventListener('click', () => { sendVendorState.step = 1; renderSvStep1(); });
  $('sv-send').addEventListener('click', dispatchAssetsToVendor);
}

function renderSvStep3(dispatched) {
  $('sv-steps').innerHTML = svWizardSteps(3);
  $('sv-body').innerHTML = `
    <div style="text-align:center;padding:28px 0">
      <div style="font-size:28px;color:var(--ok);margin-bottom:10px">✓</div>
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">${dispatched} asset${dispatched !== 1 ? 's' : ''} sent</div>
      <div style="color:var(--text-muted);font-size:13px">Delivered to ${esc(sendVendorState.vendorName)}</div>
    </div>
  `;
  $('sv-footer').innerHTML = `<button class="btn btn-primary" id="sv-done">Done</button>`;
  $('sv-done').addEventListener('click', closeSendVendorModal);
}

async function dispatchAssetsToVendor() {
  const assets = state.assets
    .filter(a => state.selectedAssetIds.has(a.id) && a.canonicalId)
    .map(a => ({ asset_id: a.canonicalId, asset_data: a.rawFields ?? {} }));

  if (!assets.length) {
    showToast('No assets with canonical IDs — load the Asset Manager first', 'error');
    return;
  }

  const btn = $('sv-send');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const result = await apiFetch('/api/payloads/dispatch-bulk', {
      method: 'POST',
      body: JSON.stringify({ vendor_id: sendVendorState.vendorId, assets }),
    });
    renderSvStep3(result.dispatched);
    showToast(`${result.dispatched} assets sent to ${sendVendorState.vendorName}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = `Send ${assets.length} Asset${assets.length !== 1 ? 's' : ''}`;
  }
}

async function openSendVendorModal() {
  sendVendorState.step = 1;
  sendVendorState.vendorId = null;
  sendVendorState.vendorName = null;
  sendVendorState.existingShares = [];
  $svOverlay.classList.add('open');
  $('sv-body').innerHTML = '<div class="list-state">Loading…</div>';
  $('sv-footer').innerHTML = '';
  $('sv-steps').innerHTML = svWizardSteps(1);
  try {
    const selectedCanonicalIds = new Set(
      state.assets.filter(a => state.selectedAssetIds.has(a.id) && a.canonicalId).map(a => a.canonicalId)
    );
    const [vendors, outbox] = await Promise.all([
      apiFetch('/api/payloads/vendors'),
      apiFetch('/api/payloads/outbox'),
    ]);
    sendVendorState.vendors = vendors;
    sendVendorState.existingShares = outbox.filter(
      d => selectedCanonicalIds.has(d.asset_id) && !d.revoked_at
    );
    renderSvStep1();
  } catch (err) {
    $('sv-body').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function closeSendVendorModal() { $svOverlay.classList.remove('open'); }

$('sv-close').addEventListener('click', closeSendVendorModal);
$svOverlay.addEventListener('click', e => { if (e.target === $svOverlay) closeSendVendorModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $svOverlay.classList.contains('open')) closeSendVendorModal();
});

// (legacy schedule rendering kept for potential reuse)

function renderSchedule() {
  if (!window._schedule) return;

  const tasks = [...state.schedule.tasks].sort((a, b) =>
    a.startDate.localeCompare(b.startDate)
  );

  const col = state.schedule.asset?.estimateCol;
  $taskCount.textContent = `${tasks.length} task${tasks.length !== 1 ? 's' : ''}`;

  if (tasks.length === 0) {
    $tbody.innerHTML = `
      <tr><td colspan="5" class="schedule-empty-hint">
        No tasks with estimates found.
        ${col ? `Looking for column <code>${esc(col)}</code> in Task Templates — create it via the ⚙ wizard or add it directly in Airtable and fill in day values.` : ''}
      </td></tr>
    `;
    // no tasks
  }
}

// -- Timeline --

const TL_PALETTE = ['#7c6af4','#34d399','#60a5fa','#fbbf24','#f97316','#e879f9','#94a3b8','#f87171'];

function renderTimeline(tasks) {
  const $tl = document.getElementById('timeline-view');

  const parsed = tasks.map(t => ({
    ...t,
    s: new Date(t.startDate),
    e: new Date(t.endDate),
  }));

  const minMs  = Math.min(...parsed.map(t => +t.s));
  const maxMs  = Math.max(...parsed.map(t => +t.e));
  const spanMs = maxMs - minMs || 1;

  function leftPct(ms)     { return ((ms - minMs) / spanMs * 100).toFixed(3); }
  function widthPct(s, e)  { return (Math.max(+e - +s, spanMs * 0.008) / spanMs * 100).toFixed(3); }

  // Assign a stable color per craft name
  const craftColor = {};
  let ci = 0;
  parsed.forEach(t => { if (t.craft && !craftColor[t.craft]) craftColor[t.craft] = TL_PALETTE[ci++ % TL_PALETTE.length]; });

  // Month markers: first of each month spanning the range
  const markers = [];
  const cur = new Date(new Date(minMs).getFullYear(), new Date(minMs).getMonth(), 1);
  while (+cur <= maxMs) {
    markers.push({ ms: +cur, label: cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }) });
    cur.setMonth(cur.getMonth() + 1);
  }

  $tl.innerHTML = `
    <div class="tl-chart">
      <div class="tl-labels">
        <div class="tl-label-hdr"></div>
        ${parsed.map(t => `<div class="tl-label" title="${esc(t.taskName)}">${esc(t.taskName)}</div>`).join('')}
      </div>
      <div class="tl-canvas">
        <div class="tl-month-row">
          ${markers.map(m => `
            <span class="tl-month-marker" style="left:${Math.max(0, leftPct(m.ms))}%">${esc(m.label)}</span>
          `).join('')}
        </div>
        ${markers.map(m => +m.ms >= minMs
          ? `<span class="tl-vline" style="left:${leftPct(m.ms)}%"></span>`
          : '').join('')}
        <div class="tl-rows">
          ${parsed.map(t => {
            const color = craftColor[t.craft] || TL_PALETTE[0];
            return `
              <div class="tl-row">
                <div class="tl-bar" style="left:${leftPct(t.s)}%;width:${widthPct(t.s, t.e)}%;background:${color}"
                     title="${esc(t.taskName)} · ${t.estimate}d · ${t.startDate} → ${t.endDate}">
                  <span class="tl-bar-label">${esc(t.craft)}</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

// -- Setup wizard --

const $setupOverlay = $('setup-overlay');
const $setupBtn     = $('est-setup-btn');
const $setupClose   = $('setup-close');
const $setupBody    = $('setup-body');
const $wizardSteps  = $('wizard-steps');
const $wizardFooter = $('wizard-footer');

const WIZARD_STEP_LABELS = ['Variables', 'Values', 'Matrix', 'Options', 'Create'];

const wizard = {
  step:          1,
  mode:          'airtable',  // 'airtable' | 'arthound'
  fields:        [],          // [{id, name, type}] — eligible fields
  selected:      new Set(),   // selected field names
  values:        {},          // fieldName → [{id, name}]
  combos:        [],          // [{label, values: {field: {id, name}}}]
  excluded:      new Set(),   // indices of combos to skip
  filters:       {},          // fieldName → Set<value name> (included values)
  groupBy:       '',          // field name to group rows by, or ''
  result:        null,
  existingCombos: null,       // combinations present in the assets table (from step 2)
  prefillCol:    '',          // colName to copy values from into new columns (step 4)
  clearExisting: false,       // delete previous config columns before creating new ones (step 4)
};

$setupBtn.addEventListener('click', () => openSetup('airtable'));
$('est-pg-setup-btn').addEventListener('click', () => openSetup('arthound'));
$setupClose.addEventListener('click', () => $setupOverlay.classList.remove('open'));
$setupOverlay.addEventListener('click', e => { if (e.target === $setupOverlay) $setupOverlay.classList.remove('open'); });

async function openSetup(mode = 'airtable') {
  wizard.step     = 1;
  wizard.mode     = mode;
  wizard.selected = new Set();
  wizard.values   = {};
  wizard.combos   = [];
  wizard.excluded = new Set();
  wizard.filters  = {};
  wizard.groupBy  = '';
  wizard.result   = null;
  $('setup-modal-title').textContent =
    mode === 'arthound' ? 'ArtHound Matrix Setup' : 'Estimation Engine Setup';
  $setupOverlay.classList.add('open');
  await renderWizardStep();
}

function renderWizardNav() {
  $wizardSteps.innerHTML = WIZARD_STEP_LABELS.map((label, i) => {
    const n = i + 1;
    const cls = n < wizard.step ? 'done' : n === wizard.step ? 'active' : '';
    return `<div class="wstep ${cls}"><span class="wstep-num">${n < wizard.step ? '✓' : n}</span>${label}</div>`;
  }).join('<div class="wstep-connector"></div>');
}

async function renderWizardStep() {
  renderWizardNav();
  $setupBody.innerHTML = '<div class="list-state">Loading…</div>';
  $wizardFooter.innerHTML = '';

  if (wizard.step === 1) await renderStep1();
  else if (wizard.step === 2) await renderStep2();
  else if (wizard.step === 3) renderStep3();
  else if (wizard.step === 4) await renderStep4();
  else if (wizard.step === 5) await renderStep5();
}

// Step 1 — pick variable fields
async function renderStep1() {
  try {
    if (!wizard.fields.length) {
      const data = await apiFetch('/api/setup/fields');
      wizard.fields = data.fields;
    }

    $setupBody.innerHTML = `
      <div class="wizard-section-title">Select the fields that drive your estimation variables</div>
      <div class="wizard-section-sub">These are the fields whose combinations determine which estimate to use (e.g. Item Type, Team, Priority).</div>
      <div class="wizard-field-list" id="wfield-list">
        ${wizard.fields.map(f => `
          <label class="wizard-field-row">
            <input type="checkbox" value="${esc(f.name)}" ${wizard.selected.has(f.name) ? 'checked' : ''}>
            <span class="wf-name">${esc(f.name)}</span>
            <span class="ftype ftype-${esc(f.type === 'multipleRecordLinks' ? 'link' : f.type === 'singleSelect' || f.type === 'multipleSelects' ? 'select' : 'number')}">${esc(f.type)}</span>
          </label>
        `).join('')}
      </div>
    `;

    document.querySelectorAll('#wfield-list input').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) wizard.selected.add(cb.value);
        else wizard.selected.delete(cb.value);
      });
    });
  } catch (err) {
    $setupBody.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }

  $wizardFooter.innerHTML = `
    <div></div>
    <button class="btn btn-primary" id="w-next">Next →</button>
  `;
  $('w-next').addEventListener('click', async () => {
    if (!wizard.selected.size) return showToast('Select at least one variable field', 'error');
    wizard.step = 2;
    await renderWizardStep();
  });
}

// Step 2 — review discovered values per field + existing asset combinations
async function renderStep2() {
  const fields = [...wizard.selected];

  try {
    for (const field of fields) {
      if (!wizard.values[field]) {
        const data = await apiFetch(`/api/setup/field-values?field=${encodeURIComponent(field)}`);
        wizard.values[field] = data.values;
      }
    }

    $setupBody.innerHTML = `
      ${fields.map(field => {
        const vals = wizard.values[field] || [];
        return `
          <div class="wizard-value-group">
            <div class="wizard-value-heading">${esc(field)} <span class="badge">${vals.length} values</span></div>
            <div class="wizard-value-chips">
              ${vals.map(v => `<span class="value-chip">${esc(v.name)}</span>`).join('')}
            </div>
          </div>
        `;
      }).join('')}
      <div class="wizard-combos-section">
        <div class="wizard-combos-heading">
          <span class="wizard-section-title">Existing Asset Combinations</span>
          <span class="wizard-section-sub">Unique combinations currently present in the Assets table</span>
        </div>
        <div id="wizard-asset-combos"><div class="list-state">Loading…</div></div>
      </div>
    `;
  } catch (err) {
    $setupBody.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }

  $wizardFooter.innerHTML = `
    <button class="btn btn-ghost" id="w-back">← Back</button>
    <button class="btn btn-primary" id="w-next">Next →</button>
  `;
  $('w-back').addEventListener('click', async () => { wizard.step = 1; await renderWizardStep(); });
  $('w-next').addEventListener('click', async () => {
    buildCombinations();
    wizard.step = 3;
    await renderWizardStep();
  });

  // Fetch existing asset combinations asynchronously so the step renders immediately
  const combosEl = document.getElementById('wizard-asset-combos');
  if (!combosEl) return;
  try {
    const qs = fields.map(f => `field=${encodeURIComponent(f)}`).join('&');
    const data = await apiFetch(`/api/setup/asset-combinations?${qs}`);
    wizard.existingCombos = data.combinations;
    if (!data.combinations.length) {
      combosEl.innerHTML = '<div class="list-state">No assets with all variable fields populated.</div>';
      return;
    }
    combosEl.innerHTML = `
      <div class="table-wrapper">
        <table class="schedule-table">
          <thead><tr>
            ${fields.map(f => `<th>${esc(f)}</th>`).join('')}
            <th class="combo-count-col">Assets</th>
          </tr></thead>
          <tbody>
            ${data.combinations.map(c => `
              <tr>
                ${fields.map(f => `<td>${esc(c.values[f] ?? '—')}</td>`).join('')}
                <td class="combo-count-col"><span class="badge">${c.count}</span></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    combosEl.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function buildCombinations() {
  const fields = [...wizard.selected];
  const valueSets = fields.map(f => wizard.values[f] || []);
  let combos = [{}];
  fields.forEach((field, i) => {
    combos = combos.flatMap(partial =>
      valueSets[i].map(v => ({ ...partial, [field]: v }))
    );
  });
  wizard.combos = combos.map(values => ({
    label: fields.map(f => values[f]?.name ?? '?').join(' | '),
    values,
  }));
}

// Step 3 — preview the matrix with filtering, grouping, and per-row selection
function renderStep3() {
  const fields = [...wizard.selected];
  const total  = wizard.combos.length;

  // Match each combo against combinations present in the assets table
  const existingIndices = new Set();
  if (wizard.existingCombos?.length) {
    wizard.combos.forEach((combo, i) => {
      if (wizard.existingCombos.some(ec => fields.every(f => combo.values[f]?.name === ec.values[f]))) {
        existingIndices.add(i);
      }
    });
  }

  // Default selection: existing combos selected, all others unselected
  wizard.excluded.clear();
  wizard.combos.forEach((_, i) => { if (!existingIndices.has(i)) wizard.excluded.add(i); });

  // Initialize per-field filters: all values included by default
  fields.forEach(f => {
    if (!wizard.filters[f]) {
      wizard.filters[f] = new Set((wizard.values[f] || []).map(v => v.name));
    }
  });

  // ---- Pure helpers ----

  function getVisibleIndices() {
    return wizard.combos.reduce((acc, c, i) => {
      if (fields.every(f => {
        const v  = c.values[f]?.name ?? '';
        const fs = wizard.filters[f];
        return !fs || fs.has(v);
      })) acc.push(i);
      return acc;
    }, []);
  }

  function selectedCount() { return total - wizard.excluded.size; }

  // ---- DOM helpers (run after initial render) ----

  function updateSubtitle() {
    const el = document.getElementById('matrix-sub-text');
    if (el) el.innerHTML = `${selectedCount()} of ${total} combination${total !== 1 ? 's' : ''} selected — will be added as columns to <strong>Task Templates</strong>.`;
  }

  function updateAllCb() {
    const allCb = document.getElementById('matrix-all');
    if (!allCb) return;
    const vis  = getVisibleIndices();
    if (!vis.length) { allCb.checked = false; allCb.indeterminate = false; return; }
    const excl = vis.filter(i => wizard.excluded.has(i)).length;
    allCb.checked       = excl === 0;
    allCb.indeterminate = excl > 0 && excl < vis.length;
  }

  function buildTbody() {
    const vis        = getVisibleIndices();
    const existVis   = vis.filter(i =>  existingIndices.has(i));
    const otherVis   = vis.filter(i => !existingIndices.has(i));

    if (!vis.length) {
      return `<tr><td colspan="${fields.length + 1}" style="text-align:center;padding:20px;color:var(--text-muted)">No combinations match the current filters</td></tr>`;
    }

    function dataRow(i) {
      const c    = wizard.combos[i];
      const excl = wizard.excluded.has(i);
      return `<tr class="${excl ? 'row-excluded' : ''}">
        <td class="col-check"><input type="checkbox" data-idx="${i}" ${!excl ? 'checked' : ''}></td>
        ${fields.map(f => `<td>${esc(c.values[f]?.name ?? '—')}</td>`).join('')}
      </tr>`;
    }

    function buildGrouped(indices, sectionKey) {
      const groupMap = new Map();
      indices.forEach(i => {
        const key = wizard.combos[i].values[wizard.groupBy]?.name ?? '—';
        if (!groupMap.has(key)) groupMap.set(key, []);
        groupMap.get(key).push(i);
      });
      let html = '';
      for (const [gkey, gIndices] of groupMap) {
        const allExcl  = gIndices.every(i => wizard.excluded.has(i));
        const noneExcl = gIndices.every(i => !wizard.excluded.has(i));
        html += `<tr class="matrix-group-header">
          <td class="col-check"><input type="checkbox" class="group-cb"
            data-gkey="${esc(gkey)}" data-section="${esc(sectionKey)}"
            ${noneExcl ? 'checked' : ''} ${(!noneExcl && !allExcl) ? 'data-partial="1"' : ''}></td>
          <td colspan="${fields.length}"><strong>${esc(wizard.groupBy)}: ${esc(gkey)}</strong>
            <span class="badge" style="margin-left:8px">${gIndices.length}</span></td>
        </tr>`;
        html += gIndices.map(dataRow).join('');
      }
      return html;
    }

    function buildSection(indices, label, sectionKey) {
      if (!indices.length) return '';
      let html = `<tr class="matrix-section-header">
        <td colspan="${fields.length + 1}">
          ${esc(label)}<span class="badge" style="margin-left:8px">${indices.length}</span>
        </td>
      </tr>`;
      html += wizard.groupBy
        ? buildGrouped(indices, sectionKey)
        : indices.map(dataRow).join('');
      return html;
    }

    return buildSection(existVis, 'Existing Asset Combinations', 'existing')
         + buildSection(otherVis, 'All Other Combinations', 'other');
  }

  function refreshTbody() {
    const tbody = document.getElementById('matrix-tbody');
    if (!tbody) return;
    tbody.innerHTML = buildTbody();
    tbody.querySelectorAll('.group-cb[data-partial="1"]').forEach(cb => { cb.indeterminate = true; });
    updateAllCb();
    updateSubtitle();
  }

  // ---- Initial HTML ----

  $setupBody.innerHTML = `
    <div class="matrix-toolbar">
      <div class="matrix-row-1">
        <div class="mf-groupby-wrap">
          <span class="mf-label">Group by</span>
          <select id="matrix-groupby">
            <option value="">— none —</option>
            ${fields.map(f => `<option value="${esc(f)}" ${wizard.groupBy === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
          </select>
        </div>
        <div class="matrix-btns">
          <button class="btn btn-ghost btn-sm" id="m-sel-vis">Select visible</button>
          <button class="btn btn-ghost btn-sm" id="m-desel-vis">Deselect visible</button>
        </div>
      </div>
      <div class="matrix-filters" id="matrix-filters">
        ${fields.map(f => {
          const vals = wizard.values[f] || [];
          const fs   = wizard.filters[f];
          const sel  = vals.filter(v => fs?.has(v.name)).length;
          const allSel = sel === vals.length;
          return `
            <div class="mf-dropdown" data-field="${esc(f)}">
              <button class="mf-dropdown-trigger${allSel ? '' : ' mf-filtered'}" type="button">
                <span class="mf-label">${esc(f)}</span>
                <span class="mf-dropdown-summary">${allSel ? `All (${vals.length})` : `${sel} of ${vals.length}`}</span>
                <span class="mf-dropdown-arrow">▾</span>
              </button>
              <div class="mf-dropdown-panel">
                <div class="mf-dd-actions">
                  <button class="mf-dd-action" data-action="all" type="button">All</button>
                  <button class="mf-dd-action" data-action="none" type="button">None</button>
                </div>
                ${vals.map(v => `
                  <label class="mf-dd-option">
                    <input type="checkbox" data-val="${esc(v.name)}" ${fs?.has(v.name) ? 'checked' : ''}>
                    ${esc(v.name)}
                  </label>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    <div class="wizard-section-sub" style="margin:10px 0 0">
      <span id="matrix-sub-text"></span>
    </div>
    <div class="table-wrapper" style="margin-top:10px">
      <table class="schedule-table">
        <thead><tr>
          <th class="col-check"><input type="checkbox" id="matrix-all" title="Select / deselect all visible"></th>
          ${fields.map(f => `<th>${esc(f)}</th>`).join('')}
        </tr></thead>
        <tbody id="matrix-tbody"></tbody>
      </table>
    </div>
  `;

  refreshTbody();

  // ---- Event wiring ----

  document.getElementById('matrix-groupby').addEventListener('change', e => {
    wizard.groupBy = e.target.value;
    refreshTbody();
  });

  const $matrixFilters = document.getElementById('matrix-filters');

  function updateFilterSummary(dropdown) {
    const field  = dropdown.dataset.field;
    const vals   = wizard.values[field] || [];
    const fs     = wizard.filters[field];
    const sel    = vals.filter(v => fs?.has(v.name)).length;
    const allSel = sel === vals.length;
    dropdown.querySelector('.mf-dropdown-summary').textContent =
      allSel ? `All (${vals.length})` : `${sel} of ${vals.length}`;
    dropdown.querySelector('.mf-dropdown-trigger').classList.toggle('mf-filtered', !allSel);
  }

  $matrixFilters.addEventListener('click', e => {
    const trigger = e.target.closest('.mf-dropdown-trigger');
    const action  = e.target.closest('.mf-dd-action');

    if (trigger && !action) {
      const dropdown = trigger.closest('.mf-dropdown');
      const isOpen   = dropdown.classList.contains('open');
      $matrixFilters.querySelectorAll('.mf-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!isOpen) dropdown.classList.add('open');
      e.stopPropagation();
      return;
    }

    if (action) {
      const dropdown = action.closest('.mf-dropdown');
      const field    = dropdown.dataset.field;
      const vals     = wizard.values[field] || [];
      const act      = action.dataset.action;
      if (act === 'all') vals.forEach(v => wizard.filters[field].add(v.name));
      else               vals.forEach(v => wizard.filters[field].delete(v.name));
      dropdown.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = act === 'all'; });
      updateFilterSummary(dropdown);
      refreshTbody();
      e.stopPropagation();
    }
  });

  $matrixFilters.addEventListener('change', e => {
    const cb = e.target;
    if (cb.type !== 'checkbox') return;
    const dropdown = cb.closest('.mf-dropdown');
    const field    = dropdown.dataset.field;
    const val      = cb.dataset.val;
    if (cb.checked) wizard.filters[field].add(val);
    else            wizard.filters[field].delete(val);
    updateFilterSummary(dropdown);
    refreshTbody();
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('#matrix-filters .mf-dropdown.open')
      .forEach(d => d.classList.remove('open'));
  });

  document.getElementById('m-sel-vis').addEventListener('click', () => {
    getVisibleIndices().forEach(i => wizard.excluded.delete(i));
    refreshTbody();
  });

  document.getElementById('m-desel-vis').addEventListener('click', () => {
    getVisibleIndices().forEach(i => wizard.excluded.add(i));
    refreshTbody();
  });

  document.getElementById('matrix-all').addEventListener('change', e => {
    const vis = getVisibleIndices();
    if (e.target.checked) vis.forEach(i => wizard.excluded.delete(i));
    else                   vis.forEach(i => wizard.excluded.add(i));
    refreshTbody();
  });

  document.getElementById('matrix-tbody').addEventListener('change', e => {
    const cb = e.target;
    if (cb.dataset.idx !== undefined && !cb.classList.contains('group-cb')) {
      // Individual row checkbox — update in place (avoids scroll reset)
      const idx = +cb.dataset.idx;
      if (cb.checked) wizard.excluded.delete(idx);
      else            wizard.excluded.add(idx);
      cb.closest('tr').classList.toggle('row-excluded', !cb.checked);

      // Update parent group checkbox state if grouped
      if (wizard.groupBy) {
        const gkey    = wizard.combos[idx].values[wizard.groupBy]?.name ?? '—';
        const section = existingIndices.has(idx) ? 'existing' : 'other';
        const gCb     = document.querySelector(
          `#matrix-tbody .group-cb[data-gkey="${CSS.escape(gkey)}"][data-section="${section}"]`
        );
        if (gCb) {
          const vis      = getVisibleIndices();
          const pool     = section === 'existing'
            ? vis.filter(i =>  existingIndices.has(i))
            : vis.filter(i => !existingIndices.has(i));
          const gIndices = pool.filter(i => (wizard.combos[i].values[wizard.groupBy]?.name ?? '—') === gkey);
          const allExcl  = gIndices.every(i => wizard.excluded.has(i));
          const noneExcl = gIndices.every(i => !wizard.excluded.has(i));
          gCb.checked       = noneExcl;
          gCb.indeterminate = !noneExcl && !allExcl;
        }
      }
      updateAllCb();
      updateSubtitle();

    } else if (cb.classList.contains('group-cb')) {
      const gkey    = cb.dataset.gkey;
      const section = cb.dataset.section;
      const vis     = getVisibleIndices();
      const pool    = section === 'existing'
        ? vis.filter(i =>  existingIndices.has(i))
        : vis.filter(i => !existingIndices.has(i));
      const gIndices = pool.filter(i => (wizard.combos[i].values[wizard.groupBy]?.name ?? '—') === gkey);
      if (cb.checked) gIndices.forEach(i => wizard.excluded.delete(i));
      else            gIndices.forEach(i => wizard.excluded.add(i));
      refreshTbody();
    }
  });

  $wizardFooter.innerHTML = `
    <button class="btn btn-ghost" id="w-back">← Back</button>
    <button class="btn btn-primary" id="w-next">Next →</button>
  `;
  $('w-back').addEventListener('click', async () => { wizard.step = 2; await renderWizardStep(); });
  $('w-next').addEventListener('click', async () => {
    if (selectedCount() === 0) return showToast('Select at least one combination', 'error');
    wizard.step = 4;
    await renderWizardStep();
  });
}

// Step 4 — additional options (prefill, clear existing)
async function renderStep4() {
  $setupBody.innerHTML = '<div class="list-state">Loading…</div>';
  $wizardFooter.innerHTML = '';

  let colsWithData = [];
  try {
    const matrixData = await apiFetch('/api/setup/matrix-table');
    colsWithData = (matrixData.combinations || []).filter(c =>
      (matrixData.tasks || []).some(t => t.estimates[c.colName] != null)
    );
  } catch (_) { /* non-fatal — just show empty dropdown */ }

  $setupBody.innerHTML = `
    <div class="wizard-config">
      <div class="wizard-section-label" style="margin-bottom:4px">Additional Configuration</div>

      <div class="config-field">
        <div class="config-label">Prefill new columns from</div>
        <div class="config-sub">Copy estimate values from an existing column into all newly created columns. Useful for seeding a new combination from a similar existing one.</div>
        <select class="config-select" id="w-prefill-col">
          <option value="">— None —</option>
          ${colsWithData.map(c => `<option value="${esc(c.colName)}" ${wizard.prefillCol === c.colName ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
        </select>
      </div>

      <div class="config-field">
        ${wizard.mode === 'arthound'
          ? `<div class="config-label">Reset matrix</div>
             <div class="config-sub">If enabled, all existing estimate values for this studio will be cleared before writing new rows. If disabled, existing values are preserved and new combinations are added.</div>`
          : `<div class="config-label">Previously generated columns</div>
             <div class="config-sub">If enabled, all columns from the previous setup run will be deleted from Task Templates before creating new ones. If disabled, new columns are added alongside existing ones.</div>`
        }
        <label class="config-toggle-label">
          <div class="config-toggle-wrap">
            <input type="checkbox" id="w-clear-existing" ${wizard.clearExisting ? 'checked' : ''}>
            <span class="config-toggle-track"><span class="config-toggle-thumb"></span></span>
          </div>
          <span>${wizard.mode === 'arthound' ? 'Clear existing matrix' : 'Delete previously generated columns'}</span>
        </label>
      </div>
    </div>
  `;

  $wizardFooter.innerHTML = `
    <button class="btn btn-ghost" id="w-back">← Back</button>
    <button class="btn btn-primary" id="w-next">Create Tables</button>
  `;
  $('w-back').addEventListener('click', async () => { wizard.step = 3; await renderWizardStep(); });
  $('w-next').addEventListener('click', async () => {
    wizard.prefillCol    = $('w-prefill-col').value;
    wizard.clearExisting = $('w-clear-existing').checked;
    wizard.step = 5;
    await renderWizardStep();
  });
}

// Step 5 — create columns (Airtable) or upsert matrix (ArtHound)
async function renderStep5() {
  const activeCombos = wizard.combos.filter((_, i) => !wizard.excluded.has(i));
  const isPg = wizard.mode === 'arthound';

  $setupBody.innerHTML = `<div class="list-state">${isPg
    ? `Syncing ${activeCombos.length} combination${activeCombos.length !== 1 ? 's' : ''} to ArtHound Matrix…`
    : `Adding ${activeCombos.length} column${activeCombos.length !== 1 ? 's' : ''} to Task Templates…`
  }</div>`;
  $wizardFooter.innerHTML = '';

  let success = false;

  try {
    const variables = [...wizard.selected].map(field => ({
      field,
      type: wizard.fields.find(f => f.name === field)?.type ?? 'unknown',
    }));

    const endpoint = isPg ? '/api/setup/create-matrix-pg' : '/api/setup/create-matrix';
    const result = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        variables,
        combinations: activeCombos,
        prefillCol:    wizard.prefillCol,
        clearExisting: wizard.clearExisting,
      }),
    });

    wizard.result = result;
    success = true;

    $setupBody.innerHTML = isPg ? `
      <div class="wizard-result">
        <div class="wizard-result-icon">✓</div>
        <div class="wizard-result-title">Done</div>
        <div class="wizard-result-row">
          <span class="badge">${result.stepsUpserted} workflow steps</span>
          <span class="badge">${result.matrixRows} matrix rows</span>
          ${result.cleared ? `<span class="muted">previous matrix cleared</span>` : ''}
          ${result.prefillPending ? `<span class="wizard-result-prefill">Prefilling from <strong>${esc(wizard.prefillCol)}</strong> in background</span>` : ''}
        </div>
        <div class="wizard-section-sub" style="margin-top:14px">
          Estimates are stored in ArtHound. Edit day values directly in the matrix view, or use the scheduler — no Airtable schema changes needed.
        </div>
      </div>
    ` : `
      <div class="wizard-result">
        <div class="wizard-result-icon">✓</div>
        <div class="wizard-result-title">Done</div>
        <div class="wizard-result-row">
          <strong>${esc(result.templatesTable)}</strong>
          <span class="badge">${result.created} added</span>
          ${result.skipped ? `<span class="muted">${result.skipped} already existed</span>` : ''}
          ${result.deleted ? `<span class="muted">${result.deleted} deleted</span>` : ''}
          ${result.prefillPending ? `<span class="wizard-result-prefill">Prefilling from <strong>${esc(wizard.prefillCol)}</strong> in background — check Airtable in a moment</span>` : ''}
        </div>
        <div class="wizard-section-sub" style="margin-top:14px">
          estimates.config.js has been updated. Download the CSV to fill in day estimates offline,
          or edit the columns directly in Airtable, then use Preview Schedule.
        </div>
      </div>
    `;
  } catch (err) {
    $setupBody.innerHTML = `
      <div class="wizard-result">
        <div class="wizard-result-icon err">✗</div>
        <div class="wizard-result-title">Creation failed</div>
        <div class="wizard-section-sub" style="color:var(--err)">${esc(err.message)}</div>
      </div>
    `;
  }

  $wizardFooter.innerHTML = `
    <button class="btn btn-ghost" id="w-back">← Back</button>
    ${success && !isPg ? `<a class="btn btn-ghost" href="/api/setup/export-csv" download="estimate-matrix.csv">⬇ Download CSV</a>` : ''}
    <button class="btn btn-ghost" id="w-close">Close</button>
  `;
  $('w-back').addEventListener('click', async () => { wizard.step = 4; await renderWizardStep(); });
  $('w-close').addEventListener('click', () => $setupOverlay.classList.remove('open'));
}

// -- Schema modal --

const $schemaOverlay = $('schema-overlay');
const $schemaBtn     = $('schema-btn');
const $schemaClose   = $('schema-close');
const $schemaTabs    = $('schema-tabs');
const $schemaBody    = $('schema-body');

const TYPE_LABEL = {
  text: 'text', number: 'num', date: 'date', link: 'link',
  computed: 'calc', select: 'select', bool: 'bool', user: 'user',
  file: 'file', other: '…',
};

let schemaCache = null;
let activeTabKey = null;

$schemaBtn.addEventListener('click', openSchema);
$schemaClose.addEventListener('click', () => $schemaOverlay.classList.remove('open'));
$schemaOverlay.addEventListener('click', e => {
  if (e.target === $schemaOverlay) $schemaOverlay.classList.remove('open');
});

async function openSchema() {
  $schemaOverlay.classList.add('open');
  if (schemaCache) return renderSchema(schemaCache);

  $schemaTabs.innerHTML = '';
  $schemaBody.innerHTML = '<div class="list-state">Loading schema…</div>';

  try {
    schemaCache = await apiFetch('/api/schema');
    renderSchema(schemaCache);
  } catch (err) {
    $schemaBody.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderSchema(data) {
  const { configured, allTableNames } = data;

  // Build tabs
  $schemaTabs.innerHTML = configured.map(t => `
    <button class="schema-tab${activeTabKey === t.key || (!activeTabKey && t === configured[0]) ? ' active' : ''}"
            data-key="${esc(t.key)}">
      ${esc(t.key)}
      ${t.found ? '' : '<span class="tab-missing">!</span>'}
    </button>
  `).join('');

  if (!activeTabKey) activeTabKey = configured[0]?.key;

  $schemaTabs.querySelectorAll('.schema-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTabKey = btn.dataset.key;
      $schemaTabs.querySelectorAll('.schema-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTableFields(configured.find(t => t.key === activeTabKey), allTableNames);
    });
  });

  renderTableFields(configured.find(t => t.key === activeTabKey) ?? configured[0], allTableNames);
}

function renderTableFields(table, allTableNames, target = $schemaBody) {
  if (!table) { target.innerHTML = ''; return; }

  if (!table.found) {
    const suggestions = allTableNames.filter(n =>
      n.toLowerCase().includes(table.key) || table.name.toLowerCase().includes(n.toLowerCase().slice(0, 5))
    ).slice(0, 5);

    target.innerHTML = `
      <div class="schema-missing">
        <div class="schema-missing-title">Table not found</div>
        <div class="schema-missing-sub">
          Configured as <code>${esc(table.name)}</code> — set <code>TABLE_${table.key.toUpperCase()}</code>
          in <code>.env</code> to override.
        </div>
        ${suggestions.length ? `
          <div class="schema-missing-sub" style="margin-top:10px">
            Tables in this base: ${suggestions.map(n => `<code>${esc(n)}</code>`).join(', ')}
          </div>` : ''}
      </div>
    `;
    return;
  }

  const isTemplates = table.key === 'templates';
  const fields = table.fields;
  const estimateCols = isTemplates ? fields.filter(f => f.name.includes('Template Estimate')) : [];
  const otherFields  = isTemplates ? fields.filter(f => !f.name.includes('Template Estimate')) : fields;

  function fieldRow(f) {
    const label = TYPE_LABEL[f.category] ?? f.type;
    return `
      <tr>
        <td>${esc(f.name)}</td>
        <td><span class="ftype ftype-${esc(f.category)}">${esc(label)}</span></td>
        <td class="fid">${esc(f.id)}</td>
      </tr>
    `;
  }

  target.innerHTML = `
    <div class="schema-table-meta">
      <span class="schema-table-name">${esc(table.name)}</span>
      <span class="badge">${fields.length} field${fields.length !== 1 ? 's' : ''}</span>
      <span class="schema-table-id">${esc(table.id)}</span>
    </div>
    <div class="table-wrapper">
      <table class="schedule-table schema-fields-table">
        <thead>
          <tr><th>Field name</th><th>Type</th><th>Field ID</th></tr>
        </thead>
        <tbody>
          ${otherFields.map(fieldRow).join('')}
          ${estimateCols.length ? `
            <tr class="estimate-group-header">
              <td colspan="3">Estimate columns (${estimateCols.length})</td>
            </tr>
            ${estimateCols.map(fieldRow).join('')}
          ` : ''}
        </tbody>
      </table>
    </div>
  `;
}

// -- CSV Import --

const $csvOverlay    = $('csv-overlay');
const $csvImportBtn  = $('est-csv-import-btn');
const $csvModalClose = $('csv-modal-close');
const $csvBody      = $('csv-body');
const $csvFooter    = $('csv-footer');

const csvState = { headers: null, rows: null, fileName: '' };

$csvImportBtn.addEventListener('click', openCsvImport);
$csvModalClose.addEventListener('click', () => $csvOverlay.classList.remove('open'));
$csvOverlay.addEventListener('click', e => { if (e.target === $csvOverlay) $csvOverlay.classList.remove('open'); });

function openCsvImport() {
  csvState.headers = null;
  csvState.rows    = null;
  csvState.fileName = '';
  $csvOverlay.classList.add('open');
  renderCsvDropzone();
}

function renderCsvDropzone() {
  $csvBody.innerHTML = `
    <div class="csv-dropzone" id="csv-dropzone">
      <div class="csv-drop-icon">⬆</div>
      <div class="csv-drop-label">
        Drop a CSV file here or
        <label for="csv-file-input" class="csv-browse-link">browse</label>
      </div>
      <div class="csv-drop-hint">Use the format exported from the setup wizard (Task column + estimate columns)</div>
      <input type="file" id="csv-file-input" accept=".csv,text/csv" style="display:none">
    </div>
  `;
  $csvFooter.innerHTML = '';

  const dropzone  = document.getElementById('csv-dropzone');
  const fileInput = document.getElementById('csv-file-input');

  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', ()  => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) loadCsvFile(e.dataTransfer.files[0]);
  });
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadCsvFile(fileInput.files[0]); });
}

function loadCsvFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const parsed = parseCSV(e.target.result);
    if (!parsed.length) return showToast('CSV appears to be empty', 'error');
    csvState.headers  = parsed[0];
    csvState.rows     = parsed.slice(1).filter(r => r.some(v => v.trim()));
    csvState.fileName = file.name;
    renderCsvPreview();
  };
  reader.readAsText(file);
}

function parseCSV(raw) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n') + '\n';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cell += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') {
        row.push(cell); cell = '';
        if (row.some(v => v !== '')) rows.push(row);
        row = [];
      } else { cell += c; }
    }
  }
  return rows;
}

function renderCsvPreview() {
  const { headers, rows, fileName } = csvState;
  const taskIdx   = headers.indexOf('Task');
  const estCols   = headers.filter((h, i) => i !== taskIdx && h.trim());
  const nonEmptyRows = rows.filter(r => {
    return estCols.some(h => {
      const v = (r[headers.indexOf(h)] ?? '').trim();
      return v !== '' && !isNaN(parseFloat(v));
    });
  });

  const hasTaskCol = taskIdx !== -1;
  const sampleTasks = rows.slice(0, 5).map(r => esc(r[taskIdx] ?? '—'));

  $csvBody.innerHTML = `
    <div class="csv-preview">
      <div class="csv-preview-file">
        <span class="csv-file-icon">📄</span>
        <span class="csv-file-name">${esc(fileName)}</span>
        <span class="muted">${rows.length} row${rows.length !== 1 ? 's' : ''}</span>
      </div>
      ${!hasTaskCol ? `
        <div class="csv-warning">⚠ No "Task" column found — check the file format</div>
      ` : ''}
      <div class="csv-preview-grid">
        <div class="csv-preview-section">
          <div class="csv-preview-label">Estimate columns detected</div>
          <div class="csv-preview-chips">
            ${estCols.length
              ? estCols.map(h => `<span class="mf-chip on">${esc(h)}</span>`).join('')
              : '<span class="muted">None found</span>'}
          </div>
        </div>
        <div class="csv-preview-section">
          <div class="csv-preview-label">First tasks in file</div>
          <div class="csv-preview-tasks">
            ${sampleTasks.map(t => `<div class="csv-task-row">${t}</div>`).join('')}
            ${rows.length > 5 ? `<div class="muted" style="font-size:11px">+ ${rows.length - 5} more</div>` : ''}
          </div>
        </div>
      </div>
      <div class="csv-preview-summary">
        ${nonEmptyRows.length} of ${rows.length} rows have values to write
      </div>
    </div>
  `;

  $csvFooter.innerHTML = `
    <button class="btn btn-ghost" id="csv-reselect">← Change file</button>
    <button class="btn btn-primary" id="csv-apply" ${!hasTaskCol || !estCols.length ? 'disabled' : ''}>
      Import ${nonEmptyRows.length} row${nonEmptyRows.length !== 1 ? 's' : ''}
    </button>
  `;

  document.getElementById('csv-reselect').addEventListener('click', renderCsvDropzone);
  document.getElementById('csv-apply').addEventListener('click', applyCsvImport);
}

async function applyCsvImport() {
  const { headers, rows } = csvState;
  $csvBody.innerHTML = '<div class="list-state">Writing to Airtable…</div>';
  $csvFooter.innerHTML = '';

  try {
    const result = await apiFetch('/api/setup/import-csv', {
      method: 'POST',
      body: JSON.stringify({ headers, rows }),
    });

    const nf = result.notFound?.length ?? 0;
    $csvBody.innerHTML = `
      <div class="wizard-result">
        <div class="wizard-result-icon">✓</div>
        <div class="wizard-result-title">Import complete</div>
        <div class="wizard-result-row">
          <strong>${result.updated} task${result.updated !== 1 ? 's' : ''} updated</strong>
          <span class="muted">${result.cellsWritten} cell${result.cellsWritten !== 1 ? 's' : ''} written</span>
        </div>
        ${nf ? `
          <div class="csv-warning" style="margin-top:12px">
            ⚠ ${nf} task name${nf !== 1 ? 's' : ''} not matched in Task Templates:
            <div class="csv-notfound">${result.notFound.map(esc).join(', ')}</div>
          </div>` : ''}
      </div>
    `;
  } catch (err) {
    $csvBody.innerHTML = `
      <div class="wizard-result">
        <div class="wizard-result-icon err">✗</div>
        <div class="wizard-result-title">Import failed</div>
        <div class="wizard-section-sub" style="color:var(--err)">${esc(err.message)}</div>
      </div>
    `;
  }

  $csvFooter.innerHTML = `
    <button class="btn btn-ghost" id="csv-reimport">← Import another</button>
    <button class="btn btn-ghost" id="csv-done">Close</button>
  `;
  document.getElementById('csv-reimport').addEventListener('click', openCsvImport);
  document.getElementById('csv-done').addEventListener('click', () => $csvOverlay.classList.remove('open'));
}

// -- Estimation Matrix (Airtable) --

document.getElementById('est-matrix-btn').addEventListener('click', () => navigate('matrix-table'));
document.getElementById('matrix-table-back-btn').addEventListener('click', () => navigate('estimates'));
document.getElementById('matrix-table-refresh-btn').addEventListener('click', loadMatrixTable);

async function loadMatrixTable() {
  const $content = $('matrix-table-content');
  $content.innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const data = await apiFetch('/api/setup/matrix-table');
    renderMatrixTable(data, $content);
  } catch (err) {
    $content.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

// -- ArtHound Matrix (Postgres) --

document.getElementById('est-pg-matrix-btn').addEventListener('click', () => navigate('pg-matrix-table'));
document.getElementById('pg-matrix-back-btn').addEventListener('click', () => navigate('estimates'));
document.getElementById('pg-matrix-refresh-btn').addEventListener('click', loadPgMatrixTable);

async function loadPgMatrixTable() {
  const $content = $('pg-matrix-content');
  $content.innerHTML = '<div class="list-state">Loading…</div>';
  try {
    const data = await apiFetch('/api/setup/matrix-table-pg');
    renderMatrixTable(data, $content);
  } catch (err) {
    $content.innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function renderMatrixTable({ variableFields, combinations, tasks, attributeFields = [] }, $content) {
  if (!combinations.length) {
    $content.innerHTML = '<div class="list-state">No estimate combinations configured — run the Setup wizard first.</div>';
    return;
  }
  if (!tasks.length) {
    $content.innerHTML = '<div class="list-state">No workflow steps found — run the Setup wizard first.</div>';
    return;
  }

  // Build a two-row header: variable field names span groups, values in second row
  const groupSpans = [];
  if (variableFields.length > 1) {
    let prev = null, span = 0;
    combinations.forEach((c, i) => {
      const topVal = c.key.split('|')[0];
      if (topVal !== prev) {
        if (prev !== null) groupSpans.push({ label: prev, span });
        prev = topVal; span = 1;
      } else {
        span++;
      }
      if (i === combinations.length - 1) groupSpans.push({ label: prev, span });
    });
  }

  const hasGroups = groupSpans.length > 1;

  const renderTags = arr => arr && arr.length
    ? arr.map(v => `<span class="mt-tag">${esc(v)}</span>`).join('')
    : '<span class="mt-empty-inline">—</span>';

  // Fixed attribute columns derived from schema (e.g. "Crafts", "Related Items")
  const attrHeaders = attributeFields.map(f => `<th class="mt-fixed mt-attr">${esc(f)}</th>`).join('');
  const attrHeadersSpanned = attributeFields.map(f => `<th class="mt-fixed mt-attr" rowspan="2">${esc(f)}</th>`).join('');

  // Render first, then fix up sticky left offsets after DOM is painted
  function applyStickyOffsets() {
    const table = $content.querySelector('.mt-table');
    if (!table) return;
    // Use the first row of cells to measure column widths
    const firstRow = table.querySelector('tr');
    if (!firstRow) return;
    const cells = Array.from(firstRow.querySelectorAll('.mt-fixed'));
    let offset = 0;
    cells.forEach(cell => {
      cell.style.left = offset + 'px';
      offset += cell.getBoundingClientRect().width;
    });
    // Apply same offsets to all other rows by column index
    table.querySelectorAll('tr').forEach(row => {
      const fixed = Array.from(row.querySelectorAll('.mt-fixed'));
      fixed.forEach((cell, i) => {
        if (cells[i]) cell.style.left = cells[i].style.left;
      });
    });
  }

  $content.innerHTML = `
    <div class="mt-scroll-wrap">
      <table class="schedule-table mt-table">
        <thead>
          ${hasGroups ? `
          <tr>
            <th class="mt-fixed mt-step" rowspan="2"></th>
            <th class="mt-fixed mt-task" rowspan="2">Task</th>
            ${attrHeadersSpanned}
            <th class="mt-fixed mt-depends" rowspan="2">Depends On</th>
            ${groupSpans.map(g => `<th class="mt-group-header" colspan="${g.span}">${esc(g.label)}</th>`).join('')}
          </tr>
          <tr>
            ${combinations.map(c => `<th class="mt-combo">${esc(c.key.split('|').slice(1).join(' | '))}</th>`).join('')}
          </tr>
          ` : `
          <tr>
            <th class="mt-fixed mt-step"></th>
            <th class="mt-fixed mt-task">Task</th>
            ${attrHeaders}
            <th class="mt-fixed mt-depends">Depends On</th>
            ${combinations.map(c => `<th class="mt-combo" title="${esc(c.key)}">${esc(c.label)}</th>`).join('')}
          </tr>
          `}
        </thead>
        <tbody>
          ${tasks.map(t => `
            <tr>
              <td class="mt-fixed mt-step">${t.step}</td>
              <td class="mt-fixed mt-task">${esc(t.name)}</td>
              ${attributeFields.map(f => `<td class="mt-fixed mt-attr">${renderTags((t.linkedValues || {})[f])}</td>`).join('')}
              <td class="mt-fixed mt-depends">${t.dependsOn && t.dependsOn.length ? esc(t.dependsOn.join(', ')) : '<span class="mt-empty-inline">—</span>'}</td>
              ${combinations.map(c => {
                const val = t.estimates[c.colName];
                return (val != null && val !== 0)
                  ? `<td class="mt-val">${val}d</td>`
                  : `<td class="mt-empty">—</td>`;
              }).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;

  requestAnimationFrame(applyStickyOffsets);
}

// -- Asset Reviews --

const STATUS_COLORS = {
  'Pending':           '#fbbf24',
  'Approved':          '#34d399',
  'Changes Requested': '#f87171',
};
const STATUS_BG = {
  'Pending':           'rgba(251,191,36,0.12)',
  'Approved':          'rgba(52,211,153,0.12)',
  'Changes Requested': 'rgba(248,113,113,0.12)',
};

const rvState = {
  reviews:       [],
  selected:      null,
  statusOptions: [],
  filters:       { status: new Set(), artist: new Set() },
};

async function loadReviews() {
  $('rv-list').innerHTML = '<div class="list-state">Loading…</div>';
  renderRvFilters();
  try {
    const [reviews, statusData] = await Promise.all([
      apiFetch('/api/reviews'),
      apiFetch('/api/reviews/status-options').catch(() => ({ options: [] })),
    ]);
    rvState.reviews = reviews;
    rvState.statusOptions = statusData.options;
    rvState.selected = null;
    $('rv-detail').style.display = 'none';
    $('rv-placeholder').style.display = 'flex';
    renderRvFilters();
    renderRvList();
  } catch (err) {
    $('rv-list').innerHTML = `<div class="list-state error">${esc(err.message)}</div>`;
  }
}

function getRvFiltered() {
  const { status, artist } = rvState.filters;
  return rvState.reviews.filter(r => {
    if (status.size && !status.has(r.status)) return false;
    if (artist.size && !artist.has(r.artist)) return false;
    return true;
  });
}

function buildRvDropdown(key, label, options, activeSet) {
  const isFiltered = activeSet.size > 0 && activeSet.size < options.length;
  const summary = activeSet.size === 0 || activeSet.size === options.length
    ? 'All'
    : activeSet.size === 1
      ? [...activeSet][0]
      : `${activeSet.size} selected`;
  return `
    <div class="mf-dropdown" data-rv-filter="${key}">
      <button class="mf-dropdown-trigger${isFiltered ? ' mf-filtered' : ''}">
        <span class="mf-label">${esc(label)}</span>
        <span class="mf-dropdown-summary">${esc(summary)}</span>
        <span class="mf-dropdown-arrow">▾</span>
      </button>
      <div class="mf-dropdown-panel">
        <div class="mf-dd-actions">
          <button class="mf-dd-action" data-filter="${key}" data-action="all">All</button>
          <button class="mf-dd-action" data-filter="${key}" data-action="none">None</button>
        </div>
        ${options.length ? options.map(v => `
          <label class="mf-dd-option">
            <input type="checkbox" data-filter="${key}" data-value="${esc(v)}" ${activeSet.has(v) ? 'checked' : ''}>
            ${esc(v)}
          </label>
        `).join('') : '<div class="list-state" style="padding:8px 12px;font-size:12px">No values</div>'}
      </div>
    </div>
  `;
}

function renderRvFilters() {
  const $f = $('rv-filters');
  const allStatuses = [...new Set(rvState.reviews.map(r => r.status).filter(Boolean))].sort();
  const allArtists  = [...new Set(rvState.reviews.map(r => r.artist).filter(Boolean))].sort();

  $f.innerHTML =
    buildRvDropdown('status', 'Status', allStatuses, rvState.filters.status) +
    buildRvDropdown('artist', 'Artist', allArtists,  rvState.filters.artist);

  $f.querySelectorAll('.mf-dropdown-trigger').forEach(trigger => {
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      const dd = trigger.closest('.mf-dropdown');
      const wasOpen = dd.classList.contains('open');
      $f.querySelectorAll('.mf-dropdown.open').forEach(d => d.classList.remove('open'));
      if (!wasOpen) dd.classList.add('open');
    });
  });

  $f.querySelectorAll('.mf-dd-option input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const set = rvState.filters[cb.dataset.filter];
      cb.checked ? set.add(cb.dataset.value) : set.delete(cb.dataset.value);
      renderRvFilters();
      renderRvList();
    });
  });

  $f.querySelectorAll('.mf-dd-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.filter;
      const set = rvState.filters[key];
      set.clear();
      if (btn.dataset.action === 'all') {
        (key === 'status' ? allStatuses : allArtists).forEach(v => set.add(v));
      }
      renderRvFilters();
      renderRvList();
    });
  });
}

function renderRvList() {
  const $list = $('rv-list');
  const filtered = getRvFiltered();
  if (!filtered.length) {
    $list.innerHTML = `<div class="list-state">${rvState.reviews.length ? 'No reviews match filters.' : 'No reviews yet.'}</div>`;
    return;
  }
  $list.innerHTML = filtered.map(r => {
    const color  = STATUS_COLORS[r.status] || '#6b748a';
    const bg     = STATUS_BG[r.status]     || 'rgba(107,116,138,0.12)';
    const date   = r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : '—';
    return `
      <div class="rv-item${rvState.selected === r.id ? ' active' : ''}" data-id="${esc(r.id)}">
        <div class="rv-item-name">${esc(r.assetName || '—')}</div>
        <div class="rv-item-meta">
          <span class="rv-item-status" style="color:${color};background:${bg}">${esc(r.status)}</span>
          <span>${esc(r.artist || '—')}</span>·
          <span>${esc(date)}</span>
        </div>
      </div>
    `;
  }).join('');

  $list.querySelectorAll('.rv-item').forEach(el =>
    el.addEventListener('click', () => selectReview(el.dataset.id))
  );
}

function selectReview(id) {
  rvState.selected = id;
  renderRvList();

  const r = rvState.reviews.find(rv => rv.id === id);
  if (!r) return;

  $('rv-placeholder').style.display = 'none';
  $('rv-detail').style.display = 'flex';

  // Screenshot
  $('rv-screenshot-wrap').innerHTML = r.screenshot
    ? `<img class="rv-screenshot-img" src="${esc(r.screenshot)}" alt="Screenshot">`
    : '<div class="rv-no-screenshot">No screenshot attached</div>';

  // Status action bar
  const statusColor = STATUS_COLORS[r.status] || '#6b748a';
  const statusOpts = rvState.statusOptions.length
    ? rvState.statusOptions
    : ['Pending', 'Approved', 'Changes Requested'];
  const optionsHtml = statusOpts
    .map(o => `<option value="${esc(o)}"${r.status === o ? ' selected' : ''}>${esc(o)}</option>`)
    .join('');
  $('rv-actions-bar').innerHTML = `
    <span class="rv-detail-label">Status</span>
    <select class="review-status-select" id="rv-status-select">${optionsHtml}</select>
    <span class="rv-status-pill" style="color:${statusColor}">● ${esc(r.status)}</span>
  `;
  document.getElementById('rv-status-select').addEventListener('change', async function () {
    const newStatus = this.value;
    try {
      await apiFetch(`/api/reviews/${r.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      });
      r.status = newStatus;
      showToast('Status updated', 'info');
      selectReview(id);
      renderRvList();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Field tiles — rendered via shared FieldGrid module.
  // Fields shown elsewhere (action bar, screenshot, notes) are excluded.
  const RV_SKIP = new Set(['Status', 'Attachments', 'Assets', 'Notes']);
  const rvGridFields = [];

  // Linked asset — navigable if a single asset is attached, plain text if multiple
  if (r.assetIds && r.assetIds.length === 1) {
    rvGridFields.push({
      label: 'Asset',
      value: r.assetName || r.assetIds[0],
      type: 'linked-record',
      resolve: makeRecordResolver('assets', r.assetIds[0], r.assetName || r.assetIds[0]),
    });
  } else if (r.assetName) {
    rvGridFields.push({ label: 'Asset', value: r.assetName });
  }

  Object.entries(r.fields || {})
    .filter(([k, v]) => !RV_SKIP.has(k) && v !== '' && v != null)
    .forEach(([k, v]) => rvGridFields.push({ label: k, value: String(v) }));

  if (r.notes) rvGridFields.push({ label: 'Notes', value: r.notes, span: 'full' });
  renderFieldGrid('rv-fields', rvGridFields);

  loadReviewComments(r.id);
}

async function loadReviewComments(reviewId) {
  $('rv-comments').innerHTML = '<div class="rv-comments-header">Comments</div><div class="list-state" style="font-size:12px;padding:4px 0">Loading…</div>';
  try {
    const comments = await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/comments`);
    renderComments(reviewId, comments);
  } catch (err) {
    $('rv-comments').innerHTML = `<div class="rv-comments-header">Comments</div><div class="list-state error" style="font-size:12px">${esc(err.message)}</div>`;
  }
}

function renderComments(reviewId, comments) {
  const listHtml = comments.length
    ? comments.map(c => `
        <div class="rv-comment">
          <div class="rv-comment-meta">
            <span class="rv-comment-author">${esc(c.author?.name || c.author?.email || 'Unknown')}</span>
            <span class="rv-comment-time">${new Date(c.createdTime).toLocaleString()}</span>
          </div>
          <div class="rv-comment-text">${esc(c.text)}</div>
        </div>`).join('')
    : '<div class="rv-comment-empty">No comments yet.</div>';

  $('rv-comments').innerHTML = `
    <div class="rv-comments-header">Comments</div>
    <div class="rv-comments-list">${listHtml}</div>
    <div class="rv-comment-compose">
      <textarea class="rv-comment-input" id="rv-comment-input" placeholder="Add a comment… (Ctrl+Enter to post)"></textarea>
      <div class="rv-comment-compose-footer">
        <span class="rv-comment-hint">Ctrl+Enter to post</span>
        <button class="btn btn-primary btn-sm" id="rv-comment-submit">Post comment</button>
      </div>
    </div>`;

  const $input  = $('rv-comment-input');
  const $submit = $('rv-comment-submit');

  async function postComment() {
    const text = $input.value.trim();
    if (!text) return;
    $submit.disabled = true;
    $input.disabled  = true;
    try {
      await apiFetch(`/api/reviews/${encodeURIComponent(reviewId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      await loadReviewComments(reviewId);
    } catch (err) {
      showToast(err.message, 'error');
      $submit.disabled = false;
      $input.disabled  = false;
    }
  }

  $submit.addEventListener('click', postComment);
  $input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) postComment();
  });
}

// Close filter dropdowns when clicking outside
document.addEventListener('click', () => {
  const $f = document.getElementById('rv-filters');
  if ($f) $f.querySelectorAll('.mf-dropdown.open').forEach(d => d.classList.remove('open'));
});

document.getElementById('reviews-refresh-btn').addEventListener('click', loadReviews);

// ── Workflow Steps ──

const wfsState = { steps: [], selectedId: null };

async function loadWorkflowSteps() {
  const $list = $('wfs-list');
  $list.innerHTML = '<div class="list-state">Loading…</div>';
  wfsState.selectedId = null;
  _updateWfsButtons();
  try {
    wfsState.steps = await apiFetch('/api/workflow-steps');
    _renderWfsList();
  } catch (err) {
    $list.innerHTML = `<div class="list-state">${esc(err.message)}</div>`;
  }
}

function _renderWfsList() {
  const $list = $('wfs-list');
  if (!wfsState.steps.length) {
    $list.innerHTML = '<div class="list-state">No workflow steps yet. Click + Add to create one.</div>';
    return;
  }

  const steps    = wfsState.steps;
  const stepById = Object.fromEntries(steps.map(s => [s.id, s]));

  // Topological sort (Kahn's) so dependency-first order is established
  const followers = new Map(steps.map(s => [s.id, []]));
  const inDegree  = new Map(steps.map(s => [s.id, 0]));
  for (const s of steps) {
    for (const dep of s.depends_on) {
      if (followers.has(dep.id)) {
        followers.get(dep.id).push(s.id);
        inDegree.set(s.id, inDegree.get(s.id) + 1);
      }
    }
  }
  const queue  = steps.filter(s => inDegree.get(s.id) === 0).map(s => s.id);
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    for (const next of (followers.get(id) || [])) {
      const deg = inDegree.get(next) - 1;
      inDegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }
  // Append any disconnected or cyclic steps at the end
  for (const s of steps) if (!sorted.includes(s.id)) sorted.push(s.id);

  // Group by craft in topo order — craft groups appear in order of their first member
  const craftGroups = new Map();
  for (const id of sorted) {
    const s = stepById[id];
    if (!s) continue;
    const craft = s.craft || '—';
    if (!craftGroups.has(craft)) craftGroups.set(craft, []);
    craftGroups.get(craft).push(s);
  }

  const html = [...craftGroups.entries()].map(([craft, groupSteps]) => {
    const label = craft === '—' ? 'Unassigned' : craft;
    const rows = groupSteps.map(s => {
      const active = wfsState.selectedId === s.id ? ' active' : '';
      const deps = s.depends_on.length
        ? `<div class="wfs-item-deps"><span class="wfs-dep-label">Needs</span>${s.depends_on.map(d => `<span class="wfs-dep-chip">${esc(d.name)}</span>`).join('')}</div>`
        : '';
      return `<div class="wfs-item${active}" data-id="${esc(s.id)}">
        <span class="wfs-item-name">${esc(s.name)}</span>
        ${deps}
      </div>`;
    }).join('');
    return `<div class="wfs-group">
      <div class="wfs-group-header">
        <span class="wfs-group-craft">${esc(label)}</span>
        <span class="wfs-group-count">${groupSteps.length} step${groupSteps.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="wfs-group-steps">${rows}</div>
    </div>`;
  }).join('');

  $list.innerHTML = `<div class="wfs-groups">${html}</div>`;

  $list.querySelectorAll('.wfs-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      wfsState.selectedId = wfsState.selectedId === id ? null : id;
      _renderWfsList();
      _updateWfsButtons();
    });
  });
}

function _updateWfsButtons() {
  const sel = !!wfsState.selectedId;
  $('wfs-edit-btn').disabled   = !sel;
  $('wfs-remove-btn').disabled = !sel;
}

// Add / Edit modal

let _wfsEditMode = null;

function _openWfsModal(mode) {
  _wfsEditMode = mode;
  const step = mode === 'edit' ? wfsState.steps.find(s => s.id === wfsState.selectedId) : null;
  $('wfs-modal-title').textContent = mode === 'add' ? 'Add Workflow Step' : 'Edit Workflow Step';
  $('wfs-name-input').value  = step ? step.name        : '';
  $('wfs-craft-input').value = step ? (step.craft || '') : '';
  const others     = wfsState.steps.filter(s => s.id !== (step ? step.id : null));
  const currentDeps = step ? step.depends_on.map(d => d.id) : [];
  $('wfs-dep-checkboxes').innerHTML = others.length
    ? others.map(s => `<label class="wfs-dep-row"><input type="checkbox" value="${esc(s.id)}"${currentDeps.includes(s.id) ? ' checked' : ''}><span>${esc(s.name)}</span></label>`).join('')
    : '<div class="wfs-dep-empty">No other steps to depend on.</div>';
  $('wfs-edit-overlay').classList.add('open');
  $('wfs-name-input').focus();
}

function _closeWfsModal() {
  $('wfs-edit-overlay').classList.remove('open');
}

$('wfs-add-btn').addEventListener('click', () => _openWfsModal('add'));
$('wfs-edit-btn').addEventListener('click', () => _openWfsModal('edit'));
$('wfs-modal-close').addEventListener('click', _closeWfsModal);
$('wfs-modal-cancel').addEventListener('click', _closeWfsModal);
$('wfs-edit-overlay').addEventListener('click', e => { if (e.target === $('wfs-edit-overlay')) _closeWfsModal(); });

$('wfs-modal-save').addEventListener('click', async () => {
  const name = $('wfs-name-input').value.trim();
  if (!name) { showToast('Name is required', 'error'); return; }
  const craft      = $('wfs-craft-input').value.trim();
  const depends_on = [...$('wfs-dep-checkboxes').querySelectorAll('input:checked')].map(el => el.value);
  const $save = $('wfs-modal-save');
  $save.disabled = true;
  try {
    if (_wfsEditMode === 'add') {
      await apiFetch('/api/workflow-steps', { method: 'POST', body: JSON.stringify({ name, craft, depends_on }) });
      showToast('Step added', 'success');
    } else {
      await apiFetch(`/api/workflow-steps/${wfsState.selectedId}`, { method: 'PATCH', body: JSON.stringify({ name, craft, depends_on }) });
      showToast('Step updated', 'success');
    }
    _closeWfsModal();
    await loadWorkflowSteps();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $save.disabled = false;
  }
});

// Remove confirm modal

function _openWfsRemoveModal() {
  const step = wfsState.steps.find(s => s.id === wfsState.selectedId);
  if (!step) return;
  $('wfs-remove-msg').textContent = `Remove "${step.name}"? This cannot be undone.`;
  $('wfs-remove-overlay').classList.add('open');
}

function _closeWfsRemoveModal() {
  $('wfs-remove-overlay').classList.remove('open');
}

$('wfs-remove-btn').addEventListener('click', _openWfsRemoveModal);
$('wfs-remove-close').addEventListener('click', _closeWfsRemoveModal);
$('wfs-remove-cancel').addEventListener('click', _closeWfsRemoveModal);
$('wfs-remove-overlay').addEventListener('click', e => { if (e.target === $('wfs-remove-overlay')) _closeWfsRemoveModal(); });

$('wfs-remove-confirm').addEventListener('click', async () => {
  if (!wfsState.selectedId) return;
  const $btn = $('wfs-remove-confirm');
  $btn.disabled = true;
  try {
    await apiFetch(`/api/workflow-steps/${wfsState.selectedId}`, { method: 'DELETE' });
    showToast('Step removed', 'success');
    _closeWfsRemoveModal();
    wfsState.selectedId = null;
    await loadWorkflowSteps();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $btn.disabled = false;
  }
});

// CSV download

$('wfs-csv-btn').addEventListener('click', async () => {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) { navigate('login'); return; }
    const res = await fetch('/api/workflow-steps/csv', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    });
    if (!res.ok) throw new Error('Download failed');
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'workflow_steps.csv';
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// -- Init --
